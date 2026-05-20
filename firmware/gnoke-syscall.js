/* =============================================================
   gnoke-syscall.js — v2.0.0
   Gnoke Firmware — Syscall Abstraction Layer
   Edmund Sparrow © 2026 — MIT

   WHAT THIS IS:
   ─────────────────────────────────────────────────────────────
   The syscall layer sits between app tabs and the kernel.
   App tabs never address providers directly. They issue a named
   syscall which the kernel routes to whichever process has
   claimed the matching capability.

   This mirrors the real OS model: apps make syscalls,
   the kernel decides which driver handles them.

   WHAT CHANGED FROM v1:
   ─────────────────────────────────────────────────────────────
   v1 resolved capabilities client-side via LIST() scan, then
   sent directly to the provider's PID. That created:
     - capability spoofing risk
     - PID impersonation risk
     - cooperative-only trust

   v2 sends SYSCALL to the worker kernel. The kernel resolves
   and proxies internally. The app tab never learns the
   provider's PID.

   HOW IT WORKS:
   ─────────────────────────────────────────────────────────────
   1. GnokeSyscall.call() sends a SYSCALL command to the kernel
      with a unique _callId.
   2. The kernel routes it to the capability owner.
   3. The provider replies directly to the caller via
      SYSCALL_REPLY (routed through the bus SEND).
   4. The promise resolves with the result or rejects on error/
      timeout.

   USAGE:
   ─────────────────────────────────────────────────────────────
     // Boot the client first
     await GnokeClient.boot({ name: 'my-app' });
     GnokeSyscall.init();

     // Write a file — routed to whoever owns 'filesystem'
     await GnokeSyscall.call('filesystem', 'FS_WRITE', {
       name: 'notes.txt',
       content: 'Hello, Gnoke.'
     });

     // Read a file
     const { content } = await GnokeSyscall.call('filesystem', 'FS_READ', {
       name: 'notes.txt'
     });

     // List workspace files
     const { files } = await GnokeSyscall.call('filesystem', 'FS_LIST', {});

     // Delete a file
     await GnokeSyscall.call('filesystem', 'FS_DELETE', { name: 'notes.txt' });

   ADDING NEW CAPABILITIES:
   ─────────────────────────────────────────────────────────────
   Any tab can declare capabilities by claiming them after boot
   and handling SYSCALL messages. No hardcoded PIDs anywhere.

     await GnokeClient.boot({ name: 'printer-svc' });
     await GnokeClient.claimCapability('printer');   // kernel-enforced claim

     GnokeClient.on('SYSCALL', async ({ syscall, args, _callId, _replyTo }) => {
       // handle PRINT_JOB etc.
       GnokeClient.send(_replyTo, 'SYSCALL_REPLY', { _callId, result, error });
     });
   ============================================================= */

'use strict';

const GnokeSyscall = (() => {

  const TIMEOUT_MS = 8_000;
  let   _seq       = 0;
  const _pending   = new Map();   // _callId → { resolve, reject, timer }
  let   _inited    = false;


  /* ══════════════════════════════════════════════════════════
     init()
     ──────────────────────────────────────────────────────────
     Wires the SYSCALL_REPLY listener onto GnokeClient.
     Call once after GnokeClient.boot() resolves.
  ══════════════════════════════════════════════════════════ */
  function init() {
    if (_inited) return;
    _inited = true;
    GnokeClient.on('SYSCALL_REPLY', _onReply);
  }


  /* ══════════════════════════════════════════════════════════
     call(capability, syscall, args)
     ──────────────────────────────────────────────────────────
     Routes a syscall through the kernel to the process that
     owns the given capability. Returns a Promise that resolves
     with the result payload or rejects with an error string.

     The caller never learns the provider's PID — the kernel
     resolves and proxies internally.

     capability  string   e.g. 'filesystem', 'printer'
     syscall     string   e.g. 'FS_WRITE', 'PRINT_JOB'
     args        object   syscall-specific arguments
  ══════════════════════════════════════════════════════════ */
  async function call(capability, syscall, args = {}) {
    _assertInited();

    const _callId = `sc_${Date.now().toString(36)}_${++_seq}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pending.delete(_callId);
        reject(new Error(`[gnoke-syscall] Timeout: ${syscall} (${capability})`));
      }, TIMEOUT_MS);

      _pending.set(_callId, { resolve, reject, timer });

      // Send SYSCALL to the kernel — no PID resolution here
      GnokeClient._sendKernel({
        cmd:        'SYSCALL',
        capability,
        syscall,
        args,
        _callId
      }).catch(err => {
        clearTimeout(timer);
        _pending.delete(_callId);
        reject(err);
      });
    });
  }


  /* ══════════════════════════════════════════════════════════
     _onReply(data)
     ──────────────────────────────────────────────────────────
     Handles SYSCALL_REPLY messages routed back to this tab
     by the capability provider.
  ══════════════════════════════════════════════════════════ */
  function _onReply(data) {
    const { _callId, result, error } = data || {};
    const p = _pending.get(_callId);
    if (!p) return;

    clearTimeout(p.timer);
    _pending.delete(_callId);

    error ? p.reject(new Error(error)) : p.resolve(result);
  }


  /* ══════════════════════════════════════════════════════════
     Convenience shorthands — filesystem syscalls
  ══════════════════════════════════════════════════════════ */
  const fs = {
    write:  (name, content) => call('filesystem', 'FS_WRITE',  { name, content }),
    read:   (name)          => call('filesystem', 'FS_READ',   { name }),
    delete: (name)          => call('filesystem', 'FS_DELETE', { name }),
    list:   ()              => call('filesystem', 'FS_LIST',   {}),
  };


  /* ══════════════════════════════════════════════════════════
     Internal
  ══════════════════════════════════════════════════════════ */
  function _assertInited() {
    if (!_inited) throw new Error('[gnoke-syscall] Call GnokeSyscall.init() after GnokeClient.boot().');
  }


  /* ══════════════════════════════════════════════════════════
     Export
  ══════════════════════════════════════════════════════════ */
  return Object.freeze({ init, call, fs });

})();

if (typeof window !== 'undefined') window.GnokeSyscall = GnokeSyscall;
