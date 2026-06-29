// ══════════════════════════════════════════════════════════
// P2H MAKKURAGA GRUP — SERVICE WORKER
// File ini WAJIB berada di folder yang sama dengan index.html
// Tugasnya: kirim data P2H ke Google Sheets secara otomatis
// bahkan saat app ditutup / HP di-lock, begitu dapat jaringan.
// ══════════════════════════════════════════════════════════

const SW_VERSION    = 'p2h-sw-v1';
const DB_NAME       = 'P2HDB';
const DB_VER        = 3;
const SYNC_TAG      = 'p2h-sync';
const GAS_URL       = 'https://script.google.com/macros/s/AKfycbx70Llx6n_hNXXX-peHEmkmx_DaimLB-AU0kmcMX7URQlDjvwJPzdVzbRhPDNjWW5Q/exec';
const RETRY_DELAYS  = [60000, 300000, 900000, 3600000]; // 1m, 5m, 15m, 1jam

// ── Install & Activate ──────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SW] Install:', SW_VERSION);
  self.skipWaiting(); // langsung aktif tanpa tunggu tab lama ditutup
});

self.addEventListener('activate', e => {
  console.log('[SW] Activate:', SW_VERSION);
  e.waitUntil(self.clients.claim()); // ambil kontrol semua tab yang terbuka
});

// Fetch handler minimal — pass-through semua request
// (tidak melakukan caching, cukup biarkan request jalan normal)
self.addEventListener('fetch', () => {});

// ── Background Sync ─────────────────────────────────────
// Browser memanggil event ini saat koneksi tersedia,
// bahkan kalau app sudah ditutup.
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    console.log('[SW] Background sync dipanggil browser');
    e.waitUntil(doSync());
  }
});

// ── Fungsi Sync Utama ────────────────────────────────────
async function doSync() {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    console.error('[SW] Gagal buka IndexedDB:', e.message);
    return;
  }

  const records = await dbGetAll(db, 'records');
  const todo    = records.filter(shouldRetry);

  if (todo.length === 0) {
    console.log('[SW] Tidak ada data pending, sync selesai');
    return;
  }

  console.log('[SW] Ada', todo.length, 'data yang perlu disync');

  for (const rec of todo) {
    await syncOne(db, rec);
  }

  // Setelah semua selesai, beritahu tab yang terbuka untuk update UI
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'SYNC_DONE' }));
}

async function syncOne(db, rec) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 20000); // timeout 20 detik

    const res = await fetch(GAS_URL, {
      method:   'POST',
      body:     JSON.stringify({ action: 'submitP2H', data: buildPayload(rec) }),
      headers:  { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal:   ctrl.signal
    });
    clearTimeout(tid);

    let json;
    try   { json = await res.json(); }
    catch { json = { status: 'error', message: 'Response bukan JSON' }; }

    if (json.status === 'ok') {
      // Berhasil — tandai synced
      await dbUpdate(db, 'records', rec.localId, {
        status:      'synced',
        syncedAt:    new Date().toISOString(),
        errorMsg:    '',
        retryCount:  0,
        nextRetryAt: null
      });
      console.log('[SW] Sync OK:', rec.localId, rec['ID Unit']);

      // Kirim notifikasi ke tab yang terbuka
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.postMessage({
        type:    'SYNC_SUCCESS',
        localId: rec.localId,
        unit:    rec['ID Unit'] || ''
      }));

    } else {
      // GAS balas error
      const count   = (rec.retryCount || 0) + 1;
      const delayMs = RETRY_DELAYS[Math.min(count - 1, RETRY_DELAYS.length - 1)];
      await dbUpdate(db, 'records', rec.localId, {
        status:      'error',
        errorMsg:    json.message || 'GAS error',
        retryCount:  count,
        nextRetryAt: Date.now() + delayMs
      });
      console.warn('[SW] GAS error:', rec.localId, json.message);
    }

  } catch (e) {
    const count   = (rec.retryCount || 0) + 1;
    const delayMs = RETRY_DELAYS[Math.min(count - 1, RETRY_DELAYS.length - 1)];
    const msg     = e.name === 'AbortError' ? 'Timeout (>20 detik)' : e.message;

    await dbUpdate(db, 'records', rec.localId, {
      status:      'error',
      errorMsg:    msg,
      retryCount:  count,
      nextRetryAt: Date.now() + delayMs
    });
    console.warn('[SW] Exception sync:', rec.localId, msg);

    // Kalau network error (bukan timeout), lempar supaya browser reschedule sync
    if (e.name !== 'AbortError') throw e;
  }
}

// ── Helpers: shouldRetry ─────────────────────────────────
function shouldRetry(rec) {
  if (rec.status === 'pending') return true;
  if (rec.status === 'error') {
    const count = rec.retryCount || 0;
    if (count >= RETRY_DELAYS.length) return false;
    return Date.now() >= (rec.nextRetryAt || 0);
  }
  return false;
}

// ── Helpers: buildPayload ────────────────────────────────
function buildPayload(rec) {
  const META = {
    dt:  { namaField: 'Nama Lengkap Driver',   hmLabel: 'KM',  sheetName: 'Form P2H' },
    exa: { namaField: 'Nama Lengkap Operator', hmLabel: 'HM ', sheetName: 'Form P2H EXA' },
    gdv: { namaField: 'Nama Lengkap Operator', hmLabel: 'HM ', sheetName: 'Form P2H Grader, Dozer, Vibro' },
    lv:  { namaField: 'Nama Lengkap Driver',   hmLabel: 'KM',  sheetName: 'Form P2H LV' },
  };
  const m   = META[rec.unitType] || META.dt;
  const row = {
    sheetName:              rec.sheetName || m.sheetName,
    'Tanggal P2H':          rec.tanggalInput || rec.tanggal,
    'Jam Pengisian P2H':    rec.jam,
    [m.namaField]:          rec[m.namaField],
    'ID Unit':              rec['ID Unit'],
    [m.hmLabel]:            rec[m.hmLabel] || '',
    'Keterangan Pengecekan': rec['Keterangan Pengecekan'],
    'Tindakan':             rec['Tindakan'],
    'Jam Selesai P2H':      rec['Jam Selesai P2H'],
  };
  Object.assign(row, rec.checklist || {});
  return row;
}

// ── Helpers: IndexedDB ───────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('records')) {
        const s = d.createObjectStore('records', { keyPath: 'localId', autoIncrement: true });
        s.createIndex('status',   'status');
        s.createIndex('unitType', 'unitType');
        s.createIndex('tanggal',  'tanggal');
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
  });
}

function dbGetAll(db, store) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbUpdate(db, store, key, updates) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const obj = tx.objectStore(store);
    const get = obj.get(key);
    get.onsuccess = () => {
      if (!get.result) { res(); return; }
      const put = obj.put({ ...get.result, ...updates });
      put.onsuccess = () => res();
      put.onerror   = () => rej(put.error);
    };
    get.onerror = () => rej(get.error);
  });
}
