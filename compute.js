/* compute.js — motore di calcolo.
 *
 * Tutta la matematica dell'app sta qui, separata dall'interfaccia, così è
 * verificabile in isolamento (vedi test.js).
 *
 * Concetti:
 *  - "record"       = una riga: può essere un rifornimento, una semplice
 *                     lettura dell'odometro, o entrambi.
 *  - "pieno"        = rifornimento fatto a tappo (serbatoio riempito fino
 *                     all'orlo). È l'unico punto in cui si sa esattamente
 *                     quanto carburante c'è nel serbatoio, quindi è l'unico
 *                     riferimento valido per calcolare un consumo.
 *  - "tratta"       = intervallo tra due pieni consecutivi. Il consumo si
 *                     calcola solo sulle tratte: km percorsi / litri messi
 *                     DOPO il pieno precedente e fino a questo compreso.
 */

(function () {
'use strict';

const MONTH_DAYS = 365.25 / 12; // 30.4375 — mese medio, usato per i tassi mensili

/* ---------- utilità date ---------- */

function toDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function dayDiff(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}
function monthKey(s) {
  return String(s).slice(0, 7);
}
function addDaysISO(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthLabel(key) {
  const M = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const [y, m] = key.split('-');
  return M[Number(m) - 1] + ' ' + y.slice(2);
}

/* ---------- normalizzazione ---------- */

/* Completa il terzo valore fra importo / litri / prezzo quando ne mancano uno.
 * Non tocca mai i valori inseriti dall'utente: solo aggiunge quelli mancanti. */
function fillDerived(e) {
  const has = (v) => v !== null && v !== undefined && !Number.isNaN(v);
  if (!has(e.price) && has(e.amount) && has(e.liters) && e.liters > 0) {
    e.price = round(e.amount / e.liters, 3);
    e._priceDerived = true;
  } else if (!has(e.amount) && has(e.price) && has(e.liters)) {
    e.amount = round(e.price * e.liters, 2);
    e._amountDerived = true;
  } else if (!has(e.liters) && has(e.price) && has(e.amount) && e.price > 0) {
    e.liters = round(e.amount / e.price, 2);
    e._litersDerived = true;
  }
  return e;
}

/* Segnala quando importo, litri e prezzo dichiarati non tornano fra loro.
 * Non corregge nulla: i dati restano quelli inseriti. */
function coherence(e) {
  if (e.amount == null || e.liters == null || e.price == null || e.liters <= 0) return null;
  const calc = e.amount / e.liters;
  const diff = Math.abs(calc - e.price);
  if (diff <= Math.max(0.008, e.price * 0.005)) return null;
  return { declared: e.price, computed: round(calc, 3), diff: round(diff, 3) };
}

function round(v, n) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

function isRefuel(e) {
  return e.liters != null || e.amount != null;
}

/* ---------- analisi principale ---------- */

/**
 * @param {Array} rawEntries record del veicolo
 * @returns {Object} { rows, stats, months, warnings }
 */
function analyze(rawEntries) {
  const entries = rawEntries
    .map((e) => fillDerived({ ...e }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ao = a.odo == null ? Infinity : a.odo;
      const bo = b.odo == null ? Infinity : b.odo;
      return ao - bo;
    });

  const rows = entries.map((e) => ({
    ...e,
    refuel: isRefuel(e),
    coherence: coherence(e),
    // campi calcolati, riempiti sotto
    dkm: null, dliters: null, damount: null, ddays: null,
    kmL: null, l100: null, costKm: null,
    kmMonth: null, litersMonth: null, costMonth: null,
    quality: null, qualityNote: null, stintRefuels: 0,
  }));

  /* --- 1. consumo per tratta (solo fra due pieni con odometro) --- */
  const refuelIdx = rows.map((r, i) => (r.refuel ? i : -1)).filter((i) => i >= 0);

  for (let k = 0; k < refuelIdx.length; k++) {
    const i = refuelIdx[k];
    const cur = rows[i];
    if (!cur.full || cur.odo == null) {
      if (cur.refuel && !cur.full) {
        cur.quality = 'none';
        cur.qualityNote = 'Rifornimento non a tappo: il consumo non è calcolabile su questa riga, i suoi litri confluiscono nel prossimo pieno.';
      }
      continue;
    }

    // ancora = pieno precedente con odometro
    let aK = -1;
    for (let j = k - 1; j >= 0; j--) {
      const rj = rows[refuelIdx[j]];
      if (rj.full && rj.odo != null) { aK = j; break; }
    }
    if (aK < 0) continue;

    const anchor = rows[refuelIdx[aK]];
    const dkm = cur.odo - anchor.odo;
    if (!(dkm > 0)) continue;

    // litri e spesa di TUTTI i rifornimenti dopo l'ancora fino a questo compreso
    let L = 0, EUR = 0, n = 0, missingLiters = false;
    for (let j = aK + 1; j <= k; j++) {
      const rj = rows[refuelIdx[j]];
      n++;
      if (rj.liters == null) missingLiters = true; else L += rj.liters;
      if (rj.amount != null) EUR += rj.amount;
    }
    if (!(L > 0)) continue;

    const ddays = Math.max(1, dayDiff(anchor.date, cur.date));
    cur.dkm = dkm;
    cur.dliters = round(L, 2);
    cur.damount = round(EUR, 2);
    cur.ddays = ddays;
    cur.kmL = round(dkm / L, 2);
    cur.l100 = round((100 * L) / dkm, 2);
    cur.costKm = EUR > 0 ? round(EUR / dkm, 4) : null;
    cur.stintRefuels = n;
    cur._anchorIdx = refuelIdx[aK];

    // qualità del dato
    const prevRefuel = rows[refuelIdx[k - 1]];
    if (missingLiters) {
      cur.quality = 'bad';
      cur.qualityNote = 'Nell\'intervallo c\'è un rifornimento senza litri registrati: il consumo non è attendibile.';
    } else if (prevRefuel && !prevRefuel.full) {
      cur.quality = 'warn';
      cur.qualityNote =
        'Il rifornimento precedente (' + itDate(prevRefuel.date) + ') non era a tappo. ' +
        'Il valore è la media sull\'intero intervallo fra i due pieni (' + n + ' rifornimenti, ' +
        fmt(L, 2) + ' L): potrebbe non essere indicativo del periodo più recente.';
    } else if (n > 1) {
      cur.quality = 'warn';
      cur.qualityNote = 'Valore calcolato su ' + n + ' rifornimenti fra due pieni.';
    } else {
      cur.quality = 'good';
      cur.qualityNote = 'Da pieno a pieno, un solo rifornimento nell\'intervallo.';
    }
  }

  /* --- 2. tassi mensilizzati per riga (le colonne Km/mese, L/mese, €/mese) ---
   *
   * Errore delle formule originali: (odometro − primo odometro) / mesi trascorsi
   * dall'inizio dà la MEDIA STORICA dal 2023, non il ritmo del periodo; poi
   * quella media veniva divisa per il consumo del singolo pieno di quella riga
   * (grandezze di periodi diversi) e moltiplicata per AVERAGE(D:D), la media di
   * TUTTI i prezzi — anche quelli delle righe successive, quindi il valore
   * cambiava a ritroso a ogni nuovo rifornimento.
   *
   * Qui ogni riga misura invece il proprio periodo, normalizzato a un mese
   * medio (30,44 giorni). Ne servono però due versioni:
   *
   *  - "spot": il ritmo del singolo intervallo. Esatto, ma su un intervallo di
   *    4 giorni estrapolare a 30 dà numeri assurdi (400 km in 4 giorni → 3000
   *    km/mese). Utile nel dettaglio, illeggibile in una colonna.
   *  - "mensilizzato": il ritmo su una finestra mobile di ~90 giorni che
   *    termina in quella riga. Stabile, e comunque reattivo ai cambiamenti.
   *    È questo il valore nelle colonne Km/mese, L/mese, €/mese.
   */
  const WINDOW_DAYS = 90;

  // finestra mobile: la riga più recente che dista almeno WINDOW_DAYS,
  // altrimenti la prima disponibile (finestra sempre >= 90 giorni, tranne
  // all'inizio della serie dove si usa tutto lo storico disponibile).
  function windowAnchor(list, i) {
    const target = addDaysISO(list[i].date, -WINDOW_DAYS);
    for (let j = i - 1; j >= 0; j--) if (list[j].date <= target) return j;
    return i > 0 ? 0 : -1;
  }

  const odoSeq = rows.filter((r) => r.odo != null);
  odoSeq.forEach((r, i) => {
    if (i === 0) return;
    const p = odoSeq[i - 1];
    const dd = dayDiff(p.date, r.date);
    const dk = r.odo - p.odo;
    if (dd > 0 && dk >= 0) {
      r.kmMonthSpot = round((dk / dd) * MONTH_DAYS, 0);
      r._kmSpanDays = dd;
      r._kmSpanKm = dk;
    }
    const a = windowAnchor(odoSeq, i);
    if (a >= 0) {
      const dW = dayDiff(odoSeq[a].date, r.date);
      const kW = r.odo - odoSeq[a].odo;
      if (dW > 0 && kW >= 0) {
        r.kmMonth = round((kW / dW) * MONTH_DAYS, 0);
        r._kmWinDays = dW;
      }
    }
  });

  const refSeq = refuelIdx.map((i) => rows[i]);
  refSeq.forEach((r, i) => {
    if (i === 0) return;
    const p = refSeq[i - 1];
    const dd = dayDiff(p.date, r.date);
    if (dd > 0) {
      if (r.liters != null) r.litersMonthSpot = round((r.liters / dd) * MONTH_DAYS, 1);
      if (r.amount != null) r.costMonthSpot = round((r.amount / dd) * MONTH_DAYS, 2);
      r._refSpanDays = dd;
    }
    const a = windowAnchor(refSeq, i);
    if (a >= 0) {
      const dW = dayDiff(refSeq[a].date, r.date);
      if (dW > 0) {
        // i rifornimenti DOPO l'ancora, fino a questo compreso: sono quelli
        // che coprono effettivamente la finestra
        let L = 0, E = 0;
        for (let j = a + 1; j <= i; j++) {
          L += refSeq[j].liters || 0;
          E += refSeq[j].amount || 0;
        }
        if (L > 0) r.litersMonth = round((L / dW) * MONTH_DAYS, 1);
        if (E > 0) r.costMonth = round((E / dW) * MONTH_DAYS, 2);
        r._refWinDays = dW;
      }
    }
  });

  /* --- 3. aggregazione per mese solare ---
   * Euro e litri: somma esatta dei rifornimenti del mese (la spesa avviene in
   * una data precisa, non serve stimare).
   * Km: l'odometro dà solo totali fra due letture, quindi i km di ogni
   * intervallo vengono ripartiti sui giorni che l'intervallo copre. È una
   * stima, ed è l'unica strada onesta.
   */
  const months = {};
  const M = (key) => (months[key] = months[key] || { key, km: 0, liters: 0, cost: 0, refuels: 0, hasKm: false, hasSpesa: false });

  for (const r of rows) {
    if (!r.refuel) continue;
    const k = monthKey(r.date);
    const m = M(k);
    m.refuels++;
    m.hasSpesa = true;
    if (r.liters != null) m.liters += r.liters;
    if (r.amount != null) m.cost += r.amount;
  }

  const odoRows = rows.filter((r) => r.odo != null);
  for (let i = 1; i < odoRows.length; i++) {
    const a = odoRows[i - 1], b = odoRows[i];
    const dd = dayDiff(a.date, b.date);
    const dk = b.odo - a.odo;
    if (dd <= 0 || dk < 0) continue;
    const perDay = dk / dd;
    for (let d = 0; d < dd; d++) {
      const iso = addDaysISO(a.date, d);
      const m = M(monthKey(iso));
      m.km += perDay;
      m.hasKm = true;
    }
  }

  /* Un mese è "parziale" quando i dati non lo coprono per intero: il primo e
   * l'ultimo della serie. Va segnalato, altrimenti nei grafici il mese in corso
   * sembra un crollo (o un picco) rispetto ai precedenti. */
  const firstDay = rows.length ? rows[0].date : null;
  const lastDay = rows.length ? rows[rows.length - 1].date : null;

  const monthList = Object.values(months)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((m) => {
      const [Y, Mo] = m.key.split('-').map(Number);
      const daysInMonth = new Date(Date.UTC(Y, Mo, 0)).getUTCDate();
      const from = firstDay && monthKey(firstDay) === m.key ? Number(firstDay.slice(8)) : 1;
      const to = lastDay && monthKey(lastDay) === m.key ? Number(lastDay.slice(8)) : daysInMonth;
      const covered = Math.max(0, to - from + 1);
      const partial = covered < daysInMonth;
      const km = m.hasKm ? round(m.km, 0) : null;
      const liters = m.hasSpesa ? round(m.liters, 1) : null;
      return {
        ...m,
        km,
        liters,
        cost: m.hasSpesa ? round(m.cost, 2) : null,
        label: monthLabel(m.key),
        kmL: m.hasKm && m.liters > 0 ? round(m.km / m.liters, 2) : null,
        partial,
        coverage: round(covered / daysInMonth, 2),
        // proiezione a mese pieno, solo per i mesi parziali (usata nel tooltip)
        kmProjected: partial && km != null && covered > 0 ? round((km / covered) * daysInMonth, 0) : null,
        costProjected: partial && m.hasSpesa && covered > 0 ? round((m.cost / covered) * daysInMonth, 2) : null,
      };
    });

  /* --- 4. statistiche globali --- */
  const refuels = rows.filter((r) => r.refuel);
  const withL = refuels.filter((r) => r.liters != null);
  const withE = refuels.filter((r) => r.amount != null);
  const stints = rows.filter((r) => r.kmL != null);
  const goodStints = stints.filter((r) => r.quality === 'good' || r.quality === 'warn');

  const totLiters = sum(withL.map((r) => r.liters));
  const totCost = sum(withE.map((r) => r.amount));
  const stintKm = sum(goodStints.map((r) => r.dkm));
  const stintL = sum(goodStints.map((r) => r.dliters));
  const stintEur = sum(goodStints.map((r) => r.damount || 0));

  const first = odoRows[0] || null;
  const last = odoRows[odoRows.length - 1] || null;
  const totKm = first && last ? last.odo - first.odo : null;
  const spanDays = first && last ? dayDiff(first.date, last.date) : null;

  // consumo medio = media PONDERATA (km totali / litri totali delle tratte),
  // non la media aritmetica dei consumi delle singole tratte.
  const avgKmL = stintL > 0 ? round(stintKm / stintL, 2) : null;

  const best = goodStints.length ? goodStints.reduce((a, b) => (b.kmL > a.kmL ? b : a)) : null;
  const worst = goodStints.length ? goodStints.reduce((a, b) => (b.kmL < a.kmL ? b : a)) : null;

  const priceRows = refuels.filter((r) => r.price != null);
  const lastPrice = priceRows.length ? priceRows[priceRows.length - 1] : null;
  const minPrice = priceRows.length ? priceRows.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const maxPrice = priceRows.length ? priceRows.reduce((a, b) => (b.price > a.price ? b : a)) : null;

  // ritmo recente: ultimi 365 giorni
  const recent = recentRate(rows, 365);

  const stats = {
    nRecords: rows.length,
    nRefuels: refuels.length,
    nReadings: rows.length - refuels.length,
    firstDate: rows.length ? rows[0].date : null,
    lastDate: rows.length ? rows[rows.length - 1].date : null,
    odoFirst: first ? first.odo : null,
    odoLast: last ? last.odo : null,
    totKm, spanDays,
    totLiters: round(totLiters, 2),
    totCost: round(totCost, 2),
    avgKmL,
    avgL100: avgKmL ? round(100 / avgKmL, 2) : null,
    avgPrice: totLiters > 0 ? round(totCost / totLiters, 3) : null,
    costPerKm: stintKm > 0 && stintEur > 0 ? round(stintEur / stintKm, 4) : null,
    best, worst,
    lastPrice: lastPrice ? lastPrice.price : null,
    minPrice, maxPrice,
    // ritmo storico (dall'inizio) e recente (ultimi 12 mesi)
    kmMonthAll: totKm != null && spanDays > 0 ? round((totKm / spanDays) * MONTH_DAYS, 0) : null,
    litersMonthAll: spanDays > 0 ? round((totLiters / spanDays) * MONTH_DAYS, 1) : null,
    costMonthAll: spanDays > 0 ? round((totCost / spanDays) * MONTH_DAYS, 2) : null,
    recent,
    nStints: stints.length,
    nWarn: stints.filter((r) => r.quality === 'warn').length,
    nBad: stints.filter((r) => r.quality === 'bad').length,
    incoherent: rows.filter((r) => r.coherence).length,
  };

  return { rows, stats, months: monthList };
}

/* Ritmo mensile sugli ultimi N giorni: la fotografia del periodo recente. */
function recentRate(rows, days) {
  if (!rows.length) return null;
  const end = rows[rows.length - 1].date;
  const start = addDaysISO(end, -days);
  const win = rows.filter((r) => r.date >= start);
  if (win.length < 2) return null;

  const odoRows = win.filter((r) => r.odo != null);
  let km = null, dd = null;
  if (odoRows.length >= 2) {
    km = odoRows[odoRows.length - 1].odo - odoRows[0].odo;
    dd = dayDiff(odoRows[0].date, odoRows[odoRows.length - 1].date);
  }
  const refs = win.filter(isRefuel);
  const rdd = refs.length >= 2 ? dayDiff(refs[0].date, refs[refs.length - 1].date) : null;
  // litri/euro dal secondo rifornimento in poi: il primo copre il periodo precedente
  const inWin = refs.slice(1);
  const L = sum(inWin.map((r) => r.liters || 0));
  const E = sum(inWin.map((r) => r.amount || 0));

  return {
    days,
    fromDate: win[0].date,
    km: km,
    kmMonth: km != null && dd > 0 ? round((km / dd) * MONTH_DAYS, 0) : null,
    litersMonth: rdd > 0 ? round((L / rdd) * MONTH_DAYS, 1) : null,
    costMonth: rdd > 0 ? round((E / rdd) * MONTH_DAYS, 2) : null,
    costYear: rdd > 0 ? round((E / rdd) * 365.25, 0) : null,
  };
}

function sum(a) { return a.reduce((x, y) => x + (Number(y) || 0), 0); }

/* ---------- formattazione ---------- */

function fmt(v, dec = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtInt(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('it-IT'); }
function eur(v, dec = 2) { return v == null ? '—' : '€ ' + fmt(v, dec); }
function itDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function itDateShort(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

window.CALC = {
  analyze, fmt, fmtInt, eur, itDate, itDateShort, monthLabel,
  dayDiff, addDaysISO, monthKey, round, isRefuel, fillDerived, coherence,
  MONTH_DAYS,
};

})();
