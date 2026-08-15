/* app.js — interfaccia. Ogni schermata si ridisegna dall'analisi corrente,
 * non tiene stato proprio: cambiare un dato ricalcola tutto. */

(function () {
'use strict';

const S = window.STORE;
const C = window.CALC;
const G = window.CHARTS;

const app = {
  view: 'home',
  unit: 'kmL',
  filter: 'all',
  analysis: null,
  tables: {},
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ============================ AVVIO ============================ */

(async function init() {
  await S.load();
  app.unit = S.state.db.settings.unit || 'kmL';
  applyTheme(S.state.db.settings.theme || 'auto');

  bindNav();
  recompute();

  document.addEventListener('db:changed', recompute);
  window.addEventListener('resize', debounce(() => { if (app.view === 'charts') renderCharts(); }, 180));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.view === 'charts') renderCharts();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // lo stato di installazione può cambiare senza ricaricare
  window.addEventListener('visibilitychange', async () => {
    if (!document.hidden) { await S.refreshStorageStatus(); renderSettings(); renderHomeNotes(); }
  });
})();

function recompute() {
  const v = S.active();
  app.analysis = v ? C.analyze(v.entries) : { rows: [], stats: {}, months: [] };
  renderVehicleSelect();
  renderHome();
  renderList();
  if (app.view === 'charts') renderCharts();
  renderSettings();
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ============================ NAVIGAZIONE ============================ */

function bindNav() {
  $$('.tabs button').forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.v))
  );
  $('#fab').addEventListener('click', () => openEntry(null));
  $('#vsel').addEventListener('change', (e) => S.setActive(e.target.value));

  $$('#unit-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      app.unit = b.dataset.u;
      S.state.db.settings.unit = app.unit;
      S.save();
      $$('#unit-toggle button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderCharts(); renderHome();
    })
  );
  $$('#list-filter button').forEach((b) =>
    b.addEventListener('click', () => {
      app.filter = b.dataset.f;
      $$('#list-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderList();
    })
  );
  $$('#theme-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      applyTheme(b.dataset.t);
      S.state.db.settings.theme = b.dataset.t;
      S.save();
      if (app.view === 'charts') renderCharts();
    })
  );
}

function show(v) {
  app.view = v;
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === v)));
  $('#fab').style.display = v === 'home' || v === 'list' ? 'grid' : 'none';
  window.scrollTo({ top: 0 });
  if (v === 'charts') renderCharts();
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $$('#theme-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
}

/* ============================ VEICOLI (selettore) ============================ */

function renderVehicleSelect() {
  const sel = $('#vsel');
  const db = S.state.db;
  sel.innerHTML = db.vehicles
    .map((v) => `<option value="${v.id}"${v.id === db.activeVehicle ? ' selected' : ''}>${esc(v.name)}</option>`)
    .join('');
  sel.style.display = db.vehicles.length > 1 ? '' : 'none';
}

/* ============================ RIEPILOGO ============================ */

function renderHome() {
  const { stats: st } = app.analysis;
  renderHomeNotes();

  if (!st.nRecords) {
    $('#h-val').textContent = '—';
    $('#h-cap').textContent = 'ancora nessun dato';
    $('#h-alt').textContent = '';
    ['#t-rate', '#t-last', '#t-tot', '#t-price', '#t-cons'].forEach((s) => ($(s).innerHTML = ''));
    // primo avvio: la strada più probabile è importare un backup, non digitare
    // tre anni di rifornimenti a mano
    $('#t-rate').innerHTML = `<div style="grid-column:1/-1" class="card">
      <p style="font-size:13.5px;color:var(--text-secondary);margin:0 0 12px;line-height:1.5">
        Hai un file di backup (<b>.json</b> o <b>.csv</b>)? Caricalo e ritrovi tutto lo storico.
        Altrimenti tocca <b>＋</b> per registrare il primo rifornimento.</p>
      <button class="btn" data-act="import">Importa da file…</button>
    </div>`;
    $('#t-rate [data-act=import]').onclick = () => { show('set'); setTimeout(() => $('#imp-btn').click(), 250); };
    $$('#v-home .sec-title').forEach((el) => (el.style.display = 'none'));
    $('.hero').style.display = 'none';
    return;
  }
  $$('#v-home .sec-title').forEach((el) => (el.style.display = ''));
  $('.hero').style.display = '';

  // numero in evidenza: consumo medio, nell'unità scelta
  const kmL = st.avgKmL;
  if (app.unit === 'l100' && st.avgL100) {
    $('#h-val').innerHTML = C.fmt(st.avgL100, 2) + '<small>L/100 km</small>';
    $('#h-alt').textContent = kmL ? `pari a ${C.fmt(kmL, 2)} km/L` : '';
  } else {
    $('#h-val').innerHTML = kmL ? C.fmt(kmL, 2) + '<small>km/L</small>' : '—';
    $('#h-alt').textContent = st.avgL100 ? `pari a ${C.fmt(st.avgL100, 2)} L/100 km` : '';
  }
  $('#h-cap').textContent = `consumo medio su ${st.nStints} tratt${st.nStints === 1 ? 'a' : 'e'} fra pieni`;

  const r = st.recent || {};
  $('#h-window').textContent = r.days ? `· ultimi 12 mesi` : '';
  $('#t-rate').innerHTML = [
    tile('Km / mese', C.fmtInt(r.kmMonth), '', st.kmMonthAll ? `storico ${C.fmtInt(st.kmMonthAll)}` : ''),
    tile('Litri / mese', C.fmt(r.litersMonth, 1), '', st.litersMonthAll ? `storico ${C.fmt(st.litersMonthAll, 1)}` : ''),
    tile('€ / mese', C.fmt(r.costMonth, 0), '', r.costYear ? `≈ € ${C.fmtInt(r.costYear)}/anno` : ''),
  ].join('');

  $('#t-last').innerHTML = lastCard();

  $('#t-tot').innerHTML = [
    tile('Km percorsi', C.fmtInt(st.totKm), '', st.spanDays ? `in ${C.fmtInt(st.spanDays)} giorni` : ''),
    tile('Spesa totale', '€ ' + C.fmt(st.totCost, 0), '', `${st.nRefuels} rifornimenti`),
    tile('Litri totali', C.fmt(st.totLiters, 0), 'L', ''),
    tile('Costo per km', st.costPerKm != null ? '€ ' + C.fmt(st.costPerKm, 3) : '—', '',
      st.costPerKm ? `€ ${C.fmt(st.costPerKm * 100, 2)} ogni 100 km` : ''),
  ].join('');

  $('#t-price').innerHTML = [
    tile('Ultimo', st.lastPrice ? '€ ' + C.fmt(st.lastPrice, 3) : '—', '', ''),
    tile('Medio', st.avgPrice ? '€ ' + C.fmt(st.avgPrice, 3) : '—', '', 'ponderato'),
    tile('Minimo', st.minPrice ? '€ ' + C.fmt(st.minPrice.price, 3) : '—', '',
      st.minPrice ? C.itDateShort(st.minPrice.date) : ''),
  ].join('');

  const u = (v) => (app.unit === 'l100' ? C.fmt(100 / v, 2) + ' L/100' : C.fmt(v, 2) + ' km/L');
  $('#t-cons').innerHTML = [
    tile('Migliore', st.best ? u(st.best.kmL) : '—', '', st.best ? C.itDateShort(st.best.date) : ''),
    tile('Peggiore', st.worst ? u(st.worst.kmL) : '—', '', st.worst ? C.itDateShort(st.worst.date) : ''),
  ].join('');
}

function tile(k, v, unit, s) {
  return `<div class="tile"><div class="k">${esc(k)}</div>
    <div class="v">${v}${unit ? `<small>${esc(unit)}</small>` : ''}</div>
    ${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
}

function lastCard() {
  const rows = app.analysis.rows;
  const refuels = rows.filter((r) => r.refuel);
  const last = refuels[refuels.length - 1];
  if (!last) return '<div class="tile"><div class="k">nessun rifornimento</div></div>';
  const today = new Date().toISOString().slice(0, 10);
  const ago = C.dayDiff(last.date, today);
  const lastOdoRow = [...rows].reverse().find((r) => r.odo != null);

  const v = S.active();
  let range = '';
  if (v && v.tank && app.analysis.stats.avgKmL) {
    range = `autonomia stimata ${C.fmtInt(Math.round(v.tank * app.analysis.stats.avgKmL))} km a serbatoio pieno`;
  }
  return `<div class="card" style="margin-bottom:0">
    <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <b style="font-size:17px;letter-spacing:-.02em">${C.itDate(last.date)}</b>
      <span style="font-size:12.5px;color:var(--muted)">${ago === 0 ? 'oggi' : ago === 1 ? 'ieri' : ago + ' giorni fa'}</span>
      ${last.full ? '<span class="badge full">pieno</span>' : '<span class="badge part">parziale</span>'}
    </div>
    <div style="display:flex;gap:16px;margin-top:9px;flex-wrap:wrap;font-size:13.5px">
      <span><b>${C.fmt(last.liters, 2)}</b> L</span>
      <span><b>€ ${C.fmt(last.amount, 2)}</b></span>
      <span style="color:var(--text-secondary)">€ ${C.fmt(last.price, 3)}/L</span>
      ${last.kmL ? `<span style="color:var(--text-secondary)">${app.unit === 'l100' ? C.fmt(last.l100, 2) + ' L/100 km' : C.fmt(last.kmL, 2) + ' km/L'}</span>` : ''}
    </div>
    ${lastOdoRow ? `<div style="font-size:12px;color:var(--muted);margin-top:7px">
      Odometro ${C.fmtInt(lastOdoRow.odo)} km${range ? ' · ' + range : ''}</div>` : ''}
  </div>`;
}

/* --- avvisi in home: installazione, storage, backup --- */
function renderHomeNotes() {
  const out = [];
  const st = S.state;

  if (!st.installed) {
    out.push(note('warn', '⚑',
      '<b>Aggiungi l\'app alla schermata Home.</b> Finché resta una scheda del browser, ' +
      'Safari può cancellare i dati dopo 7 giorni senza aperture. Installata, il limite non si applica.',
      'Come si fa', "goSettings"));
  } else if (!st.persisted && st.persistSupported) {
    out.push(note('info', '◈',
      'Puoi chiedere al browser di marcare i dati come permanenti: riduce il rischio che vengano ' +
      'rimossi quando lo spazio scarseggia.',
      'Attiva ora', 'askPersist'));
  }

  const d = S.daysSinceExport();
  const nRef = app.analysis.stats.nRefuels || 0;
  if (nRef > 3 && (d === null || d > 30)) {
    out.push(note('info', '⤓',
      d === null
        ? 'Non hai ancora fatto un backup. Un export salvato in iCloud o Drive è l\'unica difesa che sopravvive a tutto.'
        : `Ultimo backup ${d} giorni fa. Un export periodico mette al riparo da qualsiasi cancellazione.`,
      'Esporta adesso', 'goExport'));
  }

  // se l'ultima tratta calcolabile porta un avviso, i numeri qui sopra ne
  // risentono: va detto dove i numeri si guardano, non solo nel dettaglio
  const stints = app.analysis.rows.filter((r) => r.kmL != null);
  const lastStint = stints[stints.length - 1];
  if (lastStint && (lastStint.quality === 'warn' || lastStint.quality === 'bad')) {
    out.push(note('warn', '△',
      `<b>L'ultimo consumo calcolato potrebbe non essere indicativo.</b> ${esc(lastStint.qualityNote)}`,
      null, null));
  }

  if (app.analysis.stats.nBad > 0) {
    out.push(note('warn', '△',
      `${app.analysis.stats.nBad} tratte hanno dati incompleti e sono escluse dalle statistiche.`, null, null));
  }

  $('#home-notes').innerHTML = out.join('');
  $$('#home-notes [data-act]').forEach((a) => (a.onclick = () => noteAction(a.dataset.act)));
}

function note(kind, ic, html, actLabel, act) {
  return `<div class="note ${kind}"><span class="ic">${ic}</span><div>${html}
    ${actLabel ? `<a class="act" data-act="${act}">${esc(actLabel)}</a>` : ''}</div></div>`;
}

async function noteAction(a) {
  if (a === 'goSettings') {
    show('set');
    setTimeout(() => {
      const d = $$('#v-set details.help')[0];
      if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 120);
  }
  if (a === 'goExport') { show('set'); setTimeout(() => $('#exp-json').scrollIntoView({ behavior: 'smooth', block: 'center' }), 120); }
  if (a === 'askPersist') {
    const ok = await S.requestPersist();
    toast(ok ? 'Dati marcati come permanenti' : 'Il browser non ha concesso la richiesta');
    renderHomeNotes(); renderSettings();
  }
}

/* ============================ ELENCO ============================ */

function renderList() {
  const rows = [...app.analysis.rows].reverse();
  const wrap = $('#list');
  const filtered = rows.filter((r) =>
    app.filter === 'all' ? true : app.filter === 'refuel' ? r.refuel : !r.refuel
  );

  if (!filtered.length) {
    const vuoto = !app.analysis.rows.length;
    wrap.innerHTML = `<div class="empty"><div class="g">⛽</div>
      <p>${vuoto ? 'Nessun record.<br>Tocca ＋ per aggiungerne uno, o importa un backup.' : 'Nessun record in questa categoria.'}</p>
      ${vuoto ? '<button class="btn sec" data-act="import" style="max-width:260px;margin:16px auto 0">Importa da file…</button>' : ''}</div>`;
    const b = $('[data-act=import]', wrap);
    if (b) b.onclick = () => { show('set'); setTimeout(() => $('#imp-btn').click(), 250); };
    return;
  }

  let html = '', lastMonth = '';
  for (const r of filtered) {
    const mk = C.monthKey(r.date);
    if (mk !== lastMonth) {
      lastMonth = mk;
      html += `<div class="month-sep">${C.monthLabel(mk)}</div>`;
    }
    html += itemHtml(r);
  }
  wrap.innerHTML = html;
  $$('.item', wrap).forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
}

function itemHtml(r) {
  const [y, m, d] = r.date.split('-');
  const badges =
    (!r.refuel ? '<span class="badge odo">odometro</span>' :
      r.full ? '<span class="badge full">pieno</span>' : '<span class="badge part">parziale</span>') +
    (r.quality === 'warn' ? ' <span class="badge warn">△</span>' : '') +
    (r.coherence ? ' <span class="badge warn">≠</span>' : '');

  const l2parts = [];
  if (r.odo != null) l2parts.push(C.fmtInt(r.odo) + ' km');
  if (r.liters != null) l2parts.push(C.fmt(r.liters, 2) + ' L');
  if (r.price != null) l2parts.push('€ ' + C.fmt(r.price, 3) + '/L');
  if (r.notes) l2parts.push('“' + r.notes + '”');

  const main = r.refuel ? '€ ' + C.fmt(r.amount, 2) : C.fmtInt(r.odo) + ' km';
  const sub = r.kmL != null
    ? (app.unit === 'l100' ? C.fmt(r.l100, 2) + ' L/100' : C.fmt(r.kmL, 2) + ' km/L')
    : (r.refuel ? '—' : 'lettura');

  return `<button class="item" data-id="${r.id}">
    <div class="dt"><b>${d}/${m}</b><span>${y}</span></div>
    <div class="mid">
      <div class="l1">${badges}</div>
      <div class="l2">${esc(l2parts.join(' · '))}</div>
    </div>
    <div class="rt"><b>${main}</b><span>${esc(sub)}</span></div>
  </button>`;
}

/* ============================ DETTAGLIO ============================ */

function openDetail(id) {
  const r = app.analysis.rows.find((x) => x.id === id);
  if (!r) return;

  const dl = [];
  const add = (k, v, hint) => dl.push(`<div><dt>${esc(k)}${hint ? `<br><span style="font-size:11px;color:var(--muted)">${esc(hint)}</span>` : ''}</dt><dd>${v}</dd></div>`);

  add('Data', C.itDate(r.date));
  if (r.odo != null) add('Odometro', C.fmtInt(r.odo) + ' km');
  if (r.refuel) {
    add('Litri', C.fmt(r.liters, 2) + ' L' + (r._litersDerived ? ' <span style="font-weight:400;color:var(--muted)">(calcolato)</span>' : ''));
    add('Importo', '€ ' + C.fmt(r.amount, 2) + (r._amountDerived ? ' <span style="font-weight:400;color:var(--muted)">(calcolato)</span>' : ''));
    add('Prezzo al litro', '€ ' + C.fmt(r.price, 3) + (r._priceDerived ? ' <span style="font-weight:400;color:var(--muted)">(calcolato)</span>' : ''));
    add('Tipo', r.full ? 'Pieno, a tappo' : 'Parziale');
  }
  if (r.station) add('Distributore', esc(r.station));

  let statHtml = '';
  if (r.kmL != null) {
    const s2 = [];
    const a2 = (k, v, h) => s2.push(`<div><dt>${esc(k)}${h ? `<br><span style="font-size:11px;color:var(--muted)">${esc(h)}</span>` : ''}</dt><dd>${v}</dd></div>`);
    a2('Consumo', `${C.fmt(r.kmL, 2)} km/L<br><span style="font-weight:450;color:var(--muted);font-size:12px">${C.fmt(r.l100, 2)} L/100 km</span>`);
    a2('Km percorsi', C.fmtInt(r.dkm) + ' km', `in ${r.ddays} giorni`);
    a2('Litri usati', C.fmt(r.dliters, 2) + ' L', r.stintRefuels > 1 ? `su ${r.stintRefuels} rifornimenti` : '');
    if (r.costKm) a2('Costo per km', '€ ' + C.fmt(r.costKm, 3));
    statHtml = `<div class="sec-title mt">Tratta dal pieno precedente</div>
      <div class="card" style="margin-bottom:0"><dl class="dl">${s2.join('')}</dl></div>`;
  }

  let rateHtml = '';
  if (r.kmMonth != null || r.litersMonth != null || r.costMonth != null) {
    const s3 = [];
    const a3 = (k, v, h) => s3.push(`<div><dt>${esc(k)}${h ? `<br><span style="font-size:11px;color:var(--muted)">${esc(h)}</span>` : ''}</dt><dd>${v}</dd></div>`);
    if (r.kmMonth != null) a3('Km / mese', C.fmtInt(r.kmMonth), `media su ${r._kmWinDays} giorni`);
    if (r.litersMonth != null) a3('Litri / mese', C.fmt(r.litersMonth, 1), `media su ${r._refWinDays} giorni`);
    if (r.costMonth != null) a3('€ / mese', '€ ' + C.fmt(r.costMonth, 2), `media su ${r._refWinDays} giorni`);
    if (r.kmMonthSpot != null) a3('Ritmo dell\'intervallo', C.fmtInt(r.kmMonthSpot) + ' km/mese', `${r._kmSpanKm} km in ${r._kmSpanDays} giorni`);
    rateHtml = `<div class="sec-title mt">Ritmo mensile</div>
      <div class="card" style="margin-bottom:0"><dl class="dl">${s3.join('')}</dl></div>`;
  }

  let warnHtml = '';
  if (r.qualityNote && r.quality !== 'good') {
    const kind = r.quality === 'bad' ? 'crit' : 'warn';
    warnHtml = note(kind, '△', esc(r.qualityNote), null, null);
  }
  if (r.coherence) {
    warnHtml += note('warn', '≠',
      `Importo, litri e prezzo non tornano fra loro: ${C.fmt(r.coherence.declared, 3)} €/L dichiarati contro ` +
      `${C.fmt(r.coherence.computed, 3)} €/L calcolati da ${C.fmt(r.amount, 2)} € ÷ ${C.fmt(r.liters, 2)} L. ` +
      `I dati sono lasciati come inseriti.`, null, null);
  }

  sheet(`
    <h2>${r.refuel ? 'Rifornimento' : 'Lettura odometro'}</h2>
    <p class="sheet-sub">${C.itDate(r.date)}</p>
    ${warnHtml}
    <div class="card" style="margin-bottom:0"><dl class="dl">${dl.join('')}</dl></div>
    ${r.notes ? `<div class="sec-title mt">Note</div><div class="card" style="margin-bottom:0;white-space:pre-wrap;font-size:14px">${esc(r.notes)}</div>` : ''}
    ${statHtml}
    ${rateHtml}
    <div style="height:16px"></div>
    <button class="btn" data-x="edit">Modifica</button>
    <button class="btn danger" data-x="del">Elimina</button>
    <button class="btn sec" data-x="close">Chiudi</button>
  `, (root, close) => {
    $('[data-x=close]', root).onclick = close;
    $('[data-x=edit]', root).onclick = () => { close(); openEntry(r.id); };
    $('[data-x=del]', root).onclick = () => {
      confirmSheet('Eliminare questo record?', 'L\'operazione non si può annullare.', 'Elimina', () => {
        S.removeEntry(S.active().id, r.id);
        close();
        toast('Record eliminato');
      });
    };
  });
}

/* ============================ FORM INSERIMENTO / MODIFICA ============================ */

function openEntry(id) {
  const v = S.active();
  const existing = id ? v.entries.find((e) => e.id === id) : null;
  const rows = app.analysis.rows;
  const lastOdo = [...rows].reverse().find((r) => r.odo != null);
  const isNew = !existing;
  const mode = existing ? (C.isRefuel(existing) ? 'refuel' : 'odo') : 'refuel';

  const e = existing || S.newEntry({ full: true });

  sheet(`
    <h2>${isNew ? 'Nuovo record' : 'Modifica'}</h2>
    <p class="sheet-sub">${esc(v.name)}</p>

    <div class="seg" id="f-mode" style="margin-bottom:14px">
      <button data-m="refuel" aria-pressed="${mode === 'refuel'}">Rifornimento</button>
      <button data-m="odo" aria-pressed="${mode === 'odo'}">Solo odometro</button>
    </div>

    <div class="field">
      <label for="f-date">Data</label>
      <input type="date" id="f-date" value="${e.date}" max="2100-12-31">
    </div>

    <div class="field">
      <label for="f-odo">Odometro (km)</label>
      <input type="number" id="f-odo" inputmode="numeric" step="1" placeholder="${lastOdo ? 'ultimo: ' + lastOdo.odo : 'km totali'}" value="${e.odo ?? ''}">
      <div class="hint" id="f-odo-hint"></div>
    </div>

    <div id="f-refuel-block">
      <div class="row3">
        <div class="field">
          <label for="f-liters">Litri</label>
          <input type="number" id="f-liters" inputmode="decimal" step="0.01" value="${e.liters ?? ''}">
        </div>
        <div class="field">
          <label for="f-amount">Importo €</label>
          <input type="number" id="f-amount" inputmode="decimal" step="0.01" value="${e.amount ?? ''}">
        </div>
        <div class="field">
          <label for="f-price">€ / L</label>
          <input type="number" id="f-price" inputmode="decimal" step="0.001" value="${e.price ?? ''}">
        </div>
      </div>
      <div class="hint" style="margin:-6px 0 12px;font-size:11.5px;color:var(--muted)">
        Compilane due: il terzo si calcola da solo.
      </div>

      <div class="check">
        <input type="checkbox" id="f-full" ${e.full ? 'checked' : ''}>
        <div class="tx">
          <b>Pieno, a tappo</b>
          <span>Serbatoio riempito fino all'orlo. Serve per calcolare il consumo.</span>
        </div>
      </div>

      <div class="field">
        <label for="f-station">Distributore <span style="font-weight:400;color:var(--muted)">(facoltativo)</span></label>
        <input type="text" id="f-station" value="${esc(e.station || '')}" placeholder="es. Q8 tangenziale">
      </div>
    </div>

    <div class="field">
      <label for="f-notes">Note</label>
      <textarea id="f-notes" placeholder="Manutenzioni, viaggi, qualsiasi cosa da ricordare">${esc(e.notes || '')}</textarea>
    </div>

    <div id="f-err"></div>
    <button class="btn" data-x="save">${isNew ? 'Aggiungi' : 'Salva'}</button>
    <button class="btn sec" data-x="close">Annulla</button>
  `, (root, close) => {
    let m = mode;
    const setMode = (nm) => {
      m = nm;
      $$('#f-mode button', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === nm)));
      $('#f-refuel-block', root).style.display = nm === 'odo' ? 'none' : '';
    };
    $$('#f-mode button', root).forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    setMode(mode);

    // il terzo campo si completa da solo appena ce ne sono due
    const L = $('#f-liters', root), A = $('#f-amount', root), P = $('#f-price', root);
    const nv = (el) => S.num(el.value);
    let editing = null;
    const sync = (changed) => {
      editing = changed;
      const l = nv(L), a = nv(A), p = nv(P);
      if (changed !== 'p' && l > 0 && a > 0) P.value = (a / l).toFixed(3);
      else if (changed !== 'a' && l > 0 && p > 0) A.value = (l * p).toFixed(2);
      else if (changed !== 'l' && a > 0 && p > 0) L.value = (a / p).toFixed(2);
    };
    L.oninput = () => sync('l');
    A.oninput = () => sync('a');
    P.oninput = () => sync('p');

    // controllo odometro in tempo reale
    const O = $('#f-odo', root), OH = $('#f-odo-hint', root);
    const checkOdo = () => {
      const val = S.num(O.value);
      OH.textContent = '';
      OH.style.color = 'var(--muted)';
      if (val == null) return;
      const others = v.entries.filter((x) => x.id !== e.id && x.odo != null);
      const before = others.filter((x) => x.date <= ($('#f-date', root).value || e.date)).pop();
      const after = others.find((x) => x.date > ($('#f-date', root).value || e.date));
      if (before && val < before.odo) {
        OH.textContent = `Attenzione: minore dell'odometro del ${C.itDate(before.date)} (${C.fmtInt(before.odo)} km).`;
        OH.style.color = 'var(--status-critical)';
      } else if (after && val > after.odo) {
        OH.textContent = `Attenzione: maggiore dell'odometro del ${C.itDate(after.date)} (${C.fmtInt(after.odo)} km).`;
        OH.style.color = 'var(--status-critical)';
      } else if (before) {
        OH.textContent = `+${C.fmtInt(val - before.odo)} km dal ${C.itDate(before.date)}.`;
      }
    };
    O.oninput = checkOdo;
    $('#f-date', root).onchange = checkOdo;
    checkOdo();

    $('[data-x=close]', root).onclick = close;
    $('[data-x=save]', root).onclick = () => {
      const date = $('#f-date', root).value;
      if (!date) return err(root, 'Serve una data.');
      const odo = S.num(O.value);
      const patch = {
        date,
        odo,
        notes: $('#f-notes', root).value.trim(),
        liters: null, amount: null, price: null, full: false, station: '',
      };
      if (m === 'refuel') {
        patch.liters = S.num(L.value);
        patch.amount = S.num(A.value);
        patch.price = S.num(P.value);
        patch.full = $('#f-full', root).checked;
        patch.station = $('#f-station', root).value.trim();
        if (patch.liters == null && patch.amount == null)
          return err(root, 'Inserisci almeno i litri o l\'importo. Se volevi registrare solo i km, scegli “Solo odometro”.');
      } else if (odo == null) {
        return err(root, 'Inserisci i km dell\'odometro.');
      }
      if (existing) S.updateEntry(v.id, existing.id, patch);
      else S.addEntry(v.id, patch);
      close();
      toast(existing ? 'Modifiche salvate' : 'Record aggiunto');
    };
  });
}

function err(root, msg) {
  $('#f-err', root).innerHTML = note('crit', '✕', esc(msg), null, null);
  $('#f-err', root).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ============================ GRAFICI ============================ */

function renderCharts() {
  const { rows, months, stats: st } = app.analysis;
  const host = $('#charts');
  const l100 = app.unit === 'l100';

  const consPts = rows
    .filter((r) => r.kmL != null)
    .map((r) => ({
      t: new Date(r.date + 'T00:00:00Z'),
      y: l100 ? r.l100 : r.kmL,
      flag: r.quality === 'warn' || r.quality === 'bad' ? 'warn' : null,
      label: C.itDate(r.date),
      sub: `${C.fmt(r.kmL, 2)} km/L · ${C.fmt(r.l100, 2)} L/100 km<br>${C.fmtInt(r.dkm)} km con ${C.fmt(r.dliters, 2)} L` +
        (r.quality === 'warn' ? '<br>△ pieno precedente incompleto' : ''),
    }));

  const pricePts = rows
    .filter((r) => r.price != null)
    .map((r) => ({
      t: new Date(r.date + 'T00:00:00Z'),
      y: r.price,
      label: C.itDate(r.date),
      sub: `€ ${C.fmt(r.price, 3)}/L · ${C.fmt(r.liters, 2)} L · € ${C.fmt(r.amount, 2)}`,
    }));

  const mKm = months.filter((m) => m.km != null).map((m) => ({
    label: m.label, value: m.km, partial: m.partial,
    sub: `${C.fmtInt(m.km)} km` + (m.partial ? `<br>mese incompleto · a fine mese ≈ ${C.fmtInt(m.kmProjected)} km` : ''),
  }));
  const mCost = months.filter((m) => m.cost != null).map((m) => ({
    label: m.label, value: m.cost, partial: m.partial,
    sub: `€ ${C.fmt(m.cost, 2)} · ${C.fmt(m.liters, 1)} L · ${m.refuels} rifornimenti` +
      (m.partial ? `<br>mese incompleto · a fine mese ≈ € ${C.fmt(m.costProjected, 0)}` : ''),
  }));

  host.innerHTML = [
    chartCard('c-cons', l100 ? 'Consumo (L/100 km)' : 'Consumo (km/L)', 'una tratta fra pieni per punto',
      tableHtml(['Data', l100 ? 'L/100' : 'km/L', 'Km', 'Litri'],
        rows.filter((r) => r.kmL != null).slice().reverse().map((r) =>
          [C.itDateShort(r.date), C.fmt(l100 ? r.l100 : r.kmL, 2), C.fmtInt(r.dkm), C.fmt(r.dliters, 2)]))),
    chartCard('c-price', 'Prezzo al litro', 'ogni rifornimento',
      tableHtml(['Data', '€/L', 'Litri', 'Importo'],
        rows.filter((r) => r.price != null).slice().reverse().map((r) =>
          [C.itDateShort(r.date), C.fmt(r.price, 3), C.fmt(r.liters, 2), '€ ' + C.fmt(r.amount, 2)]))),
    chartCard('c-km', 'Km per mese', 'ripartiti sui giorni fra le letture',
      tableHtml(['Mese', 'Km', 'Litri', 'Spesa'],
        months.slice().reverse().map((m) =>
          [m.label + (m.partial ? ' *' : ''), C.fmtInt(m.km), C.fmt(m.liters, 1), m.cost != null ? '€ ' + C.fmt(m.cost, 2) : '—']),
        '* mese incompleto')),
    chartCard('c-cost', 'Spesa per mese', 'somma dei rifornimenti del mese',
      tableHtml(['Mese', 'Spesa', 'Litri', 'Rif.'],
        months.filter((m) => m.cost != null).slice().reverse().map((m) =>
          [m.label + (m.partial ? ' *' : ''), '€ ' + C.fmt(m.cost, 2), C.fmt(m.liters, 1), String(m.refuels)]),
        '* mese incompleto')),
  ].join('');

  $$('#charts .linkbtn').forEach((b) => (b.onclick = () => {
    const w = b.closest('.card').querySelector('.tblwrap');
    const open = w.hasAttribute('hidden');
    w.toggleAttribute('hidden');
    b.textContent = open ? 'nascondi tabella' : 'tabella';
  }));

  const refKmL = st.avgKmL ? { value: l100 ? st.avgL100 : st.avgKmL, label: 'media ' + C.fmt(l100 ? st.avgL100 : st.avgKmL, 2) } : null;
  G.line($('#c-cons .chart'), { points: consPts, yFmt: (v) => C.fmt(v, 1), refLine: refKmL, height: 210 });
  G.line($('#c-price .chart'), {
    points: pricePts, yFmt: (v) => C.fmt(v, 2), color: getVar('--series-2'),
    refLine: st.avgPrice ? { value: st.avgPrice, label: 'media ' + C.fmt(st.avgPrice, 3) } : null, height: 190,
  });
  G.bars($('#c-km .chart'), { bars: mKm, yFmt: (v) => C.fmtInt(v), height: 190 });
  G.bars($('#c-cost .chart'), { bars: mCost, yFmt: (v) => '€' + C.fmtInt(v), color: getVar('--series-3'), height: 190, padL: 48 });
}

function getVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function chartCard(id, title, sub, table) {
  return `<div class="card" id="${id}">
    <div class="chart-head"><h3>${esc(title)}</h3><button class="linkbtn">tabella</button></div>
    <div class="sub" style="font-size:11.5px;color:var(--muted);margin:-2px 0 4px">${esc(sub)}</div>
    <div class="chart"><canvas></canvas><div class="tip" hidden></div></div>
    <div class="tblwrap" hidden>${table}</div>
  </div>`;
}

function tableHtml(head, rows, foot) {
  return `<table class="tbl">
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>${foot ? `<p style="font-size:11px;color:var(--muted);margin:6px 2px 0">${esc(foot)}</p>` : ''}`;
}

/* ============================ IMPOSTAZIONI ============================ */

function renderSettings() {
  const db = S.state.db;

  $('#vlist').innerHTML = db.vehicles.map((v) => {
    const a = C.analyze(v.entries);
    const bits = [];
    if (a.stats.nRefuels) bits.push(a.stats.nRefuels + ' rifornimenti');
    if (a.stats.avgKmL) bits.push(C.fmt(a.stats.avgKmL, 2) + ' km/L');
    if (v.tank) bits.push('serbatoio ' + v.tank + ' L');
    return `<div class="vrow">
      <span class="dot ${v.id === db.activeVehicle ? '' : 'off'}"></span>
      <div class="nm"><b>${esc(v.name)}</b><span>${esc(bits.join(' · ') || 'nessun dato')}</span></div>
      <button class="mini" data-edit="${v.id}">modifica</button>
    </div>`;
  }).join('');
  $$('#vlist [data-edit]').forEach((b) => (b.onclick = () => openVehicle(b.dataset.edit)));
  $('#add-vehicle').onclick = () => openVehicle(null);

  const d = S.daysSinceExport();
  $('#export-note').innerHTML = d === null
    ? note('info', '⤓', 'Nessun backup ancora effettuato.', null, null)
    : d > 30
      ? note('warn', '⤓', `Ultimo backup ${d} giorni fa.`, null, null)
      : `<p style="font-size:12.5px;color:var(--muted);margin:0 0 10px">Ultimo backup ${d === 0 ? 'oggi' : d === 1 ? 'ieri' : d + ' giorni fa'}.</p>`;

  $('#exp-json').onclick = () => download('benzina-e-km-' + today() + '.json', S.exportJson(), 'application/json');
  $('#exp-csv').onclick = () => download('benzina-e-km-' + today() + '.csv', S.exportCsv(), 'text/csv');
  $('#imp-btn').onclick = () => $('#imp-file').click();
  $('#imp-file').onchange = onImportFile;

  const st = S.state;
  const q = st.quota;
  $('#storage-status').innerHTML = [
    statusLine(st.installed ? 'ok' : 'no',
      st.installed ? 'Installata sulla schermata Home' : 'In esecuzione nel browser',
      st.installed ? 'I dati non sono soggetti alla cancellazione dopo 7 giorni.'
        : 'Safari può cancellare i dati dopo 7 giorni senza aperture. Installala per evitarlo.'),
    statusLine(st.persisted ? 'ok' : st.persistSupported ? 'mid' : 'mid',
      st.persisted ? 'Storage permanente concesso' : st.persistSupported ? 'Storage permanente non concesso' : 'Storage permanente non supportato',
      st.persisted ? 'Il browser non rimuoverà i dati per fare spazio.'
        : st.persistSupported ? 'Tocca per richiederlo.' : 'Questo browser non espone la richiesta: contano gli altri strati.'),
    statusLine('ok', 'Doppia copia locale',
      'I dati sono scritti in parallelo su localStorage e IndexedDB, con una copia del salvataggio precedente.'),
    q && q.usage != null
      ? statusLine('ok', 'Spazio occupato', `${(q.usage / 1024).toFixed(0)} KB su ${(q.quota / 1048576).toFixed(0)} MB disponibili.`)
      : '',
  ].join('');
  const persistRow = $$('#storage-status .status-line')[1];
  if (persistRow && !st.persisted && st.persistSupported) {
    persistRow.style.cursor = 'pointer';
    persistRow.onclick = () => noteAction('askPersist');
  }
}

function statusLine(kind, title, sub) {
  return `<div class="status-line"><span class="pill ${kind}"></span>
    <div class="tx"><b>${esc(title)}</b><small>${esc(sub)}</small></div></div>`;
}

function openVehicle(id) {
  const v = id ? S.state.db.vehicles.find((x) => x.id === id) : null;
  const isNew = !v;
  sheet(`
    <h2>${isNew ? 'Nuovo veicolo' : 'Modifica veicolo'}</h2>
    <p class="sheet-sub">${isNew ? 'I dati di ogni veicolo restano separati.' : (v.entries.length + ' record registrati')}</p>
    <div class="field">
      <label for="g-name">Nome</label>
      <input type="text" id="g-name" value="${esc(v ? v.name : '')}" placeholder="es. Panda, Moto, Auto di servizio">
    </div>
    <div class="row2">
      <div class="field">
        <label for="g-plate">Targa <span style="font-weight:400;color:var(--muted)">(facolt.)</span></label>
        <input type="text" id="g-plate" value="${esc(v ? v.plate : '')}">
      </div>
      <div class="field">
        <label for="g-fuel">Carburante</label>
        <select id="g-fuel">
          ${['Benzina', 'Diesel', 'GPL', 'Metano', 'Ibrido', 'Altro']
            .map((f) => `<option${v && v.fuel === f ? ' selected' : ''}>${f}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="g-tank">Capacità serbatoio (L) <span style="font-weight:400;color:var(--muted)">(facolt.)</span></label>
      <input type="number" id="g-tank" inputmode="decimal" step="0.5" value="${v && v.tank != null ? v.tank : ''}" placeholder="serve a stimare l'autonomia">
    </div>
    <div id="f-err"></div>
    <button class="btn" data-x="save">${isNew ? 'Crea' : 'Salva'}</button>
    ${!isNew && S.state.db.vehicles.length > 1 ? '<button class="btn danger" data-x="del">Elimina veicolo</button>' : ''}
    <button class="btn sec" data-x="close">Annulla</button>
  `, (root, close) => {
    $('[data-x=close]', root).onclick = close;
    $('[data-x=save]', root).onclick = () => {
      const name = $('#g-name', root).value.trim();
      if (!name) return err(root, 'Serve un nome.');
      const patch = {
        name, plate: $('#g-plate', root).value.trim(),
        fuel: $('#g-fuel', root).value, tank: S.num($('#g-tank', root).value),
      };
      if (isNew) S.addVehicle(name, patch);
      else S.updateVehicle(v.id, patch);
      close();
      toast(isNew ? 'Veicolo creato' : 'Veicolo aggiornato');
    };
    const del = $('[data-x=del]', root);
    if (del) del.onclick = () => {
      confirmSheet(`Eliminare “${v.name}”?`,
        `Verranno cancellati anche i suoi ${v.entries.length} record. Esporta prima i dati se vuoi conservarli.`,
        'Elimina', () => { S.removeVehicle(v.id); close(); toast('Veicolo eliminato'); });
    };
  });
}

/* ---------- import / export ---------- */

function today() { return new Date().toISOString().slice(0, 10); }

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  S.markExported();
  toast('File esportato');
}

function onImportFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const text = String(fr.result || '');
    let preview;
    try {
      preview = previewImport(text);
    } catch (e) {
      return toast('File non leggibile: ' + e.message);
    }
    sheet(`
      <h2>Importa dati</h2>
      <p class="sheet-sub">${esc(file.name)}</p>
      <div class="card" style="margin-bottom:12px"><dl class="dl">
        <div><dt>Veicoli nel file</dt><dd>${preview.vehicles}</dd></div>
        <div><dt>Record</dt><dd>${preview.entries}</dd></div>
        <div><dt>Nomi</dt><dd style="font-weight:500">${esc(preview.names.join(', '))}</dd></div>
      </dl></div>
      ${note('info', 'ℹ',
        '<b>Unisci</b> aggiunge i record mancanti ai veicoli con lo stesso nome, saltando i duplicati. ' +
        '<b>Sostituisci</b> cancella tutto quello che c\'è ora e tiene solo il file.', null, null)}
      <button class="btn" data-x="merge">Unisci ai dati esistenti</button>
      <button class="btn danger" data-x="replace">Sostituisci tutto</button>
      <button class="btn sec" data-x="close">Annulla</button>
    `, (root, close) => {
      $('[data-x=close]', root).onclick = close;
      const run = (mode) => {
        try {
          const r = S.importData(text, mode);
          close();
          toast(`${r.entries} record importati` + (r.skipped ? `, ${r.skipped} duplicati saltati` : ''));
        } catch (e) { err(root, e.message); }
      };
      $('[data-x=merge]', root).onclick = () => run('merge');
      $('[data-x=replace]', root).onclick = () =>
        confirmSheet('Sostituire tutti i dati?',
          'Tutti i veicoli e i record attuali verranno eliminati e rimpiazzati con il contenuto del file.',
          'Sostituisci', () => run('replace'));
    });
  };
  fr.readAsText(file, 'utf-8');
}

function previewImport(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const o = JSON.parse(t);
    const vs = Array.isArray(o) ? [{ name: 'Importato', entries: o }] : o.vehicles || [];
    return { vehicles: vs.length, entries: vs.reduce((n, v) => n + (v.entries || []).length, 0), names: vs.map((v) => v.name || 'senza nome') };
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines[0] || '').toLowerCase();
  const hasV = /veicolo|vehicle/.test(head);
  const names = new Set();
  if (hasV) {
    const sep = head.includes(';') ? ';' : ',';
    const idx = head.split(sep).findIndex((h) => /veicolo|vehicle/.test(h));
    lines.slice(1).forEach((l) => { const c = l.split(sep)[idx]; if (c) names.add(c.replace(/"/g, '').trim()); });
  }
  return { vehicles: names.size || 1, entries: lines.length - 1, names: names.size ? [...names] : ['Importato'] };
}

/* ============================ PANNELLI E TOAST ============================ */

function sheet(html, wire) {
  const host = $('#modal');
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`;
  host.appendChild(bg);
  document.body.style.overflow = 'hidden';

  const close = () => {
    bg.remove();
    if (!host.children.length) document.body.style.overflow = '';
  };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  if (wire) wire(bg.querySelector('.sheet'), close);
  return close;
}

function confirmSheet(title, body, okLabel, onOk) {
  sheet(`
    <h2>${esc(title)}</h2>
    <p style="font-size:13.5px;color:var(--text-secondary);line-height:1.5;margin:0 0 16px">${esc(body)}</p>
    <button class="btn danger" data-x="ok">${esc(okLabel)}</button>
    <button class="btn sec" data-x="close">Annulla</button>
  `, (root, close) => {
    $('[data-x=close]', root).onclick = close;
    $('[data-x=ok]', root).onclick = () => { close(); onOk(); };
  });
}

let toastT = null;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 2600);
}

/* punto d'accesso per test e per i link interni */
window.APP = { app, show, openEntry, openDetail, openVehicle, recompute, toast };

})();
