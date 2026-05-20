/* =============================================================
   gnoke-kernel.js — v2.0.0
   Gnoke Firmware — Capability Authority Kernel
   Edmund Sparrow © 2026 — MIT

   WHAT THIS IS:
   ─────────────────────────────────────────────────────────────
   The kernel module that lives inside gnoke-worker.js (the
   SharedWorker). It owns all capability authority so that the
   bus file (gnoke-worker.js) can remain a pure message relay.

   Separation of concerns:
     gnoke-worker.js  — process registry, heartbeat, relay
     gnoke-kernel.js  — capability registry, syscall routing

   COMMANDS HANDLED (imported into the worker's _handle switch):
   ─────────────────────────────────────────────────────────────
     CLAIM_CAPABILITY    { capability }
       Grants exclusive ownership of a named capability to the
       calling port. First-port-wins. Only one owner at a time.
       Ownership is bound to the MessagePort, not the PID.

     RELEASE_CAPABILITY  { capability }
       Releases ownership. No-op if caller doesn't own it.

     SYSCALL             { capability, syscall, args, _callId }
       Kernel-routed call. The kernel resolves the owning port
       internally and proxies the message. The caller never
       learns the provider's PID.

   INTERNAL:
   ─────────────────────────────────────────────────────────────
     GnokeKernel.flush(pid)
       Called by the bus when a process dies. Releases all
       capability leases held by that PID and flushes its
       hardware locks via GnokeHAL.
   ============================================================= */

'use strict';

const GnokeKernel = (() => {

  /* ── Capability Registry ──────────────────────────────────
     Map<capabilityName, { port: MessagePort, pid: string }>
     Authority is bound to the port object, not the PID string.
     PID is stored for diagnostics only.                      */
  const _caps = new Map();


  /* ══════════════════════════════════════════════════════════
     handle(port, pid, msg)
     ──────────────────────────────────────────────────────────
     Entry point. Called by the worker's _handle() switch for
     kernel-routed commands. Returns true if the command was
     consumed, false if the worker should handle it itself.
  ══════════════════════════════════════════════════════════ */
  function handle(port, pid, msg) {
    const { _id, cmd } = msg || {};

    switch (cmd) {

      case 'CLAIM_CAPABILITY':
        _claim(port, pid, msg._id, msg.capability);
        return true;

      case 'RELEASE_CAPABILITY':
        _release(port, pid, msg._id, msg.capability);
        return true;

      case 'SYSCALL':
        _syscall(port, pid, msg);
        return true;

      default:
        return false;
    }
  }


  /* ══════════════════════════════════════════════════════════
     flush(pid)
     ──────────────────────────────────────────────────────────
     Called by the bus whenever a process is dropped (death,
     reap, unregister). Clears all capability leases and
     hardware locks held by that PID.
  ══════════════════════════════════════════════════════════ */
  function flush(pid) {
    for (const [cap, owner] of _caps) {
      if (owner.pid === pid) {
        _caps.delete(cap);
        // No log spam inside the worker — callers can observe CAPABILITY_LOST
      }
    }

    // Flush hardware locks if HAL is co-loaded in the worker scope
    if (typeof GnokeHAL !== 'undefined') {
      GnokeHAL.flush(pid);
    }
  }


  /* ══════════════════════════════════════════════════════════
     CLAIM_CAPABILITY
  ══════════════════════════════════════════════════════════ */
  function _claim(port, pid, _id, capability) {
    if (!capability) {
      return _reply(port, _id, null, 'capability name required');
    }

    const existing = _caps.get(capability);

    if (existing) {
      // Same port re-claiming — idempotent
      if (existing.port === port) {
        return _reply(port, _id, { ok: true, status: 'already_owned' });
      }
      // Different port already owns it
      return _reply(port, _id, null, `capability '${capability}' is owned by ${existing.pid}`);
    }

    _caps.set(capability, { port, pid });
    _reply(port, _id, { ok: true, capability, pid });
  }


  /* ══════════════════════════════════════════════════════════
     RELEASE_CAPABILITY
  ══════════════════════════════════════════════════════════ */
  function _release(port, pid, _id, capability) {
    if (!capability) {
      return _reply(port, _id, null, 'capability name required');
    }

    const existing = _caps.get(capability);

    if (!existing || existing.port !== port) {
      // Not the owner — no-op, not an error
      return _reply(port, _id, { ok: true, status: 'not_owner' });
    }

    _caps.delete(capability);
    _reply(port, _id, { ok: true, capability });
  }


  /* ══════════════════════════════════════════════════════════
     SYSCALL — kernel-proxied capability call
     ──────────────────────────────────────────────────────────
     The caller never learns the provider's identity.
     The reply is routed back through the kernel.
  ══════════════════════════════════════════════════════════ */
  function _syscall(callerPort, callerPid, msg) {
    const { _id, capability, syscall, args = {}, _callId } = msg;

    if (!capability || !syscall) {
      return _reply(callerPort, _id, null, 'capability and syscall are required');
    }

    const owner = _caps.get(capability);

    if (!owner) {
      return _reply(callerPort, _id, null, `no process owns capability '${capability}'`);
    }

    // Ack the routing to the caller immediately
    _reply(callerPort, _id, { ok: true, routed: true });

    // Proxy the syscall to the provider — caller identity is passed
    // so the provider can reply, but the caller never learns the provider's PID.
    try {
      owner.port.postMessage({
        event:      'MESSAGE',
        from:       callerPid,
        type:       'SYSCALL',
        data: {
          syscall,
          args,
          _callId,
          _replyTo: callerPid   // provider sends SYSCALL_REPLY back to this PID
        }
      });
    } catch {
      // Provider port is dead — evict it
      flush(owner.pid);
      _reply(callerPort, _id, null, `provider for '${capability}' is unreachable`);
    }
  }


  /* ══════════════════════════════════════════════════════════
     Internal
  ══════════════════════════════════════════════════════════ */
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


  /* ══════════════════════════════════════════════════════════
     Export
  ══════════════════════════════════════════════════════════ */
  return Object.freeze({ handle, flush });

})();
