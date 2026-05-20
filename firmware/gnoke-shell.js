/* =============================================================
   gnoke-shell.js — v2.0.0
   Gnoke Firmware — Privileged Shell Process
   Edmund Sparrow © 2026 — MIT

   WHAT THIS IS:
   ─────────────────────────────────────────────────────────────
   The shell is the first tab. It is the only tab with elevated
   kernel capabilities. It owns the workspace FileSystem handle,
   manages the process dock UI, and services filesystem syscalls
   on behalf of all other tabs.

   Think of it as PID 1 in a Unix system — if it dies, the
   filesystem capability is lost until it is relaunched and
   mount() or wake() is called again.

   CAPABILITIES DECLARED:
   ─────────────────────────────────────────────────────────────
   - filesystem   → services FS_WRITE, FS_READ, FS_DELETE
   - dock         → renders the live process registry

   USAGE:
   ─────────────────────────────────────────────────────────────
     // In your shell HTML — boot once, user gesture mounts FS
     await GnokeShell.boot();

     // Prompt user to pick workspace folder (requires gesture)
     await GnokeShell.mount();

     // On reload — silently restore handle + flush shelf
     await GnokeShell.wake();

   SYSCALL SURFACE (handled automatically — no app code needed):
   ─────────────────────────────────────────────────────────────
     FS_WRITE   { name, content }   → writes file to workspace
     FS_READ    { name }            → returns file text content
     FS_DELETE  { name }            → deletes file from workspace
     FS_LIST    {}                  → returns array of filenames
   ============================================================= */

'use strict';

const GnokeShell = (() => {

  const SHELL_NAME  = 'gnoke-shell';
  const SHELL_CAPS  = ['filesystem', 'dock'];

  let _workspace = null;   // { handle, db } from savenative.wake()

  /* ══════════════════════════════════════════════════════════
     boot()
     ──────────────────────────────────────────────────────────
     Initialises the client stub as the shell process, declares
     capabilities, and wires up the syscall dispatcher.
     Call once on page load before any user interaction.
  ══════════════════════════════════════════════════════════ */
  async function boot() {
    await GnokeClient.boot({
      name: SHELL_NAME,
      meta: { role: SHELL_NAME, capabilities: SHELL_CAPS }
    });

    // Claim kernel-enforced capability leases (first-port-wins)
    for (const cap of SHELL_CAPS) {
      await GnokeClient.claimCapability(cap);
    }

    // Listen for syscalls routed to this process
    GnokeClient.on('SYSCALL', _dispatch);

    // Maintain the live dock
    GnokeClient.onRegistry(_renderDock);
    GnokeClient.onProcessBorn(_onBorn);
    GnokeClient.onProcessDied(_onDied);

    // Seed the dock with current state
    const procs = await GnokeClient.list();
    _renderDock(procs);

    console.info('[gnoke-shell] Shell process online. PID:', GnokeClient.pid);
  }


  /* ══════════════════════════════════════════════════════════
     mount()
     ──────────────────────────────────────────────────────────
     Opens the directory picker. Must be called from a user
     gesture (button click). Persists handle to IndexedDB.
  ══════════════════════════════════════════════════════════ */
  async function mount() {
    _assertBooted();
    const handle = await saveNative.mount(_openDB);
    _workspace = { handle, db: await saveNative._db(_openDB) };
    console.info('[gnoke-shell] Workspace mounted:', handle.name);
    return handle;
  }


  /* ══════════════════════════════════════════════════════════
     wake()
     ──────────────────────────────────────────────────────────
     Restores workspace handle from IndexedDB after a reload.
     Flushes any shelved writes automatically.
     Call this on DOMContentLoaded if the user has mounted before.
  ══════════════════════════════════════════════════════════ */
  async function wake() {
    _assertBooted();
    try {
      _workspace = await saveNative.wake(_openDB);
      console.info('[gnoke-shell] Workspace restored.');
    } catch (err) {
      console.warn('[gnoke-shell] Wake failed — workspace not mounted yet.', err.message);
    }
  }


  /* ══════════════════════════════════════════════════════════
     Syscall Dispatcher
     ──────────────────────────────────────────────────────────
     Receives SYSCALL messages routed by the bus. Executes the
     requested kernel operation and replies to the caller.
  ══════════════════════════════════════════════════════════ */
  async function _dispatch(data, from) {
    const { syscall, args = {}, _callId, _replyTo } = data || {};
    // _replyTo is set by the kernel proxy; fall back to direct `from` for
    // any legacy callers that still send SYSCALL directly (e.g. during tests).
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

    // Reply to caller if they passed a _callId
    if (_callId && replyTarget) {
      GnokeClient.send(replyTarget, 'SYSCALL_REPLY', { _callId, result, error });
    }
  }


  /* ══════════════════════════════════════════════════════════
     Dock Renderer
     ──────────────────────────────────────────────────────────
     Updates #gnoke-dock if present in the shell HTML.
     Each entry shows PID, name, and capability badges.
  ══════════════════════════════════════════════════════════ */
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


  /* ══════════════════════════════════════════════════════════
     Internal
  ══════════════════════════════════════════════════════════ */
  function _assertBooted() {
    if (!GnokeClient.ready) throw new Error('[gnoke-shell] Call boot() first.');
  }

  // Thin openDB shim compatible with savenative's signature
  function _openDB(name, version, { upgrade } = {}) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      if (upgrade) req.onupgradeneeded = e => upgrade(e.target.result);
      req.onsuccess = e => {
        const db = e.target.result;
        // Wrap raw IDB db with the idb-style promise API savenative expects
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


  /* ══════════════════════════════════════════════════════════
     Export
  ══════════════════════════════════════════════════════════ */
  return Object.freeze({ boot, mount, wake });

})();

if (typeof window !== 'undefined') window.GnokeShell = GnokeShell;
