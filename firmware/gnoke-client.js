
'use strict';
const GnokeClient = (() => {
  const WORKER_PATH = '/firmware/gnoke-worker.js';
  const HEARTBEAT_MS = 20_000;
  let _port       = null;
  let _pid        = null;
  let _booted     = false;
  let _bootP      = null;
  let _hbTimer    = null;
  let _seq = 0;
  const _pending  = new Map();
  const _handlers = new Map();
  const _born     = new Set();
  const _died     = new Set();
  const _reg      = new Set();
  /* ── Firmware IDB — config store ────────────────────────────────────
     Replaces localStorage for PID persistence. GnokeFirmware/config is
     the same DB the SharedWorker uses for topology checkpoints. PIDs
     stored here survive browser restarts without using localStorage.
  ──────────────────────────────────────────────────────────────────── */
  const _fwDB = (() => {
    let _db = null;
    function _open() {
      if (_db) return Promise.resolve(_db);
      return new Promise((res, rej) => {
        const req = indexedDB.open('GnokeFirmware', 2);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kernel')) db.createObjectStore('kernel');
          if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
        };
        req.onsuccess = e => { _db = e.target.result; res(_db); };
        req.onerror   = e => rej(e.target.error);
      });
    }
    return {
      async get(key) {
        const db = await _open();
        return new Promise((res, rej) => {
          const r = db.transaction('config','readonly').objectStore('config').get(key);
          r.onsuccess = () => res(r.result ?? null);
          r.onerror   = () => rej(r.error);
        });
      },
      async set(key, val) {
        const db = await _open();
        return new Promise((res, rej) => {
          const r = db.transaction('config','readwrite').objectStore('config').put(val, key);
          r.onsuccess = () => res();
          r.onerror   = () => rej(r.error);
        });
      },
      async remove(key) {
        const db = await _open();
        return new Promise((res, rej) => {
          const r = db.transaction('config','readwrite').objectStore('config').delete(key);
          r.onsuccess = () => res();
          r.onerror   = () => rej(r.error);
        });
      },
    };
  })();

  async function _resolvePID(name) {
    const key = `pid:${name}`;
    let pid = await _fwDB.get(key);
    if (!pid) {
      const slug = (name || 'proc').toLowerCase().replace(/\W+/g, '-');
      pid = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      await _fwDB.set(key, pid);
    }
    return pid;
  }
  let _meta        = {};
  let _sessionToken = null;   /* set by SESSION_TOKEN event from worker on connect */
  function boot({ name = 'app', meta = {} } = {}) {
    if (_bootP) return _bootP;
    _meta = { name, ...meta };
    _bootP = (async () => {
      if (!('SharedWorker' in window)) {
        console.warn('[gnoke-client] SharedWorker not supported — firmware bus unavailable.');
        _booted = true;
        return;
      }
      _pid = await _resolvePID(name);
      const worker = new SharedWorker(WORKER_PATH);
      _port = worker.port;
      _port.onmessage = _onMessage;
      _port.start();
      /* Wait for the worker to push its session token before registering.
         This ensures we never register with a stale token from a previous boot. */
      _sessionToken = await new Promise(resolve => {
        const handler = ev => {
          if (ev.data?.event === 'SESSION_TOKEN') {
            _port.removeEventListener('message', handler);
            resolve(ev.data.token);
          }
        };
        _port.addEventListener('message', handler);
      });
      const regResult = await _send({ cmd: 'REGISTER', pid: _pid, meta: _meta, token: _sessionToken });
      if (regResult?.error === 'SESSION_MISMATCH') {
        /* Stale PID from a previous worker session — clear it and generate a fresh one */
        await _fwDB.remove(`pid:${_meta.name || 'app'}`);
        _pid = await _resolvePID(name);
        await _send({ cmd: 'REGISTER', pid: _pid, meta: _meta, token: _sessionToken });
      }
      _startHeartbeat();
      _watchVisibility();
      _booted = true;
    })();
    return _bootP;
  }
  function _startHeartbeat() {
    clearInterval(_hbTimer);
    _hbTimer = setInterval(() => {
      _send({ cmd: 'PING', pid: _pid }).catch(() => {});
    }, HEARTBEAT_MS);
  }
  function _watchVisibility() {
    document.addEventListener('visibilitychange', async () => {
      if (!_pid || !_port) return;
      if (document.visibilityState === 'hidden') {
        /* Stamp a fresh ping before the browser throttles our interval */
        _send({ cmd: 'PING', pid: _pid }).catch(() => {});
        return;
      }
      await _send({ cmd: 'REGISTER', pid: _pid, meta: _meta }).catch(() => {});
      _startHeartbeat();
    });
  }
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
  async function listAll() {
    _assert();
    const result = await _send({ cmd: 'LIST' });
    return { processes: result.processes || {}, ghosts: result.ghosts || {} };
  }
  async function claimCapability(capability) {
    _assert();
    return _send({ cmd: 'CLAIM_CAPABILITY', capability });
  }
  async function releaseCapability(capability) {
    _assert();
    return _send({ cmd: 'RELEASE_CAPABILITY', capability });
  }
  function _sendKernel(msg) {
    _assert();
    return _send(msg);
  }
  function on(event, fn) {
    if (!_handlers.has(event)) _handlers.set(event, new Set());
    _handlers.get(event).add(fn);
    return () => _handlers.get(event)?.delete(fn);
  }
  function onProcessBorn(fn) { _born.add(fn); return () => _born.delete(fn); }
  function onProcessDied(fn) { _died.add(fn); return () => _died.delete(fn); }
  function onRegistry(fn)    { _reg.add(fn);  return () => _reg.delete(fn);  }
  function _onMessage(evt) {
    const msg = evt.data;
    if (!msg) return;
    if (msg._id) {
      const p = _pending.get(msg._id);
      if (!p) return;
      _pending.delete(msg._id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      return;
    }
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
      case 'PEER_JOINED':
        /* A new process joined — re-announce ourselves so it sees us in the registry */
        if (_pid && _port && _meta) {
          _send({ cmd: 'REGISTER', pid: _pid, meta: _meta }).catch(() => {});
        }
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
  return Object.freeze({
    boot,
    send,
    broadcast,
    list,
    listAll,
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