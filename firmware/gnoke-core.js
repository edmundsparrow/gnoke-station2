
const Gnoke = (() => {
    let _initialized = false;
    const _assert = () => {
        if (!window.GnokeClient) {
            console.error("%c[GnokeCore] Missing client.js link!", "color:red");
            throw new Error("GnokeCore requires client.js to be loaded first.");
        }
    };
    return {
        async ready(config = {}) {
            _assert();
            const session = await GnokeClient.boot({
                name: config.name || document.title,
                meta: {
                    appId:        config.name || document.title,
                    role:         config.role         || 'guest_app',
                    version:      config.version      || '1.1.0',
                    capabilities: config.capabilities || [],
                    maxInstances: config.maxInstances !== undefined
                                    ? config.maxInstances : 1,
                    url:          window.location.pathname + window.location.search,
                    icon:         config.icon || null,
                }
            });
            if (window.GnokeSyscall) {
                GnokeSyscall.init();
            }
            _initialized = true;
            console.log(`%c[Gnoke] App "${config.name}" synchronized.`, "color: #4caf50; font-weight: bold;");
            return session;
        },
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
        async saveFile(name, content) {
            _assert();
            if (window.GnokeSyscall?.fs) {
                return await GnokeSyscall.fs.write(name, content);
            }
            return await GnokeClient.send('filesystem', 'FS_WRITE', { name, content });
        },
        syncState(key, data) {
            window.postMessage({
                type: 'GNOKE_SPIRIT_SAVE',
                pid: window.GnokeClient?.pid,
                payload: { id: key, val: data }
            }, '*');
        }
    };
})();
window.Gnoke = Gnoke;

