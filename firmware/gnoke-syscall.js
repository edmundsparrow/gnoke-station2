
'use strict';
const GnokeSyscall = (() => {
  const TIMEOUT_MS = 8_000;
  let   _seq       = 0;
  const _pending   = new Map();
  let   _inited    = false;
  function init() {
    if (_inited) return;
    _inited = true;
    GnokeClient.on('SYSCALL_REPLY', _onReply);
  }
  async function call(capability, syscall, args = {}) {
    _assertInited();
    const _callId = `sc_${Date.now().toString(36)}_${++_seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pending.delete(_callId);
        reject(new Error(`[gnoke-syscall] Timeout: ${syscall} (${capability})`));
      }, TIMEOUT_MS);
      _pending.set(_callId, { resolve, reject, timer });
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
  function _onReply(data) {
    const { _callId, result, error } = data || {};
    const p = _pending.get(_callId);
    if (!p) return;
    clearTimeout(p.timer);
    _pending.delete(_callId);
    error ? p.reject(new Error(error)) : p.resolve(result);
  }
  const fs = {
    write:  (name, content) => call('filesystem', 'FS_WRITE',  { name, content }),
    read:   (name)          => call('filesystem', 'FS_READ',   { name }),
    delete: (name)          => call('filesystem', 'FS_DELETE', { name }),
    list:   ()              => call('filesystem', 'FS_LIST',   {}),
  };
  function _assertInited() {
    if (!_inited) throw new Error('[gnoke-syscall] Call GnokeSyscall.init() after GnokeClient.boot().');
  }
  return Object.freeze({ init, call, fs });
})();
if (typeof window !== 'undefined') window.GnokeSyscall = GnokeSyscall;

