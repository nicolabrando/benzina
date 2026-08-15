/* store.js — persistenza a strati.
 *
 * Il problema: Safari (ITP) cancella localStorage, IndexedDB e cache dopo
 * 7 giorni senza interazione col sito. Con rifornimenti ogni ~20 giorni
 * l'app si troverebbe vuota a ogni apertura.
 *
 * L'eccezione decisiva: le web app aggiunte alla schermata Home NON sono
 * soggette al limite (hanno un contatore separato, azzerato dall'uso dell'app).
 * Su Chrome/Android non c'è alcun limite temporale.
 *
 * Difesa a strati, dalla più alla meno importante:
 *   1. installazione sulla schermata Home  → avviso persistente finché manca
 *   2. navigator.storage.persist()         → richiesta esplicita al browser
 *   3. localStorage + IndexedDB in parallelo → se uno sopravvive, si recupera
 *   4. copia di sicurezza del salvataggio precedente
 *   5. export su file                      → l'unica difesa davvero definitiva
 */

(function () {
'use strict';

const KEY = 'benzina.db.v1';
const KEY_BAK = 'benzina.db.v1.bak';
const KEY_META = 'benzina.meta.v1';
const IDB_NAME = 'benzina';
const IDB_STORE = 'kv';

/* ---------- IndexedDB minimale ---------- */

function idbOpen() {
  return new Promise((res, rej) => {
    if (!('indexedDB' in self)) return rej(new Error('no idb'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbGet(k) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(k);
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}
async function idbSet(k, v) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(v, k);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  } catch { return false; }
}

/* ---------- modello ---------- */

function uid() {
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyDb() {
  return {
    schema: 1,
    updatedAt: new Date().toISOString(),
    activeVehicle: null,
    vehicles: [],
    settings: { unit: 'kmL', theme: 'auto', lastExport: null },
  };
}

function newVehicle(name, extra = {}) {
  return {
    id: uid(),
    name: name || 'Veicolo',
    plate: extra.plate || '',
    fuel: extra.fuel || 'Benzina',
    tank: extra.tank ?? null,
    color: extra.color || null,
    entries: [],
  };
}

function newEntry(o = {}) {
  return {
    id: uid(),
    date: o.date || new Date().toISOString().slice(0, 10),
    odo: o.odo ?? null,
    liters: o.liters ?? null,
    amount: o.amount ?? null,
    price: o.price ?? null,
    full: !!o.full,
    notes: o.notes || '',
    station: o.station || '',
    createdAt: o.createdAt || new Date().toISOString(),
  };
}

/* ---------- validazione / migrazione ---------- */

function sanitize(db) {
  if (!db || typeof db !== 'object') return null;
  if (!Array.isArray(db.vehicles)) return null;
  const out = { ...emptyDb(), ...db };
  out.schema = 1;
  out.settings = { ...emptyDb().settings, ...(db.settings || {}) };
  out.vehicles = db.vehicles
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      id: v.id || uid(),
      name: String(v.name || 'Veicolo'),
      plate: String(v.plate || ''),
      fuel: String(v.fuel || 'Benzina'),
      tank: num(v.tank),
      color: v.color || null,
      entries: (Array.isArray(v.entries) ? v.entries : [])
        .filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')))
        .map((e) => ({
          id: e.id || uid(),
          date: e.date,
          odo: num(e.odo),
          liters: num(e.liters),
          amount: num(e.amount),
          price: num(e.price),
          full: !!e.full,
          notes: String(e.notes || ''),
          station: String(e.station || ''),
          createdAt: e.createdAt || new Date().toISOString(),
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo ?? 0) - (b.odo ?? 0))),
    }));
  if (!out.vehicles.length) return out;
  if (!out.vehicles.some((v) => v.id === out.activeVehicle)) out.activeVehicle = out.vehicles[0].id;
  return out;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* ---------- caricamento ---------- */

const state = {
  db: null,
  persisted: false,
  persistSupported: 'storage' in navigator && 'persist' in navigator.storage,
  installed: false,
  recovered: null, // 'idb' | 'backup' | null
  quota: null,
};

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function load() {
  detectInstalled();

  const fromLS = sanitize(readLocal(KEY));
  const fromIDB = sanitize(await idbGet(KEY));

  let db = null;
  if (fromLS && fromIDB) {
    // vince il più recente
    db = (fromIDB.updatedAt || '') > (fromLS.updatedAt || '') ? fromIDB : fromLS;
    if (db === fromIDB) state.recovered = 'idb-newer';
  } else if (fromLS) {
    db = fromLS;
  } else if (fromIDB) {
    db = fromIDB;
    state.recovered = 'idb';
  } else {
    const bak = sanitize(readLocal(KEY_BAK));
    if (bak) { db = bak; state.recovered = 'backup'; }
  }

  if (!db) {
    db = seedDb();
    state.recovered = 'seed';
  }
  state.db = db;
  await save({ silent: true });
  await refreshStorageStatus();
  return db;
}

function seedDb() {
  const db = emptyDb();
  const S = window.SEED;
  if (!S) {
    const v = newVehicle('Veicolo 1');
    db.vehicles = [v];
    db.activeVehicle = v.id;
    return db;
  }
  const v = newVehicle(S.vehicle.name, S.vehicle);
  v.entries = S.rows.map((r) =>
    newEntry({
      date: r.d, odo: r.o ?? null, liters: r.l ?? null, amount: r.a ?? null,
      price: r.p ?? null, full: !!r.f, notes: r.n || '',
    })
  );
  db.vehicles = [v];
  db.activeVehicle = v.id;
  return db;
}

/* ---------- salvataggio ---------- */

let saveTimer = null;
async function save(opts = {}) {
  const db = state.db;
  if (!db) return;
  db.updatedAt = new Date().toISOString();
  const json = JSON.stringify(db);

  try {
    // la copia precedente diventa il backup, poi si sovrascrive il corrente
    const prev = localStorage.getItem(KEY);
    if (prev && prev !== json) localStorage.setItem(KEY_BAK, prev);
    localStorage.setItem(KEY, json);
  } catch (e) {
    console.warn('localStorage non disponibile:', e);
  }
  await idbSet(KEY, db);

  if (!opts.silent) document.dispatchEvent(new CustomEvent('db:changed'));
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 200);
}

/* ---------- stato dello storage ---------- */

function detectInstalled() {
  state.installed =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  return state.installed;
}

async function refreshStorageStatus() {
  detectInstalled();
  try {
    if (navigator.storage && navigator.storage.persisted) {
      state.persisted = await navigator.storage.persisted();
    }
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      state.quota = { usage: e.usage, quota: e.quota };
    }
  } catch { /* non supportato: si prosegue */ }
  return state;
}

async function requestPersist() {
  try {
    if (!(navigator.storage && navigator.storage.persist)) return false;
    const ok = await navigator.storage.persist();
    state.persisted = ok;
    return ok;
  } catch { return false; }
}

/* ---------- accesso ai veicoli ---------- */

function vehicles() { return state.db ? state.db.vehicles : []; }
function active() {
  const db = state.db;
  if (!db) return null;
  return db.vehicles.find((v) => v.id === db.activeVehicle) || db.vehicles[0] || null;
}
function setActive(id) {
  state.db.activeVehicle = id;
  save();
}
function addVehicle(name, extra) {
  const v = newVehicle(name, extra);
  state.db.vehicles.push(v);
  state.db.activeVehicle = v.id;
  save();
  return v;
}
function updateVehicle(id, patch) {
  const v = state.db.vehicles.find((x) => x.id === id);
  if (!v) return;
  Object.assign(v, patch);
  save();
}
function removeVehicle(id) {
  state.db.vehicles = state.db.vehicles.filter((v) => v.id !== id);
  if (!state.db.vehicles.length) {
    const v = newVehicle('Veicolo 1');
    state.db.vehicles = [v];
  }
  if (!state.db.vehicles.some((v) => v.id === state.db.activeVehicle))
    state.db.activeVehicle = state.db.vehicles[0].id;
  save();
}

function addEntry(vehicleId, data) {
  const v = state.db.vehicles.find((x) => x.id === vehicleId);
  if (!v) return null;
  const e = newEntry(data);
  v.entries.push(e);
  v.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo ?? 0) - (b.odo ?? 0)));
  save();
  return e;
}
function updateEntry(vehicleId, entryId, patch) {
  const v = state.db.vehicles.find((x) => x.id === vehicleId);
  if (!v) return;
  const e = v.entries.find((x) => x.id === entryId);
  if (!e) return;
  Object.assign(e, patch);
  v.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo ?? 0) - (b.odo ?? 0)));
  save();
}
function removeEntry(vehicleId, entryId) {
  const v = state.db.vehicles.find((x) => x.id === vehicleId);
  if (!v) return;
  v.entries = v.entries.filter((e) => e.id !== entryId);
  save();
}

/* ---------- export / import ---------- */

function exportJson() {
  const db = state.db;
  return JSON.stringify(
    {
      format: 'benzina-e-km',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      settings: db.settings,
      vehicles: db.vehicles.map((v) => ({
        name: v.name, plate: v.plate, fuel: v.fuel, tank: v.tank,
        entries: v.entries.map((e) => ({
          date: e.date, odo: e.odo, liters: e.liters, amount: e.amount,
          price: e.price, full: e.full, notes: e.notes, station: e.station,
        })),
      })),
    },
    null,
    1
  );
}

/* CSV con una colonna "veicolo": un unico file copre tutti i veicoli e si apre
 * direttamente in un foglio di calcolo. Separatore ";" e virgola decimale,
 * come si aspetta Excel in italiano. */
function exportCsv() {
  const head = ['veicolo', 'data', 'odometro_km', 'litri', 'importo_eur', 'prezzo_eur_l', 'pieno', 'note', 'distributore'];
  const lines = [head.join(';')];
  for (const v of state.db.vehicles) {
    for (const e of v.entries) {
      lines.push([
        csvCell(v.name), e.date, dec(e.odo), dec(e.liters), dec(e.amount), dec(e.price),
        e.full ? 'si' : 'no', csvCell(e.notes), csvCell(e.station),
      ].join(';'));
    }
  }
  return '﻿' + lines.join('\r\n');
}
function dec(v) { return v == null ? '' : String(v).replace('.', ','); }
function csvCell(s) {
  s = String(s ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Importa JSON o CSV.
 * @param {string} text
 * @param {'merge'|'replace'} mode
 * @returns {{vehicles:number, entries:number, skipped:number, mode:string}}
 */
function importData(text, mode = 'merge') {
  const trimmed = text.trim();
  let payload;
  if (trimmed.startsWith('{')) payload = parseJsonExport(trimmed);
  else payload = parseCsv(trimmed);
  if (!payload || !payload.vehicles.length) throw new Error('Nessun dato riconosciuto nel file.');

  if (mode === 'replace') {
    state.db.vehicles = [];
  } else {
    // al primo avvio l'app crea un veicolo vuoto di cortesia: se si importa
    // subito, quel segnaposto va tolto, altrimenti resta lì a vuoto
    const onlyPlaceholder =
      state.db.vehicles.length === 1 &&
      state.db.vehicles[0].entries.length === 0 &&
      /^veicolo( 1)?$/i.test(state.db.vehicles[0].name);
    if (onlyPlaceholder) state.db.vehicles = [];
  }

  let nV = 0, nE = 0, skipped = 0;
  for (const iv of payload.vehicles) {
    let v = state.db.vehicles.find((x) => x.name.toLowerCase() === iv.name.toLowerCase());
    if (!v) {
      v = newVehicle(iv.name, iv);
      state.db.vehicles.push(v);
      nV++;
    } else if (iv.tank != null && v.tank == null) {
      v.tank = iv.tank;
    }
    const seen = new Set(v.entries.map(sig));
    for (const ie of iv.entries) {
      const e = newEntry(ie);
      if (seen.has(sig(e))) { skipped++; continue; }
      seen.add(sig(e));
      v.entries.push(e);
      nE++;
    }
    v.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo ?? 0) - (b.odo ?? 0)));
  }
  if (!state.db.vehicles.some((v) => v.id === state.db.activeVehicle))
    state.db.activeVehicle = state.db.vehicles[0].id;
  save();
  return { vehicles: nV, entries: nE, skipped, mode };
}

/* firma per il dedup in import: stessa data + stesso odometro + stessi litri */
function sig(e) {
  return [e.date, e.odo ?? '', e.liters ?? '', e.amount ?? ''].join('|');
}

function parseJsonExport(text) {
  const o = JSON.parse(text);
  // export dell'app
  if (Array.isArray(o.vehicles)) {
    return {
      vehicles: o.vehicles.map((v) => ({
        name: String(v.name || 'Veicolo'), plate: v.plate || '', fuel: v.fuel || 'Benzina', tank: num(v.tank),
        entries: (v.entries || []).map(normEntry).filter(Boolean),
      })),
    };
  }
  // array semplice di rifornimenti di un solo veicolo
  if (Array.isArray(o)) {
    return { vehicles: [{ name: 'Importato', entries: o.map(normEntry).filter(Boolean) }] };
  }
  throw new Error('Struttura JSON non riconosciuta.');
}

function normEntry(e) {
  if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''))) return null;
  return {
    date: e.date, odo: num(e.odo), liters: num(e.liters), amount: num(e.amount),
    price: num(e.price), full: !!e.full, notes: String(e.notes || ''), station: String(e.station || ''),
  };
}

function parseCsv(text) {
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('CSV vuoto o senza intestazione.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const iV = col('veicolo', 'vehicle');
  const iD = col('data', 'date');
  const iO = col('odometro_km', 'odometro', 'km', 'odo');
  const iL = col('litri', 'liters', 'l');
  const iA = col('importo_eur', 'importo', 'amount', 'eur', 'spesa');
  const iP = col('prezzo_eur_l', 'prezzo', 'price');
  const iF = col('pieno', 'a_tappo', 'full');
  const iN = col('note', 'notes');
  const iS = col('distributore', 'station');
  if (iD < 0) throw new Error('Manca la colonna "data".');

  const byVehicle = new Map();
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    if (!c || !c.length || !String(c[iD] || '').trim()) continue;
    const name = iV >= 0 && c[iV] ? String(c[iV]).trim() : 'Importato';
    const date = normDate(c[iD]);
    if (!date) continue;
    const fv = iF >= 0 ? String(c[iF] || '').trim().toLowerCase() : '';
    const e = {
      date,
      odo: num(c[iO]), liters: num(c[iL]), amount: num(c[iA]), price: num(c[iP]),
      full: ['si', 'sì', 'yes', 'true', '1', 'x', 'a tappo', 'pieno'].includes(fv),
      notes: iN >= 0 ? String(c[iN] || '') : '',
      station: iS >= 0 ? String(c[iS] || '') : '',
    };
    if (!byVehicle.has(name)) byVehicle.set(name, []);
    byVehicle.get(name).push(e);
  }
  return { vehicles: [...byVehicle].map(([name, entries]) => ({ name, entries })) };
}

function normDate(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/* parser CSV che gestisce virgolette, ";" o "," come separatore */
function csvRows(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const out = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* ---------- promemoria di backup ---------- */

function markExported() {
  state.db.settings.lastExport = new Date().toISOString();
  save();
}
function daysSinceExport() {
  const t = state.db && state.db.settings.lastExport;
  if (!t) return null;
  return Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
}

window.STORE = {
  state, load, save, saveSoon,
  vehicles, active, setActive, addVehicle, updateVehicle, removeVehicle,
  addEntry, updateEntry, removeEntry,
  exportJson, exportCsv, importData,
  requestPersist, refreshStorageStatus, detectInstalled,
  markExported, daysSinceExport,
  newEntry, uid, num,
};

})();
