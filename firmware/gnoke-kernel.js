
'use strict';
const GnokeKernel = (() => {
  const _caps = new Map();
  function handle(port, pid, meta, msg) {
    const { _id, cmd } = msg || {};
    switch (cmd) {
      case 'CLAIM_CAPABILITY':
        _claim(port, pid, meta, msg._id, msg.capability);
        return true;
      case 'RELEASE_CAPABILITY':
        _release(port, pid, msg._id, msg.capability);
        return true;
      case 'SYSCALL':
        _syscall(port, pid, meta, msg);
        return true;
      default:
        return false;
    }
  }
  function flush(pid) {
    for (const [cap, owner] of _caps) {
      if (owner.pid === pid) {
        _caps.delete(cap);
      }
    }
    if (typeof GnokeHAL !== 'undefined') {
      GnokeHAL.flush(pid);
    }
  }
  function _claim(port, pid, meta, _id, capability) {
    if (!capability) {
      return _reply(port, _id, null, 'capability name required');
    }
    const role = GnokePolicy.getRoleFromMeta(meta);
    if (!GnokePolicy.canClaim(role, capability)) {
      return _reply(port, _id, null, `Access denied: role '${role}' cannot claim '${capability}'`);
    }
    const existing = _caps.get(capability);
    if (existing) {
      if (existing.port === port) {
        return _reply(port, _id, { ok: true, status: 'already_owned' });
      }
      /* Force-evict if existing owner's port is dead */
      try {
        existing.port.postMessage({ event: 'PING_CHECK' });
      } catch {
        /* Port is closed — evict and let new claimant take it */
        _caps.delete(capability);
        _caps.set(capability, { port, pid });
        return _reply(port, _id, { ok: true, capability, pid, status: 'evicted' });
      }
      return _reply(port, _id, null, `capability '${capability}' is owned by ${existing.pid}`);
    }
    _caps.set(capability, { port, pid });
    _reply(port, _id, { ok: true, capability, pid });
  }
  function _release(port, pid, _id, capability) {
    if (!capability) {
      return _reply(port, _id, null, 'capability name required');
    }
    const existing = _caps.get(capability);
    if (!existing || existing.port !== port) {
      return _reply(port, _id, { ok: true, status: 'not_owner' });
    }
    _caps.delete(capability);
    _reply(port, _id, { ok: true, capability });
  }
  function _syscall(callerPort, callerPid, callerMeta, msg) {
    const { _id, capability, syscall, args = {}, _callId } = msg;
    if (!capability || !syscall) {
      return _reply(callerPort, _id, null, 'capability and syscall are required');
    }
    const role = GnokePolicy.getRoleFromMeta(callerMeta);
    if (!GnokePolicy.canCall(role, capability, syscall)) {
      return _reply(callerPort, _id, null, `Access denied: role '${role}' cannot call '${syscall}'`);
    }
    const owner = _caps.get(capability);
    if (!owner) {
      return _reply(callerPort, _id, null, `no process owns capability '${capability}'`);
    }
    _reply(callerPort, _id, { ok: true, routed: true });
    try {
      owner.port.postMessage({
        event:      'MESSAGE',
        from:       callerPid,
        type:       'SYSCALL',
        data: {
          syscall,
          args,
          _callId,
          _replyTo: callerPid
        }
      });
    } catch {
      flush(owner.pid);
      _reply(callerPort, _id, null, `provider for '${capability}' is unreachable`);
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
  return Object.freeze({ handle, flush });
})();

