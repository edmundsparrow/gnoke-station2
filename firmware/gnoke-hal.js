
const GnokeHAL = {
    _locks: new Map(),
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
    release(pid, deviceId) {
        if (this._locks.get(deviceId) === pid) {
            this._locks.delete(deviceId);
            console.log(`%c[HAL] 🔓 ${deviceId} released by ${pid}`, 'color: #4caf50');
            return { ok: true };
        }
        return { ok: false, error: "Not the current owner" };
    },
    flush(pid) {
        for (let [device, owner] of this._locks.entries()) {
            if (owner === pid) {
                this._locks.delete(device);
                console.warn(`[HAL] 🛠 Emergency Unlock: ${device} (Owner ${pid} disconnected)`);
            }
        }
    }
};
if (typeof module !== 'undefined') module.exports = GnokeHAL;

