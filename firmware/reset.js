/* =============================================================
   reset.js — v2.0.0
   Gnoke Firmware — Factory Reset
   Edmund Sparrow © 2026 — MIT

   WHAT THIS DOES:
   ─────────────────────────────────────────────────────────────
   Wipes all persisted Gnoke state from this browser origin.
   Every database. Every session marker. Every ghost.

   After reset the runtime is as if it was never installed.
   The user must re-mount their workspace on next shell boot.

   USAGE:
   ─────────────────────────────────────────────────────────────
     import { GnokeReset } from './reset.js';

     // Full wipe — returns a Promise that resolves when done.
     // The caller decides whether to reload.
     await GnokeReset.nuke();
     location.reload();   // ← only if you want to restart now

   WHY NO AUTO-RELOAD:
   ─────────────────────────────────────────────────────────────
   A reset is a deliberate act. The caller should control what
   happens after — confirm to the user, show a message, redirect
   somewhere specific, or simply resolve the promise silently
   in a test. Reloading automatically is a footgun.
   ============================================================= */

export const GnokeReset = {

  /**
   * Full factory reset.
   *
   * Deletes all Gnoke IndexedDB databases and clears session
   * storage. Returns a Promise. The caller decides what happens
   * next — this function does not reload the page.
   *
   * @returns {Promise<{ wiped: string[], failed: string[] }>}
   */
  async nuke() {
    const databases = [
      'GnokeFirmware',   // kernel topology & ghost registry
      'gnoke:spirit',    // UI & form resurrection state
      'ShadowStorage',   // native FS handles (gnoke-savenative)
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

    // Clear all session PIDs and session markers
    sessionStorage.clear();
    wiped.push('sessionStorage');

    return { wiped, failed };
  },


  /**
   * Delete a single IndexedDB database.
   * Resolves even if blocked — logs a warning and moves on.
   *
   * @param   {string}  name
   * @returns {Promise<void>}
   */
  _deleteDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);

      req.onsuccess  = () => resolve();
      req.onerror    = () => reject(req.error);
      req.onblocked  = () => {
        // Another tab has the DB open. The delete is queued — it will
        // complete once those tabs close. We do not block on it.
        console.warn(`[reset] "${name}" is open in another tab — will be wiped when those tabs close.`);
        resolve();
      };
    });
  },

};
