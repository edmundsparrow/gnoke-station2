(() => {
  const DB_NAME = 'gnoke:spirit';
  const STORE   = 'processes';
  const VERSION = 1;
  const SENSITIVE = new Set(['password', 'token', 'cc', 'cvv', 'ssn', 'secret']);

  // ── In-memory mirror — instant reads mid-session, IDB is the checkpoint ──
  let _mem = {};

  // ── Cached connection — one DB open for the lifetime of the page ──
  let _db = null;
  const getDB = () => {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      r.onsuccess = e => { _db = e.target.result; res(_db); };
      r.onerror   = e => rej(e.target.error);
    });
  };

  const tx  = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
  const dbGet  = (db, key)      => new Promise((res, rej) => { const r = tx(db,'readonly').get(key);         r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); });
  const dbPut  = (db, val, key) => new Promise((res, rej) => { const r = tx(db,'readwrite').put(val, key);   r.onsuccess = () => res();              r.onerror = e => rej(e.target.error); });
  const dbDel  = (db, key)      => new Promise((res, rej) => { const r = tx(db,'readwrite').delete(key);     r.onsuccess = () => res();              r.onerror = e => rej(e.target.error); });
  const dbKeys = (db)           => new Promise((res, rej) => { const r = tx(db,'readonly').getAllKeys();      r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); });

  // ── Schema migration ──
  const migrate = (state) => {
    if (!state) return null;
    // v1 → current: nothing to change yet, but structure is here for future
    if (state.v !== VERSION) {
      state.v = VERSION;
    }
    return state;
  };

  const isSensitive = f =>
    f.type === 'password' ||
    SENSITIVE.has(f.type) ||
    [...SENSITIVE].some(s => (f.name || f.id || '').toLowerCase().includes(s));

  const sel = el =>
    el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : el.tagName.toLowerCase();

  const capture = (root) => {
    const r = root || document;
    return {
      v: VERSION,
      ts: Date.now(),
      url: location.href,
      scroll: { x: scrollX, y: scrollY },
      focus: document.activeElement ? sel(document.activeElement) : null,
      forms: [...(r.tagName === 'FORM' ? [r] : r.querySelectorAll('form'))].map(f => ({
        sel: sel(f),
        fields: [...f.querySelectorAll('input,textarea,select')]
          .filter(el => !isSensitive(el) && (el.name || el.id))
          .map(el => ({ sel: sel(el), val: el.value }))
      })).filter(f => f.fields.length)
    };
  };

  const save = async (pid, formEl) => {
    _mem[pid] = capture(formEl);
    await dbPut(await getDB(), _mem[pid], pid);
  };

  const restore = async (db, pid, root) => {
    const raw   = await dbGet(db, pid);
    const state = migrate(raw);
    if (!state || state.url !== location.href) return;

    scrollTo(state.scroll.x, state.scroll.y);

    const r = root || document;
    state.forms.forEach(({ sel: fSel, fields }) => {
      const form = r.tagName === 'FORM' ? r : r.querySelector(fSel);
      if (!form) return;
      fields.forEach(({ sel: eSel, val }) => {
        const el = form.querySelector(eSel);
        if (el) el.value = val;
      });
    });

    if (state.focus) document.querySelector(state.focus)?.focus();
  };

  window.gnokeSpirit = {
    async wake(pid, formEl) {
      pid = pid || location.pathname;
      const db = await getDB();
      await restore(db, pid, formEl);

      let t;
      const target = formEl || window;
      target.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => save(pid, formEl), 300);
      });

      window.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden')
          await save(pid, formEl);
      });

      return pid;
    },

    async kill(pid) {
      pid = pid || location.pathname;
      await dbDel(await getDB(), pid);
    },

    async list() {
      return dbKeys(await getDB());
    }
  };
})();