
export const GnokeReset = {
  async nuke() {
    const databases = [
      'GnokeFirmware',
      'gnoke:spirit',
      'ShadowStorage',
      'GnokeStore',
    ];
    const wiped  = [];
    const failed = [];
    for (const name of databases) {
      try {
        await this._deleteDB(name);
        wiped.push(name);
      } catch (err) {
        console.warn(`[reset] Could not wipe "${name}":`, err.message);
        failed.push(name);
      }
    }
    /* Clear sessionStorage (legacy — PIDs/UID now in IDB but belt-and-suspenders) */
    sessionStorage.clear();
    wiped.push('sessionStorage');
    /* Clear localStorage (belt-and-suspenders for any legacy keys) */
    try { localStorage.clear(); wiped.push('localStorage'); } catch {}
    return { wiped, failed };
  },
  _deleteDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess  = () => resolve();
      req.onerror    = () => reject(req.error);
      req.onblocked  = () => {
        console.warn(`[reset] "${name}" is open in another tab — will be wiped when those tabs close.`);
        resolve();
      };
    });
  },
};

