
'use strict';
importScripts('policy.js');
importScripts('gnoke-kernel.js');
importScripts('gnoke-hal.js');
const _registry = new Map();
const _ghosts = new Map();
const _portMap = new WeakMap();
const STALE_MS = 65_000;
/* Session token — regenerated every SharedWorker boot.
   Clients must echo this on REGISTER; mismatch = stale session. */
const _sessionToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
setInterval(_reap, 10_000);
function _getDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('GnokeFirmware', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kernel')) {
        db.createObjectStore('kernel');
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config');
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
const _bootPromise = _hydrate();
self.onconnect = async function (e) {
  await _bootPromise;
  const port = e.ports[0];
  port.onmessage = evt => _handle(port, evt.data);
  port.start();
  /* Immediately push the session token so the client can validate on REGISTER */
  port.postMessage({ event: 'SESSION_TOKEN', token: _sessionToken });
};
async function _handle(port, msg) {
  const { _id, cmd } = msg || {};
  if (!cmd) return;
  const _pid  = _portMap.get(port);
  const _meta = (_pid && _registry.get(_pid)?.meta) ?? {};
  if (GnokeKernel.handle(port, _pid, _meta, msg)) return;
  switch (cmd) {
    case 'REGISTER': {
      const { pid, meta = {}, token } = msg;
      if (!pid) {
        return _reply(port, _id, null, 'pid required');
      }
      /* Reject stale sessions from a previous worker boot */
      if (token !== _sessionToken) {
        return _reply(port, _id, null, 'SESSION_MISMATCH');
      }

      /* ── Singleton / reconnect logic ────────────────────────────────
         If meta.appId is set and maxInstances === 1 (the default), check
         whether this appId is already registered under a DIFFERENT pid.
         Two cases:
           A) Same pid re-registering (browser restore, visibility wake) →
              plain reconnect, no new process.
           B) Different pid, same appId, maxInstances 1 →
              stale ghost; evict the old pid and let this one take the slot.
              The launcher already used window.open(url, 'gnoke-<id>') so
              there is only one tab — the old pid is genuinely orphaned.
      ──────────────────────────────────────────────────────────────── */
      const appId       = meta.appId || null;
      const maxInst     = (meta.maxInstances === undefined) ? 1 : meta.maxInstances;
      let   _isNew      = !_registry.has(pid);

      if (appId && maxInst === 1 && _isNew) {
        /* Scan registry for an existing entry with this appId */
        for (const [existingPid, proc] of _registry) {
          if (proc.meta?.appId === appId && existingPid !== pid) {
            /* Evict the stale/ghost entry silently — same app, different pid */
            _registry.delete(existingPid);
            GnokeKernel.flush(existingPid);
            _broadcast({ event: 'PROCESS_DIED', pid: existingPid });
            break;
          }
        }
        /* Also clear from ghosts */
        for (const [ghostPid, ghost] of _ghosts) {
          if (ghost.meta?.appId === appId) {
            _ghosts.delete(ghostPid);
            break;
          }
        }
      }

      _registry.set(pid, { port, meta, ts: Date.now() });
      _ghosts.delete(pid);
      _portMap.set(port, pid);
      _reply(port, _id, { ok: true, pid });
      if (_isNew) {
        /* Genuinely new process — announce birth and ask peers to re-announce */
        _broadcast({ event: 'PROCESS_BORN', pid, meta });
        _broadcastRegistry();
        for (const [rpid, proc] of _registry) {
          if (rpid !== pid) {
            try { proc.port.postMessage({ event: 'PEER_JOINED', pid }); } catch {}
          }
        }
      } else {
        /* Reconnection — just refresh the registry so launcher dots update */
        _broadcastRegistry();
      }
      _checkpoint();
      break;
    }
    case 'PING': {
      const proc = _registry.get(msg.pid);
      if (proc) proc.ts = Date.now();
      _reply(port, _id, { ok: true });
      break;
    }
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
    case 'BROADCAST': {
      const { event, data, from } = msg;
      _broadcast({ event: 'MESSAGE', from, type: event, data });
      _reply(port, _id, { ok: true });
      break;
    }
    case 'LIST': {
      _reply(port, _id, {
        processes: _snapshot(),
        ghosts:    _ghostSnapshot()
      });
      break;
    }
    case 'UNREGISTER': {
      _drop(msg.pid);
      _reply(port, _id, { ok: true });
      break;
    }
    default:
      _reply(port, _id, null, `Unknown command: ${cmd}`);
  }
}
function _drop(pid) {
  if (!_registry.has(pid)) return;
  _registry.delete(pid);
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

