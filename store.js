/* Almacenamiento local de Mi Atlas (IndexedDB) con la misma interfaz que usaba la versión de claude.ai:
   window.claude.use('db' | 'assets' | 'user'). Todo queda dentro del celular. */
(() => {
  'use strict';
  const DB_NAME = 'mi-atlas', VER = 1;
  let idb = null, ready = null;
  const cache = {};            // { colección: { id: datos } }
  const listeners = {};        // { colección: [fn] }
  const blobUrls = {};         // { idFoto: objectURL }

  const req = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const tx = (store, mode) => idb.transaction(store, mode).objectStore(store);
  const clone = o => JSON.parse(JSON.stringify(o ?? {}));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function open(){
    return new Promise((ok, ko) => {
      const r = indexedDB.open(DB_NAME, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs');
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
    });
  }

  async function putDoc(col, id, data){ await req(tx('docs', 'readwrite').put(data, col + '/' + id)); (cache[col] ||= {})[id] = data; }
  async function delDoc(col, id){ await req(tx('docs', 'readwrite').delete(col + '/' + id)); if (cache[col]) delete cache[col][id]; }
  function emit(col){
    const snap = { docs: Object.entries(cache[col] || {}).map(([id, d]) => ({ id, data: () => clone(d) })) };
    (listeners[col] || []).forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }

  async function init(){
    idb = await open();
    try { navigator.storage?.persist?.(); } catch {}
    const seeded = await req(tx('kv', 'readonly').get('seeded'));
    if (!seeded && window.__SEED) {
      for (const [col, docs] of Object.entries(window.__SEED)) for (const [id, d] of Object.entries(docs || {})) await req(tx('docs', 'readwrite').put(d, col + '/' + id));
      await req(tx('kv', 'readwrite').put(new Date().toISOString(), 'seeded'));
    }
    const keys = await req(tx('docs', 'readonly').getAllKeys());
    const vals = await req(tx('docs', 'readonly').getAll());
    keys.forEach((k, i) => { const j = k.indexOf('/'); (cache[k.slice(0, j)] ||= {})[k.slice(j + 1)] = vals[i]; });
    const bk = await req(tx('blobs', 'readonly').getAllKeys());
    const bv = await req(tx('blobs', 'readonly').getAll());
    bk.forEach((k, i) => { blobUrls[k] = URL.createObjectURL(bv[i]); });
  }

  const db = {
    collection(col){
      return {
        doc(id){
          return {
            async set(data){ await putDoc(col, id, clone(data)); emit(col); },
            async update(data){ await putDoc(col, id, { ...(cache[col]?.[id] || {}), ...clone(data) }); emit(col); },
            async delete(){ await delDoc(col, id); emit(col); },
            async get(){ const d = cache[col]?.[id]; return { id, exists: !!d, data: () => clone(d) }; },
          };
        },
        async add(data){ const id = newId(); await putDoc(col, id, clone(data)); emit(col); return { id }; },
        onSnapshot(fn){ (listeners[col] ||= []).push(fn); setTimeout(() => emit(col), 0); return () => { listeners[col] = listeners[col].filter(f => f !== fn); }; },
      };
    },
  };

  const assets = {
    async upload(blob){ const id = newId(); await req(tx('blobs', 'readwrite').put(blob, id)); blobUrls[id] = URL.createObjectURL(blob); return { id }; },
    async delete(id){ await req(tx('blobs', 'readwrite').delete(id)); if (blobUrls[id]) { URL.revokeObjectURL(blobUrls[id]); delete blobUrls[id]; } },
  };
  const user = { can: () => true };

  window.__blobUrl = id => blobUrls[id] || '';
  window.claude = { use(name){
    ready ||= init();
    return ready.then(() => {
      if (name === 'db') return db;
      if (name === 'assets') return assets;
      if (name === 'user') return user;
      throw new Error('No disponible: ' + name);
    });
  } };

  /* ---------- Copia de seguridad ---------- */
  const toDataUrl = b => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
  async function exportBackup(){
    await (ready ||= init());
    const blobs = {};
    const bk = await req(tx('blobs', 'readonly').getAllKeys());
    for (const k of bk) blobs[k] = await toDataUrl(await req(tx('blobs', 'readonly').get(k)));
    const data = { app: 'mi-atlas', version: 1, exportedAt: new Date().toISOString(), docs: cache, blobs };
    const file = new File([JSON.stringify(data)], `mi-atlas-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Copia de Mi Atlas' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  }
  async function importBackup(file){
    const data = JSON.parse(await file.text());
    if (data?.app !== 'mi-atlas' || !data.docs) throw new Error('Archivo no válido');
    await (ready ||= init());
    await req(tx('docs', 'readwrite').clear()); await req(tx('blobs', 'readwrite').clear());
    for (const [col, docs] of Object.entries(data.docs)) for (const [id, d] of Object.entries(docs || {})) await req(tx('docs', 'readwrite').put(d, col + '/' + id));
    for (const [id, url] of Object.entries(data.blobs || {})) await req(tx('blobs', 'readwrite').put(await (await fetch(url)).blob(), id));
    location.reload();
  }
  window.__backupHtml = () => `<div class="section"><h3>Copia de seguridad <i>Backup</i></h3>
    <p class="muted" style="font-size:13px">Tus viajes y fotos se guardan solo en este dispositivo. Guarda una copia de vez en cuando (en Archivos, iCloud o WhatsApp) para no perderlos.</p>
    <div class="row-btns"><button class="btn sec small" data-bk="export">Guardar copia</button><button class="btn sec small" data-bk="import">Restaurar copia</button><input type="file" accept="application/json,.json" data-bk="file" hidden></div></div>`;
  window.__bindBackup = root => {
    const f = root.querySelector('[data-bk="file"]'); if (!f) return;
    root.querySelector('[data-bk="export"]').onclick = () => exportBackup().catch(() => alert('No se pudo crear la copia.'));
    root.querySelector('[data-bk="import"]').onclick = () => f.click();
    f.onchange = () => { const file = f.files[0]; if (!file) return;
      if (!confirm('Esto reemplaza todo lo que hay en la app por el contenido de la copia. ¿Continuar?')) { f.value = ''; return; }
      importBackup(file).catch(() => { alert('Ese archivo no es una copia válida de Mi Atlas.'); f.value = ''; }); };
  };

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
