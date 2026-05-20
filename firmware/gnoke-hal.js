/* =============================================================
   gnoke-hal.js — Hardware Abstraction & Coordination Layer
   Part of the Gnoke Frozen Firmware — v1.0.0
   Edmund Sparrow © 2026 — MIT
   ─────────────────────────────────────────────────────────────
   PURPOSE: 
   Acts as the "Registry of Occupation." It manages hardware 
   leases (locks) to prevent multiple tabs from crashing 
   exclusive browser ports (Serial, USB, Bluetooth).
   ============================================================= */

const GnokeHAL = {
    // Stores which PID owns which hardware: Map('serial_com1' => 'lite_x2y3z')
    _locks: new Map(),

    /**
     * Entry point for Kernel/Bus to route hardware syscalls
     */
    handle(pid, msg) {
        const { call, deviceId } = msg;

        switch (call) {
            case 'HAL_LOCK':
                return this.acquire(pid, deviceId);
            case 'HAL_RELEASE':
                return this.release(pid, deviceId);
            case 'HAL_STATUS':
                return { 
                    busy: this._locks.has(deviceId), 
                    owner: this._locks.get(deviceId) 
                };
            default:
                return { ok: false, error: "Unknown HAL call" };
        }
    },

    /**
     * Claims a device for a specific process
     */
    acquire(pid, deviceId) {
        if (this._locks.has(deviceId)) {
            const owner = this._locks.get(deviceId);
            if (owner === pid) return { ok: true, status: 'already_owned' };
            return { ok: false, error: `Device occupied by ${owner}` };
        }

        this._locks.set(deviceId, pid);
        console.log(`%c[HAL] 🔒 ${deviceId} locked by ${pid}`, 'color: #ff9800');
        return { ok: true };
    },

    /**
     * Releases a device so others can use it
     */
    release(pid, deviceId) {
        if (this._locks.get(deviceId) === pid) {
            this._locks.delete(deviceId);
            console.log(`%c[HAL] 🔓 ${deviceId} released by ${pid}`, 'color: #4caf50');
            return { ok: true };
        }
        return { ok: false, error: "Not the current owner" };
    },

    /**
     * Emergency Cleanup: Called when a tab/process dies.
     * Ensures hardware isn't trapped in a dead PID's lock.
     */
    flush(pid) {
        for (let [device, owner] of this._locks.entries()) {
            if (owner === pid) {
                this._locks.delete(device);
                console.warn(`[HAL] 🛠 Emergency Unlock: ${device} (Owner ${pid} disconnected)`);
            }
        }
    }
};

// Export for use in Kernel/Worker
if (typeof module !== 'undefined') module.exports = GnokeHAL;


