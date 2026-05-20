/* =============================================================
   gnoke-client.js — v2.0.0
   Gnoke Firmware — Tab Process Stub
   Edmund Sparrow © 2026 — MIT

   WHAT THIS IS:
   ─────────────────────────────────────────────────────────────
   Runs inside each tab. Connects the tab to the firmware bus
   (gnoke-worker.js), registers it as a named process with a
   PID, and handles resurrection — re-registering automatically
   when the tab wakes from suspension.

   WHAT IT DOES:
   ─────────────────────────────────────────────────────────────
   1. Generates or restores a stable PID for this tab.
      PIDs survive tab reload via sessionStorage.
      PIDs are unique per tab instance.

   2. Registers with the bus on connect.
      Re-registers silently on resurrection (visibilitychange).

   3. Sends a heartbeat every 30s so the bus knows this
      process is still alive.

   4. Routes incoming bus messages to registered listeners.

   5. Exposes a clean API for app code — send, broadcast,
      listen, list processes.

   USAGE:
   ─────────────────────────────────────────────────────────────
     // Boot (call once, before anything else)
     await GnokeClient.boot({ name: 'dashboard', meta: { role: 'operator' } });

     // Send to a specific process
     GnokeClient.send('pid-of-other-tab', 'ORDER_UPDATED', { id: 123 });

     // Broadcast to all processes
     GnokeClient.broadcast('USER_SIGNED_OUT', {});

     // Listen for messages from the bus
     GnokeClient.on('ORDER_UPDATED', (data, from) => { ... });

     // Listen for process lifecycle events
     GnokeClient.onProcessBorn((pid, meta) => { ... });
     GnokeClient.onProcessDied((pid) => { ... });
     GnokeClient.onRegistry((processes) => { ... });

     // Get current registry snapshot
     const procs = await GnokeClient.list();

     // Current PID of this tab
     GnokeClient.pid
   ============================================================= */

'use strict';

const GnokeClient = (() => {

  const WORKER_PATH = '/gnoke-worker.js';
  const HEARTBEAT_MS = 30_000;

  let _port       = null;
  let _pid        = null;
  let _booted     = false;
  let _bootP      = null;
  let _hbTimer    = null;

  let _seq = 0;
  const _pending  = new Map();   // _id → { resolve, reject }
  const _handlers = new Map();   // event → Set<fn>
  const _born     = new Set();
  const _died     = new Set();
  const _reg      = new Set();

  /* ── PID management ────────────────────────────────────────
     Stable per tab-session. Survives reload. Dies with tab.  */
  function _resolvePID(name) {
    const key = 'gnoke:pid';
    let pid = sessionStorage.getItem(key);
    if (!pid) {
      const slug = (name || 'proc').toLowerCase().replace(/\W+/g, '-');
      pid = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      sessionStorage.setItem(key, pid);
    }
    return pid;
  }

  /* ── boot() ────────────────────────────────────────────────
     Call once per tab. Idempotent.                           */
  function boot({ name = 'app', meta = {} } = {}) {
    if (_bootP) return _bootP;

    _bootP = (async () => {
      if (!('SharedWorker' in window)) {
        console.warn('[gnoke-client] SharedWorker not supported — firmware bus unavailable.');
        _booted = true;
        return;
      }

      _pid = _resolvePID(name);

      const worker = new SharedWorker(WORKER_PATH);
      _port = worker.port;
      _port.onmessage = _onMessage;
      _port.start();

      await _send({ cmd: 'REGISTER', pid: _pid, meta: { name, ...meta } });

      _startHeartbeat();
      _watchVisibility();

      _booted = true;
    })();

    return _bootP;
  }

  /* ── Heartbeat ──────────────────────────────────────────── */
  function _startHeartbeat() {
    clearInterval(_hbTimer);
    _hbTimer = setInterval(() => {
      _send({ cmd: 'PING', pid: _pid }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  /* ── Resurrection ───────────────────────────────────────────
     When tab comes back from suspension, re-register with bus.
     The bus may have reaped this PID during silence.          */
  function _watchVisibility() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (!_pid || !_port) return;
      // Re-register — bus drops duplicates gracefully
      await _send({ cmd: 'REGISTER', pid: _pid, meta: {} }).catch(() => {});
      _startHeartbeat();
    });
  }

  /* ── Public API ─────────────────────────────────────────── */

  async function send(to, event, data) {
    _assert();
    return _send({ cmd: 'SEND', from: _pid, to, event, data });
  }

  async function broadcast(event, data) {
    _assert();
    return _send({ cmd: 'BROADCAST', from: _pid, event, data });
  }

  async function list() {
    _assert();
    const result = await _send({ cmd: 'LIST' });
    return result.processes;
  }

  /* ── claimCapability() ──────────────────────────────────────
     Requests exclusive ownership of a named capability from
     the kernel. First-port-wins. Authority is bound to this
     tab's MessagePort, not its PID string.                   */
  async function claimCapability(capability) {
    _assert();
    return _send({ cmd: 'CLAIM_CAPABILITY', capability });
  }

  /* ── releaseCapability() ────────────────────────────────────
     Releases ownership of a named capability.               */
  async function releaseCapability(capability) {
    _assert();
    return _send({ cmd: 'RELEASE_CAPABILITY', capability });
  }

  /* ── _sendKernel() ──────────────────────────────────────────
     Internal path used by GnokeSyscall to send kernel-routed
     commands (SYSCALL) without a named recipient PID.
     Not part of the public app API.                          */
  function _sendKernel(msg) {
    _assert();
    return _send(msg);
  }

  /* ── Event listeners ────────────────────────────────────── */

  // Listen for messages sent to this tab
  function on(event, fn) {
    if (!_handlers.has(event)) _handlers.set(event, new Set());
    _handlers.get(event).add(fn);
    return () => _handlers.get(event)?.delete(fn);
  }

  function onProcessBorn(fn) { _born.add(fn); return () => _born.delete(fn); }
  function onProcessDied(fn) { _died.add(fn); return () => _died.delete(fn); }
  function onRegistry(fn)    { _reg.add(fn);  return () => _reg.delete(fn);  }

  /* ── Internal message handling ──────────────────────────── */

  function _onMessage(evt) {
    const msg = evt.data;
    if (!msg) return;

    // Response to a sent command
    if (msg._id) {
      const p = _pending.get(msg._id);
      if (!p) return;
      _pending.delete(msg._id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      return;
    }

    // Broadcast from bus
    switch (msg.event) {
      case 'MESSAGE': {
        const fns = _handlers.get(msg.type);
        if (fns) fns.forEach(fn => { try { fn(msg.data, msg.from); } catch {} });
        break;
      }
      case 'PROCESS_BORN':
        _born.forEach(fn => { try { fn(msg.pid, msg.meta); } catch {} });
        break;
      case 'PROCESS_DIED':
        _died.forEach(fn => { try { fn(msg.pid); } catch {} });
        break;
      case 'REGISTRY':
        _reg.forEach(fn => { try { fn(msg.processes); } catch {} });
        break;
    }
  }

  function _send(msg) {
    return new Promise((resolve, reject) => {
      const _id = `gc_${Date.now().toString(36)}_${++_seq}`;
      _pending.set(_id, { resolve, reject });
      try {
        _port.postMessage({ ...msg, _id });
      } catch (err) {
        _pending.delete(_id);
        reject(err);
      }
    });
  }

  function _assert() {
    if (!_booted) throw new Error('[gnoke-client] Call boot() first.');
  }

  /* ── Export ─────────────────────────────────────────────── */
  return Object.freeze({
    boot,
    send,
    broadcast,
    list,
    claimCapability,
    releaseCapability,
    _sendKernel,
    on,
    onProcessBorn,
    onProcessDied,
    onRegistry,
    get pid() { return _pid; },
    get ready() { return _booted; },
  });

})();

if (typeof window !== 'undefined') window.GnokeClient = GnokeClient;

