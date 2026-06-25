
'use strict';
const GnokePolicy = (() => {
  const ROLES = {
    OPERATOR:  'operator',
    SYSTEM:    'system',
    GUEST_APP: 'guest_app',
  };
  const CAPABILITY_WHITELIST = {
    [ROLES.OPERATOR]: [
      'filesystem',
      'dock',
      'hal',
      'network',
    ],
    [ROLES.SYSTEM]: [
      'ui_sync',
      'notifications',
      'background',
    ],
    [ROLES.GUEST_APP]: [
    ],
  };
  const SYSCALL_BLACKLIST = {
    [ROLES.GUEST_APP]: new Set([
      'FS_DELETE',
      'FS_FORMAT',
      'HAL_LOCK',
      'NET_PROXY',
    ]),
    [ROLES.SYSTEM]: new Set([
      'HAL_LOCK',
    ]),
    [ROLES.OPERATOR]: new Set([]),
  };
  function canClaim(role, capability) {
    const normalizedRole = _normalizeRole(role);
    const allowed = CAPABILITY_WHITELIST[normalizedRole] || [];
    const isAllowed = allowed.includes(capability);
    if (!isAllowed) {
      console.warn(
        `[policy] Blocked ${normalizedRole} from claiming '${capability}'`
      );
    }
    return isAllowed;
  }
  function canCall(fromRole, capability, syscall) {
    const normalizedRole = _normalizeRole(fromRole);
    const blacklist = SYSCALL_BLACKLIST[normalizedRole] || new Set();
    const isBlocked = blacklist.has(syscall);
    if (isBlocked) {
      console.warn(
        `[policy] Blocked ${normalizedRole} from calling ${syscall} on '${capability}'`
      );
    }
    return !isBlocked;
  }
  function getRoleFromMeta(meta) {
    if (!meta || !meta.role) {
      return ROLES.GUEST_APP;
    }
    return _normalizeRole(meta.role);
  }
  function _normalizeRole(role) {
    if (!role) return ROLES.GUEST_APP;
    const normalized = role.toLowerCase().replace(/[_-]/g, '_');
    if (normalized === 'shell' || normalized === 'pid1' ||
        normalized === 'gnoke_shell' || normalized === 'gnoke-shell' ||
        normalized === 'launcher') {
      return ROLES.OPERATOR;
    }
    if (normalized === 'guest' || normalized === 'app' || normalized === 'third_party') {
      return ROLES.GUEST_APP;
    }
    if (Object.values(ROLES).includes(normalized)) {
      return normalized;
    }
    console.warn(`[policy] Unknown role '${role}' — defaulting to guest_app`);
    return ROLES.GUEST_APP;
  }
  return Object.freeze({
    ROLES,
    canClaim,
    canCall,
    getRoleFromMeta,
  });
})();
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  self.GnokePolicy = GnokePolicy;
}
if (typeof window !== 'undefined') {
  window.GnokePolicy = GnokePolicy;
}

