
'use strict';
const GnokeShell = (() => {
  const SHELL_NAME  = 'gnoke-shell';
  const SHELL_CAPS  = ['filesystem', 'dock'];
  let _workspace = null;
  async function boot() {
    await GnokeClient.boot({
      name: SHELL_NAME,
      meta: { role: SHELL_NAME, capabilities: SHELL_CAPS }
    });
    for (const cap of SHELL_CAPS) {
      try {
        await GnokeClient.claimCapability(cap);
      } catch (err) {
        console.warn(`[gnoke-shell] Cap claim failed for '${cap}': ${err.message} — continuing`);
      }
    }
    GnokeClient.on('SYSCALL', _dispatch);
    GnokeClient.onRegistry(_renderDock);
    GnokeClient.onProcessBorn(_onBorn);
    GnokeClient.onProcessDied(_onDied);
    const procs = await GnokeClient.list();
    _renderDock(procs);
    console.info('[gnoke-shell] Shell process online. PID:', GnokeClient.pid);
  }
  async function mount() {
    _assertBooted();
    const handle = await saveNative.mount(_openDB);
    _workspace = { handle, db: await saveNative._db(_openDB) };
    console.info('[gnoke-shell] Workspace mounted:', handle.name);
    return handle;
  }
  async function wake() {
    _assertBooted();
    try {
      _workspace = await saveNative.wake(_openDB);
      console.info('[gnoke-shell] Workspace restored.');
    } catch (err) {
      console.warn('[gnoke-shell] Wake failed — workspace not mounted yet.', err.message);
    }
  }
  async function _dispatch(data, from) {
    const { syscall, args = {}, _callId, _replyTo } = data || {};
    const replyTarget = _replyTo || from;
    if (!syscall) return;
    let result = null;
    let error  = null;
    try {
      switch (syscall) {
        case 'FS_WRITE': {
          if (!_workspace) throw new Error('Workspace not mounted.');
          await saveNative.write(_workspace, args.name, args.content);
          result = { ok: true };
          break;
        }
        case 'FS_READ': {
          if (!_workspace) throw new Error('Workspace not mounted.');
          const fileHandle = await _workspace.handle.getFileHandle(args.name);
          const file       = await fileHandle.getFile();
          result = { content: await file.text() };
          break;
        }
        case 'FS_DELETE': {
          if (!_workspace) throw new Error('Workspace not mounted.');
          await _workspace.handle.removeEntry(args.name);
          result = { ok: true };
          break;
        }
        case 'FS_LIST': {
          if (!_workspace) throw new Error('Workspace not mounted.');
          const names = [];
          for await (const [name] of _workspace.handle.entries()) {
            names.push(name);
          }
          result = { files: names };
          break;
        }
        default:
          error = `Unknown syscall: ${syscall}`;
      }
    } catch (err) {
      error = err.message;
    }
    if (_callId && replyTarget) {
      GnokeClient.send(replyTarget, 'SYSCALL_REPLY', { _callId, result, error });
    }
  }
  function _renderDock(processes) {
    const dock = document.getElementById('gnoke-dock');
    if (!dock) return;
    dock.innerHTML = '';
    for (const [pid, { meta }] of Object.entries(processes || {})) {
      const el = document.createElement('div');
      el.className = 'gnoke-dock-entry';
      el.dataset.pid = pid;
      const caps = (meta?.capabilities || [])
        .map(c => `<span class="gnoke-cap">${c}</span>`)
        .join('');
      el.innerHTML = `
        <span class="gnoke-pid">${pid}</span>
        <span class="gnoke-name">${meta?.name || '—'}</span>
        ${caps}
      `;
      dock.appendChild(el);
    }
  }
  function _onBorn(pid, meta) {
    console.info(`[gnoke-dock] Process born: ${pid}`, meta);
  }
  function _onDied(pid) {
    console.info(`[gnoke-dock] Process died: ${pid}`);
  }
  function _assertBooted() {
    if (!GnokeClient.ready) throw new Error('[gnoke-shell] Call boot() first.');
  }
  function _openDB(name, version, { upgrade } = {}) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      if (upgrade) req.onupgradeneeded = e => upgrade(e.target.result);
      req.onsuccess = e => {
        const db = e.target.result;
        resolve(_wrapDB(db));
      };
      req.onerror = e => reject(e.target.error);
    });
  }
  function _wrapDB(db) {
    const tx  = (store, mode) => db.transaction(store, mode).objectStore(store);
    const p   = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      get:    (store, key)       => p(tx(store, 'readonly').get(key)),
      put:    (store, val, key)  => p(tx(store, 'readwrite').put(val, key)),
      add:    (store, val)       => p(tx(store, 'readwrite').add(val)),
      delete: (store, key)       => p(tx(store, 'readwrite').delete(key)),
      getAll: (store)            => p(tx(store, 'readonly').getAll()),
    };
  }
  return Object.freeze({ boot, mount, wake });
})();
if (typeof window !== 'undefined') window.GnokeShell = GnokeShell;

