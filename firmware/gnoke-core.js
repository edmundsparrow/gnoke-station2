/* =============================================================
   gnoke-core.js — The Universal App Bridge
   Version: 1.1.0 "Resilience"
   Edmund Sparrow © 2026 — MIT
   ============================================================= */

const Gnoke = (() => {
    let _initialized = false;

    const _assert = () => {
        if (!window.GnokeClient) {
            console.error("%c[GnokeCore] Missing client.js link!", "color:red");
            throw new Error("GnokeCore requires client.js to be loaded first.");
        }
    };

    return {
        /**
         * System Handshake
         * Now includes automatic Syscall initialization.
         */
        async ready(config = {}) {
            _assert();
            
            // 1. Boot the client
            const session = await GnokeClient.boot({
                name: config.name || document.title,
                meta: {
                    role: 'guest_app',
                    version: config.version || '1.1.0',
                    capabilities: config.capabilities || []
                }
            });

            // 2. Automatically link the Syscall bridge if available
            if (window.GnokeSyscall) {
                GnokeSyscall.init();
            }

            _initialized = true;
            console.log(`%c[Gnoke] App "${config.name}" synchronized.`, "color: #4caf50; font-weight: bold;");
            return session;
        },

        /**
         * Coordinated Hardware Access (HAL)
         */
        async requestHardware(deviceId) {
            _assert();
            if (!_initialized) await this.ready();

            const result = await GnokeClient.send('kernel', 'HAL_LOCK', { deviceId });
            
            if (result && result.ok) {
                return {
                    id: deviceId,
                    release: () => GnokeClient.send('kernel', 'HAL_RELEASE', { deviceId })
                };
            }
            throw new Error(result?.error || "Hardware acquisition failed");
        },

        /**
         * Standardized Filesystem Access
         * Automatically routes to the Syscall layer or direct Kernel.
         */
        async saveFile(name, content) {
            _assert();
            // Preference: Use the high-level Syscall bridge if it exists
            if (window.GnokeSyscall?.fs) {
                return await GnokeSyscall.fs.write(name, content);
            }
            // Fallback: Direct message to whoever owns the filesystem
            return await GnokeClient.send('filesystem', 'FS_WRITE', { name, content });
        },

        /**
         * UI Resurrection (Spirit)
         */
        syncState(key, data) {
            // Non-blocking postMessage to the Spirit listener
            window.postMessage({
                type: 'GNOKE_SPIRIT_SAVE',
                pid: window.GnokeClient?.pid,
                payload: { id: key, val: data }
            }, '*');
        }
    };
})();

window.Gnoke = Gnoke;
