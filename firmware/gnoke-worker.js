/* =============================================================
   gnoke-worker.js — v2.0.0
   Gnoke Firmware — Resumable System Bus
   Edmund Sparrow © 2026 — MIT

   WHAT THIS IS:
   ─────────────────────────────────────────────────────────────
   The SharedWorker entry point. Owns the process registry,
   heartbeat reaper, topology persistence, and message relay.

   Capability authority and syscall routing live in a separate
   file that must be imported alongside this one:

     importScripts('gnoke-kernel.js');   // ← required
     importScripts('gnoke-hal.js');      // ← required for HAL

   Separation of concerns:
     gnoke-worker.js  — process registry, heartbeat, relay
     gnoke-kernel.js  — capability registry, syscall routing

   PHILOSOPHY:
   ─────────────────────────────────────────────────────────────
   Active ports are truth.
   Persisted topology is advisory.

   The worker may die.
   The runtime may resurrect.
   But only live ports are considered running processes.
   ============================================================= */

'use strict';

importScripts('gnoke-kernel.js');
importScripts('gnoke-hal.js');

/* ── Live Runtime Registry ────────────────────────────────────
   Map<pid, { port, meta, ts }>
   Only ACTIVE connected processes live here.                */
const _registry = new Map();

/* ── Ghost Snapshot Cache ────────────────────────────────────
   Restored topology memory.
   Advisory only — never treated as live runtime state.      */
const _ghosts = new Map();

/* ── Reverse Port Lookup ───────────────────────────────────── */
const _portMap = new WeakMap();

/* ── Reaper ────────────────────────────────────────────────── */
const STALE_MS = 35_000;
setInterval(_reap, 10_000);


/* ════════════════════════════════════════════════════════════
   IndexedDB — Topology Persistence
   ════════════════════════════════════════════════════════════ */

function _getDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('GnokeFirmware', 1);

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kernel')) {
        req.result.createObjectStore('kernel');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _checkpoint() {
  try {
    const db    = await _getDB();
    const tx    = db.transaction('kernel', 'readwrite');
    const store = tx.objectStore('kernel');
    const snap  = {};

    for (const [pid, { meta, ts }] of _registry) {
      snap[pid] = { meta, ts };
    }

    store.put(snap, 'topology');
  } catch {}
}

async function _hydrate() {
  try {
    const db    = await _getDB();
    const tx    = db.transaction('kernel', 'readonly');
    const store = tx.objectStore('kernel');

    const snapshot = await new Promise(resolve => {
      const req = store.get('topology');
      req.onsuccess = () => resolve(req.result || {});
      req.onerror   = () => resolve({});
    });

    const now = Date.now();

    for (const [pid, data] of Object.entries(snapshot)) {
      if (now - data.ts < STALE_MS) {
        _ghosts.set(pid, { meta: data.meta, ts: data.ts });
      }
    }
  } catch {}
}

/* ── Boot hydration barrier ────────────────────────────────── */
const _bootPromise = _hydrate();


/* ════════════════════════════════════════════════════════════
   Entry
   ════════════════════════════════════════════════════════════ */

self.onconnect = async function (e) {
  await _bootPromise;

  const port = e.ports[0];
  port.onmessage = evt => _handle(port, evt.data);
  port.start();
};


/* ════════════════════════════════════════════════════════════
   Router
   ════════════════════════════════════════════════════════════ */

async function _handle(port, msg) {
  const { _id, cmd } = msg || {};
  if (!cmd) return;

  // Kernel handles capability and syscall commands first
  if (GnokeKernel.handle(port, _portMap.get(port), msg)) return;

  switch (cmd) {

    /* ── REGISTER ─────────────────────────────────────────── */
    case 'REGISTER': {
      const { pid, meta = {} } = msg;

      if (!pid) {
        return _reply(port, _id, null, 'pid required');
      }

      _registry.set(pid, { port, meta, ts: Date.now() });
      _ghosts.delete(pid);
      _portMap.set(port, pid);

      _reply(port, _id, { ok: true, pid });
      _broadcast({ event: 'PROCESS_BORN', pid, meta });
      _broadcastRegistry();
      _checkpoint();
      break;
    }

    /* ── HEARTBEAT ───────────────────────────────────────── */
    case 'PING': {
      const proc = _registry.get(msg.pid);
      if (proc) proc.ts = Date.now();
      _reply(port, _id, { ok: true });
      break;
    }

    /* ── DIRECT MESSAGE ──────────────────────────────────── */
    case 'SEND': {
      const { to, event, data, from } = msg;
      const target = _registry.get(to);

      if (!target) {
        return _reply(port, _id, null, `PID ${to} unavailable`);
      }

      try {
        target.port.postMessage({ event: 'MESSAGE', from, type: event, data });
        _reply(port, _id, { ok: true });
      } catch {
        _drop(to);
        _reply(port, _id, null, `PID ${to} unreachable`);
      }
      break;
    }

    /* ── BROADCAST ───────────────────────────────────────── */
    case 'BROADCAST': {
      const { event, data, from } = msg;
      _broadcast({ event: 'MESSAGE', from, type: event, data });
      _reply(port, _id, { ok: true });
      break;
    }

    /* ── LIST ────────────────────────────────────────────── */
    case 'LIST': {
      _reply(port, _id, {
        processes: _snapshot(),
        ghosts:    _ghostSnapshot()
      });
      break;
    }

    /* ── UNREGISTER ──────────────────────────────────────── */
    case 'UNREGISTER': {
      _drop(msg.pid);
      _reply(port, _id, { ok: true });
      break;
    }

    default:
      _reply(port, _id, null, `Unknown command: ${cmd}`);
  }
}


/* ════════════════════════════════════════════════════════════
   Internal
   ════════════════════════════════════════════════════════════ */

function _drop(pid) {
  if (!_registry.has(pid)) return;

  _registry.delete(pid);

  // Release all capability leases and hardware locks for this PID
  GnokeKernel.flush(pid);

  _broadcast({ event: 'PROCESS_DIED', pid });
  _broadcastRegistry();
  _checkpoint();
}

function _reap() {
  const now = Date.now();

  for (const [pid, proc] of _registry) {
    if (now - proc.ts > STALE_MS) _drop(pid);
  }

  for (const [pid, ghost] of _ghosts) {
    if (now - ghost.ts > STALE_MS) _ghosts.delete(pid);
  }
}

function _snapshot() {
  const out = {};
  for (const [pid, { meta, ts }] of _registry) {
    out[pid] = { meta, ts };
  }
  return out;
}

function _ghostSnapshot() {
  const out = {};
  for (const [pid, { meta, ts }] of _ghosts) {
    out[pid] = { meta, ts };
  }
  return out;
}

function _broadcastRegistry() {
  _broadcast({ event: 'REGISTRY', processes: _snapshot() });
}

function _broadcast(msg) {
  for (const [pid, proc] of _registry) {
    try {
      proc.port.postMessage(msg);
    } catch {
      _drop(pid);
    }
  }
}

function _reply(port, _id, result, error) {
  if (!_id) return;
  try {
    port.postMessage(
      error
        ? { _id, ok: false, error }
        : { _id, ok: true, result }
    );
  } catch {}
}
