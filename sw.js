// ══════════════════════════════════════════════════════════
// P2H MAKKURAGA GRUP — SERVICE WORKER
// File ini WAJIB berada di folder yang sama dengan index.html
// Tugasnya:
//  1. Cache app shell (index.html, manifest, icon) supaya app
//     bisa DIBUKA tanpa jaringan sama sekali (bukan cuma input
//     offline — sebelumnya fetch handler kosong, jadi tanpa
//     jaringan app-nya nggak bisa muncul sama sekali).
//  2. Kirim data P2H ke Google Sheets secara otomatis via
//     Background Sync, bahkan saat app ditutup / HP di-lock,
//     begitu dapat jaringan.
// ══════════════════════════════════════════════════════════

const SW_VERSION    = 'p2h-sw-v3';
const CACHE_NAME     = 'p2h-shell-v3'; // NAIKKAN versi ini tiap kali app di-update & redeploy,
                                        // supaya SW ambil app shell versi baru (lihat activate di bawah).
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
const DB_NAME       = 'P2HDB';
const DB_VER        = 3;
const SYNC_TAG      = 'p2h-sync';
// PENTING: URL ini HARUS sama persis dengan GAS_URL di index.html.
// Sebelumnya dua-duanya beda deployment ID — akibatnya submit yang
// gagal & di-retry background sync bisa terkirim ke deployment GAS
// yang salah/lama tanpa kelihatan errornya. Kalau kamu ganti
// deployment GAS, update DI DUA TEMPAT (sini dan index.html), lalu
// naikkan SW_VERSION/CACHE_NAME di atas supaya SW lama ke-refresh.
const GAS_URL       = 'https://script.google.com/macros/s/AKfycbxoiDtWyT9pTyOKIkrG6sIgO_qR9ibqY4vzAFQTZVSeNlyoaCfGxvKDL7_qN1WU7f4/exec';
const RETRY_DELAYS  = [60000, 300000, 900000, 3600000]; // 1m, 5m, 15m, 1jam

// ── Install: precache app shell ──────────────────────────
self.addEventListener('install', e => {
  console.log('[SW] Install:', SW_VERSION);
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(err => console.warn('[SW] Precache gagal (lanjut tanpa cache penuh):', err.message))
  );
  self.skipWaiting(); // langsung aktif tanpa tunggu tab lama ditutup
});

// ── Activate: buang cache versi lama ─────────────────────
self.addEventListener('activate', e => {
  console.log('[SW] Activate:', SW_VERSION);
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      ),
      self.clients.claim() // ambil kontrol semua tab yang terbuka
    ])
  );
});

// ── Fetch: cache-first untuk app shell, network-normal untuk sisanya ──
// KHUSUS request GET same-origin (file app-nya sendiri) yang di-intercept.
// Request ke GAS (script.google.com) — POST submitP2H/approveP2H dan GET
// getMasterUnit/dashboard data — SENGAJA TIDAK disentuh sama sekali di
// sini (dibiarkan lolos ke jaringan seperti biasa), supaya data selalu
// fresh dan alur retry di syncOne()/doSync() di bawah tidak terganggu.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST (submit/approve) & lainnya: lewat begitu saja
  if (new URL(req.url).origin !== self.location.origin) return; // request ke GAS/CDN dll: lewat begitu saja

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(res => {
          // Simpan salinan fresh ke cache supaya makin lengkap seiring dipakai
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // Offline & tidak ada di cache: untuk navigasi halaman, fallback
          // ke index.html yang sudah di-precache supaya app tetap kebuka.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Offline & tidak ada cache' });
        });
    })
  );
});

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
    // Kunci idempotency — HARUS sama seperti buildPayload() di index.html,
    // supaya submitP2H (Code.gs) bisa mendeteksi record yang sama walau
    // dikirim dua jalur berbeda (foreground sync vs background sync SW).
    'Client ID':            rec.clientId || '',
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
