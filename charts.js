/* charts.js — grafici su canvas, senza librerie esterne (l'app deve funzionare
 * offline anche al primo avvio). Due forme soltanto:
 *   - linea  → andamento nel tempo (consumo, prezzo al litro)
 *   - barre  → totali per mese solare (km, spesa, litri)
 * Ogni grafico ha il suo gemello in tabella, richiesto sia per accessibilità
 * sia perché alcuni colori non raggiungono 3:1 sul fondo chiaro.
 */

(function () {
'use strict';

const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

function tokens(el) {
  const cs = getComputedStyle(el);
  const g = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
  return {
    surface: g('--surface-1', '#fcfcfb'),
    ink: g('--text-primary', '#0b0b0b'),
    ink2: g('--text-secondary', '#52514e'),
    muted: g('--muted', '#898781'),
    grid: g('--grid', '#e1e0d9'),
    axis: g('--axis', '#c3c2b7'),
    s1: g('--series-1', '#2a78d6'),
    s2: g('--series-2', '#eb6834'),
    s3: g('--series-3', '#1baf7a'),
    warn: g('--status-warning', '#fab219'),
  };
}

function setupCanvas(canvas, cssW, cssH) {
  const r = DPR();
  canvas.width = Math.round(cssW * r);
  canvas.height = Math.round(cssH * r);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

/* scala "gradevole": passi 1/2/2.5/5 × 10^n */
function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

/* Etichetta con un velo del colore della superficie sotto: serve dove il testo
 * cade sopra la linea dei dati o sopra la griglia. Meglio di spostarla altrove,
 * perché la posizione dell'etichetta è informativa. */
function labelOn(ctx, text, x, y, T, opts = {}) {
  const pad = 3;
  const w = ctx.measureText(text).width;
  const h = opts.size || 11;
  const ax = ctx.textAlign;
  const lx = ax === 'right' ? x - w : ax === 'center' ? x - w / 2 : x;
  const ly = ctx.textBaseline === 'bottom' ? y - h : y - h / 2;
  ctx.save();
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = T.surface;
  ctx.fillRect(lx - pad, ly - 1, w + pad * 2, h + 3);
  ctx.restore();
  ctx.fillStyle = opts.color || T.ink;
  ctx.fillText(text, x, y);
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, Math.abs(h)));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/* ============================ GRAFICO A LINEA ============================ */
/**
 * @param {HTMLElement} host contenitore (position:relative)
 * @param {Object} cfg
 *   points: [{t:Date|ms, y:number, label:string, sub:string, flag:'warn'|null}]
 *   yFmt, unit, refLine {value,label}, color
 */
function line(host, cfg) {
  const canvas = host.querySelector('canvas');
  const tip = host.querySelector('.tip');
  const T = tokens(host);
  const pts = cfg.points.filter((p) => Number.isFinite(p.y));
  const W = host.clientWidth || 320;
  const H = cfg.height || 240;
  const ctx = setupCanvas(canvas, W, H);
  if (!pts.length) { emptyMsg(ctx, W, H, T); return; }

  const padL = cfg.padL ?? 44, padR = 12, padT = 14, padB = 26;
  const pw = Math.max(10, W - padL - padR);
  const ph = Math.max(10, H - padT - padB);

  const xs = pts.map((p) => +p.t);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ysAll = pts.map((p) => p.y).concat(cfg.refLine ? [cfg.refLine.value] : []);
  const { lo, hi, ticks } = niceTicks(Math.min(...ysAll), Math.max(...ysAll), cfg.yTicks || 4);

  const X = (t) => padL + (x1 === x0 ? pw / 2 : ((+t - x0) / (x1 - x0)) * pw);
  const Y = (v) => padT + ph - ((v - lo) / (hi - lo || 1)) * ph;

  // griglia orizzontale — hairline solide, mai tratteggiate
  ctx.lineWidth = 1;
  ctx.strokeStyle = T.grid;
  ctx.fillStyle = T.muted;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ticks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillText(cfg.yFmt ? cfg.yFmt(v) : String(v), padL - 6, y);
  }

  // asse x: etichette per anno
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const yearsSeen = new Set();
  for (const p of pts) {
    const y = new Date(+p.t).getFullYear();
    if (yearsSeen.has(y)) continue;
    yearsSeen.add(y);
    const x = X(p.t);
    if (x > padL + 12 && x < padL + pw - 12) {
      ctx.strokeStyle = T.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, padT); ctx.lineTo(Math.round(x) + 0.5, padT + ph); ctx.stroke();
    }
    ctx.fillStyle = T.muted;
    ctx.fillText(String(y), Math.min(Math.max(x, padL + 14), padL + pw - 14), padT + ph + 6);
  }

  // linea di riferimento (media): la riga va sotto ai dati, la sua etichetta
  // sopra a tutto — altrimenti la serie ci passa attraverso e diventa illeggibile
  if (cfg.refLine) {
    const y = Math.round(Y(cfg.refLine.value)) + 0.5;
    ctx.strokeStyle = T.axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
  }

  // linea dati — 2px
  const color = cfg.color || T.s1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.y)) : ctx.moveTo(X(p.t), Y(p.y))));
  ctx.stroke();

  // punti: anello di 2px del colore della superficie per separare le sovrapposizioni
  const rDot = pts.length > 40 ? 2.6 : 3.2;
  for (const p of pts) {
    const x = X(p.t), y = Y(p.y);
    ctx.beginPath(); ctx.arc(x, y, rDot + 2, 0, 7); ctx.fillStyle = T.surface; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rDot, 0, 7);
    ctx.fillStyle = p.flag === 'warn' ? T.warn : color;
    ctx.fill();
  }

  // etichetta diretta solo sull'ultimo punto (mai un numero su ogni punto)
  const last = pts[pts.length - 1];
  ctx.font = '600 11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const lx = Math.min(X(last.t) + 4, padL + pw);
  const lTxt = cfg.yFmt ? cfg.yFmt(last.y) : String(last.y);
  // sopra il punto, salvo che sia troppo in alto: allora sotto
  const ly = Y(last.y) - 9 < padT + 11 ? Y(last.y) + 20 : Y(last.y) - 9;
  labelOn(ctx, lTxt, lx, ly, T);

  if (cfg.refLine) {
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    labelOn(ctx, cfg.refLine.label, padL + 3, Math.round(Y(cfg.refLine.value)) - 1.5, T, { color: T.ink2, size: 10 });
  }

  attachHover(host, canvas, tip, {
    hit: (mx) => {
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d = Math.abs(X(p.t) - mx);
        if (d < bd) { bd = d; best = p; }
      }
      return bd <= 40 ? best : null;
    },
    pos: (p) => ({ x: X(p.t), y: Y(p.y) }),
    crosshair: { padT, ph, color: T.axis },
    ctx, W, H,
    redraw: () => line(host, cfg),
  });
}

/* ============================ GRAFICO A BARRE ============================ */
/**
 *   bars: [{label, value, partial:boolean, sub:string}]
 */
function bars(host, cfg) {
  const canvas = host.querySelector('canvas');
  const tip = host.querySelector('.tip');
  const T = tokens(host);
  const data = cfg.bars.filter((b) => Number.isFinite(b.value));
  const W = host.clientWidth || 320;
  const H = cfg.height || 220;
  const ctx = setupCanvas(canvas, W, H);
  if (!data.length) { emptyMsg(ctx, W, H, T); return; }

  const padL = cfg.padL ?? 44, padR = 10, padT = 14, padB = 30;
  const pw = Math.max(10, W - padL - padR);
  const ph = Math.max(10, H - padT - padB);

  const { lo, hi, ticks } = niceTicks(0, Math.max(...data.map((b) => b.value)), 4);
  const Y = (v) => padT + ph - ((v - lo) / (hi - lo || 1)) * ph;

  const slot = pw / data.length;
  const GAP = 2; // 2px di superficie fra barre adiacenti, mai un bordo
  const bw = Math.max(2, Math.min(slot - GAP, 34));

  ctx.lineWidth = 1;
  ctx.strokeStyle = T.grid;
  ctx.fillStyle = T.muted;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ticks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillText(cfg.yFmt ? cfg.yFmt(v) : String(v), padL - 6, y);
  }

  const color = cfg.color || T.s1;
  const base = Y(lo);
  data.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const y = Y(b.value);
    ctx.fillStyle = color;
    // il mese in corso è incompleto: si distingue per opacità E per etichetta,
    // mai solo col colore
    ctx.globalAlpha = b.partial ? 0.38 : 1;
    roundRectPath(ctx, x, y, bw, base - y, 4); // estremità arrotondata 4px, base ancorata
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  // asse x: etichette diradate per non farle collidere
  ctx.strokeStyle = T.axis;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(base) + 0.5); ctx.lineTo(padL + pw, Math.round(base) + 0.5); ctx.stroke();

  ctx.fillStyle = T.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // diradazione calcolata sulla larghezza reale del testo, ancorata all'ULTIMA
  // barra: così il mese più recente è sempre etichettato e la spaziatura resta
  // uniforme andando indietro.
  const wMax = Math.max(...data.map((b) => ctx.measureText(b.label).width));
  const every = Math.max(1, Math.ceil((data.length * (wMax + 12)) / pw));
  const lastI = data.length - 1;
  data.forEach((b, i) => {
    if ((lastI - i) % every !== 0) return;
    const w = ctx.measureText(b.label).width;
    let x = padL + i * slot + slot / 2;
    if (x - w / 2 < 2) return;                       // uscirebbe a sinistra
    x = Math.min(x, W - w / 2 - 2);                  // e non deve uscire a destra
    ctx.fillText(b.label, x, base + 6);
  });

  attachHover(host, canvas, tip, {
    hit: (mx) => {
      const i = Math.floor((mx - padL) / slot);
      return i >= 0 && i < data.length ? data[i] : null;
    },
    pos: (b) => {
      const i = data.indexOf(b);
      return { x: padL + i * slot + slot / 2, y: Y(b.value) };
    },
    ctx, W, H,
    redraw: () => bars(host, cfg),
  });
}

function emptyMsg(ctx, W, H, T) {
  ctx.fillStyle = T.muted;
  ctx.font = '13px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Dati non sufficienti', W / 2, H / 2);
}

/* ---------- interazione: hover / tocco con area di presa generosa ---------- */
function attachHover(host, canvas, tip, o) {
  if (!tip) return;
  let raf = null, current = null;

  const show = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const hit = o.hit(cx);
    if (!hit) return hide();
    if (hit === current) return;
    current = hit;
    const p = o.pos(hit);
    tip.innerHTML =
      '<b>' + esc(hit.label) + '</b>' + (hit.sub ? '<span>' + hit.sub + '</span>' : '');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = p.x - tw / 2;
    left = Math.max(4, Math.min(left, host.clientWidth - tw - 4));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(2, p.y - tip.offsetHeight - 12) + 'px';

    if (o.crosshair && !raf) {
      raf = requestAnimationFrame(() => {
        raf = null;
        o.redraw();
        const c = canvas.getContext('2d');
        c.save();
        c.strokeStyle = o.crosshair.color;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(Math.round(p.x) + 0.5, o.crosshair.padT);
        c.lineTo(Math.round(p.x) + 0.5, o.crosshair.padT + o.crosshair.ph);
        c.stroke();
        c.restore();
      });
    }
  };
  const hide = () => {
    if (current === null) return;
    current = null;
    tip.hidden = true;
    if (o.crosshair) o.redraw();
  };

  canvas.onpointermove = show;
  canvas.onpointerdown = show;
  canvas.onpointerleave = hide;
  canvas.onpointercancel = hide;
  host.onpointerleave = hide;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.CHARTS = { line, bars };

})();
