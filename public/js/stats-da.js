/**
 * DA « Atelier » : rendus dessinés de la page Stats. Présentation seule.
 *
 * Chaque fonction reçoit des données déjà calculées par stats.js (mêmes
 * chiffres que les graphiques ECharts d'origine) et les dessine à la main
 * dans le conteneur. Sans la DA, stats.js garde ses graphiques ECharts.
 */
import {
  sheet, el, text, path, line, curve, rectD, lineD, loopD, blotD, polyD, smooth,
  motifFill, boil, tooltip, j,
} from './da-sketch.js?v=20261115c';
import { motifOf, CRAYONS, MOTIF_SHAPES } from './motifs.js';

/** Largeur de dessin : celle du conteneur, bornée (le texte garde sa taille) */
const widthOf = (dom, min, max) => Math.round(Math.max(min, Math.min(max, dom.clientWidth || max)));
const ME = () => localStorage.getItem('versant_athlete_id') || '';
const nf = v => Math.round(v).toLocaleString('fr-FR');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Sports : une couleur de la palette chacun (tokens.css), en aplat. Les
   motifs sont réservés aux joueurs. */
export const SPORT_STYLE = {
  Run: { label: 'Course', color: 'var(--sport-run)' },
  Bike: { label: 'Vélo', color: 'var(--sport-bike)' },
  Hike: { label: 'Rando', color: 'var(--sport-hike)' },
  Ski: { label: 'Ski', color: 'var(--sport-ski)' },
  Autre: { label: 'Autre', color: 'var(--sub)' },
};
const sportStyle = s => SPORT_STYLE[s] || { label: s, color: 'var(--sub)' };
function athleteFill(svg, id, own) {
  const m = motifOf(id) || { motif: 9, crayon: 0 };
  return motifFill(svg, m.motif, CRAYONS[m.crayon], own);
}
const crayonOf = id => `var(${CRAYONS[(motifOf(id) || { crayon: 0 }).crayon]})`;

/** Forme remplie d'un motif (ou d'une couleur), contour repassé, qui bout au survol */
function filledBox(svg, g, x, y, w, h, fill, opts = {}) {
  const grp = el('g', { class: 'sk-hit' + (opts.cls ? ' ' + opts.cls : '') }, g);
  el('path', { d: polyD([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), class: 'sk-fill',
    ...(fill.color ? { style: `fill: ${fill.color}`, 'fill-opacity': opts.alpha ?? .85 } : { fill: fill.url }) }, grp);
  const make = () => rectD(x, y, w, h, .6, 2, opts.base !== false);
  const o = path(grp, make(), 'sk-ink', opts.w || 1.3);
  boil(grp, { patterns: fill.el ? [fill.el] : [], outlines: [{ el: o, make }] });
  return grp;
}
/** Coup de marqueur posé sous un texte (largeur estimée) */
function markUnder(g, cx, y, len, h = 15) {
  const t = j(1.6), l = Math.max(4, len - h);
  path(g, lineD(cx - l / 2, y + t, cx + l / 2, y - t, .6, 0), 'sk-mk', h, false);
}

/* ============================================================
   RÉPARTITION PAR SPORT : une bande découpée, des cotes d'atelier
   ============================================================ */
export function drawSportBand(dom, entries) {
  const total = entries.reduce((s, e) => s + e.value, 0) || 1;
  const W = widthOf(dom, 320, 720), x0 = 16, x1 = W - 16, y = 72, h = 46, ty = 206, th = 30;
  const H = ty + entries.length * th + 6;
  const { svg, g } = sheet(dom, W, H, 'sk-band');
  const tip = tooltip(dom);
  let x = x0;
  entries.forEach((e, i) => {
    const st = sportStyle(e.name), w = (x1 - x0) * e.value / total, pct = Math.round(e.value / total * 100);
    const grp = filledBox(svg, g, x, y, w, h, { color: st.color }, { w: 1.5 });
    grp.addEventListener('pointermove', ev => tip.show(`<b>${st.label}</b><br>${nf(e.value)} m de D+ · ${pct} %`, ev));
    grp.addEventListener('pointerleave', () => tip.hide());
    // Cote : au-dessus pour les parts paires, en dessous pour les autres
    const up = i % 2 === 0, cy = up ? y - 18 : y + h + 18, cls = 'sk-pen';
    if (w > 14) {
      line(g, x + 2, cy - 5, x + 2, cy + 5, { cls, w: 1, over: 0 });
      line(g, x + w - 2, cy - 5, x + w - 2, cy + 5, { cls, w: 1, over: 0 });
      line(g, x + 4, cy, x + w - 4, cy, { cls, w: 1, over: 0 });
    }
    text(g, x + w / 2, up ? cy - 8 : cy + 20, `${pct} %`, 'sk-hand', 'middle');
    text(g, x + w / 2, up ? cy - 30 : cy + 40, st.label.toUpperCase(), 'sk-lbl sk-lbl--ink', 'middle');
    x += w;
  });
  // Relevé : le D+ de chaque sport, comme une liste en marge
  const tx1 = Math.min(x1, x0 + 360);
  entries.forEach((e, i) => {
    const st = sportStyle(e.name), ry = ty + i * th;
    el('rect', { x: x0, y: ry - 11, width: 22, height: 12, style: `fill: ${st.color}`, class: 'sk-swatch' }, g);
    text(g, x0 + 32, ry, st.label.toUpperCase(), 'sk-lbl sk-lbl--ink');
    text(g, tx1, ry + 1, nf(e.value) + ' m', 'sk-hand-ink', 'end');
    line(g, x0, ry + 9, tx1, ry + 9, { cls: 'sk-faint', w: 1, amp: .3, over: 0, draw: false });
  });
}

/* ============================================================
   CLASSEMENT D+ : barres couchées, au motif de chaque joueur
   ============================================================ */
export function drawRankingBars(dom, stats, nameOf) {
  const me = ME(), rh = 20, gap = 9, W = widthOf(dom, 320, 720), x0 = W < 420 ? 118 : 150, x1 = W - 84;
  const H = 14 + stats.length * (rh + gap);
  const { svg, g } = sheet(dom, W, H, 'sk-rank');
  const tip = tooltip(dom);
  const max = stats[0]?.total_elevation || 1;
  line(g, x0, 6, x0, H - 4, { w: 1.5, passes: 2, over: 2 });
  stats.forEach((s, i) => {
    const y = 10 + i * (rh + gap), w = Math.max(3, (x1 - x0) * s.total_elevation / max), isMe = String(s.id) === me;
    if (isMe) path(g, lineD(x0 + 2, y + rh / 2, x0 + w + 6, y + rh / 2, .5, 0), 'sk-mk sk-mk--flat', rh + 8);
    text(g, x0 - 12, y + 14, `${i + 1}. ${nameOf(s.id)}`.toUpperCase(), isMe ? 'sk-lbl sk-lbl--me' : 'sk-lbl sk-lbl--ink', 'end');
    const grp = filledBox(svg, g, x0, y, w, rh, athleteFill(svg, s.id, true));
    grp.addEventListener('pointermove', ev => tip.show(`<b>${esc(nameOf(s.id))}</b><br>${nf(s.total_elevation)} m de D+`, ev));
    grp.addEventListener('pointerleave', () => tip.hide());
    text(g, x0 + w + 10, y + 16, nf(s.total_elevation) + ' m', isMe ? 'sk-hand-acc' : 'sk-hand-ink');
  });
}

/* ============================================================
   CALENDRIER : un point d'encre par jour, plus gros quand on a grimpé
   ============================================================ */
export function drawCalendarDots(dom, dailyEl, startStr, endStr) {
  if ((dom.clientWidth || 1000) < 560) return drawCalendarMonths(dom, dailyEl, startStr, endStr);
  const day = 86400000, start = new Date(startStr + 'T00:00:00Z'), end = new Date(endStr + 'T00:00:00Z');
  const lun = new Date(start); lun.setUTCDate(lun.getUTCDate() - ((lun.getUTCDay() + 6) % 7));
  const cols = Math.ceil(((end - lun) / day + 1) / 7);
  const s = 17, x0 = 34, y0 = 34, W = x0 + cols * s + 12, H = y0 + 7 * s + 58;
  const { g } = sheet(dom, W, H, 'sk-cal sk-wide');
  const tip = tooltip(dom);
  const vals = Object.values(dailyEl), max = Math.max(...vals, 1);
  const today = new Date().toISOString().slice(0, 10);
  let best = null;
  for (const [d, v] of Object.entries(dailyEl)) if (!best || v > best[1]) best = [d, v];
  ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach((d, r) => text(g, x0 - 10, y0 + r * s + 12, d, 'sk-lbl', 'end'));
  const MOIS = ['JANV', 'FÉV', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC'];
  const radius = v => 1.3 + (s / 2 - 2.2) * Math.sqrt(v / max);
  const cells = [];
  for (let t = +start; t <= +end; t += day) {
    const d = new Date(t), key = d.toISOString().slice(0, 10);
    const c = Math.floor((t - lun) / day / 7), r = (d.getUTCDay() + 6) % 7;
    const cx = x0 + c * s + s / 2, cy = y0 + r * s + s / 2, v = dailyEl[key] || 0;
    if (d.getUTCDate() === 1 || t === +start) text(g, x0 + c * s, y0 - 12, MOIS[d.getUTCMonth()], 'sk-lbl');
    cells.push({ key, c, r, v });
    if (key > today) {
      const k = 2.2;
      line(g, cx - k, cy - k, cx + k, cy + k, { cls: 'sk-faint', w: 1, over: 0, amp: .2, draw: false });
      line(g, cx - k, cy + k, cx + k, cy - k, { cls: 'sk-faint', w: 1, over: 0, amp: .2, draw: false });
      continue;
    }
    if (!v) { line(g, cx - 1.8, cy, cx + 1.8, cy, { cls: 'sk-pencil', w: 1, over: 0, amp: .2, draw: false }); continue; }
    el('path', { d: blotD(cx, cy, radius(v)), class: best && key === best[0] ? 'sk-dot-acc' : 'sk-dot' }, g);
  }
  if (best) {
    const b = cells.find(x => x.key === best[0]);
    const cx = x0 + b.c * s + s / 2, cy = y0 + b.r * s + s / 2;
    path(g, loopD(cx, cy, 11, 11), 'sk-pen', 1.6);
    const lbl = `${nf(best[1])} m, le ${new Date(best[0] + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
    const lx = Math.min(Math.max(cx, x0 + 90), W - 3 * 86 - 110);
    text(g, lx, y0 + 7 * s + 30, lbl, 'sk-hand', 'middle');
    line(g, lx, y0 + 7 * s + 14, cx, cy + 12, { cls: 'sk-pen', w: 1.2, over: 0 });
  }
  // Légende : trois tailles de point et leur valeur
  const lx = W - 12 - 3 * 86, ly = y0 + 7 * s + 34;
  [0.15, 0.45, 1].forEach((k, i) => {
    el('path', { d: blotD(lx + 8 + i * 86, ly - 4, radius(max * k)), class: 'sk-dot' }, g);
    text(g, lx + 20 + i * 86, ly + 1, nf(max * k) + ' M', 'sk-lbl');
  });
  // Survol : la case sous le pointeur
  const hit = el('rect', { x: x0, y: y0, width: cols * s, height: 7 * s, fill: 'transparent' }, g);
  hit.addEventListener('pointermove', ev => {
    const p = svgPoint(hit, ev), c = Math.floor((p.x - x0) / s), r = Math.floor((p.y - y0) / s);
    const cell = cells.find(x => x.c === c && x.r === r);
    if (!cell || cell.key > today) return tip.hide();
    const lbl = new Date(cell.key + 'T00:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    tip.show(`<b>${lbl}</b><br>${cell.v ? nf(cell.v) + ' m de D+' : 'aucune sortie'}`, ev);
  });
  hit.addEventListener('pointerleave', () => tip.hide());
}
/** Calendrier sur écran étroit : une ligne par mois, une colonne par jour du mois */
function drawCalendarMonths(dom, dailyEl, startStr, endStr) {
  const day = 86400000, start = new Date(startStr + 'T00:00:00Z'), end = new Date(endStr + 'T00:00:00Z');
  const months = [];
  for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); m <= end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) months.push(m);
  const W = widthOf(dom, 280, 560), x0 = 42, s = (W - x0 - 6) / 31, rh = Math.max(15, s + 4), y0 = 24;
  const H = y0 + months.length * rh + 52;
  const { g } = sheet(dom, W, H, 'sk-cal-m');
  const tip = tooltip(dom);
  const vals = Object.values(dailyEl), max = Math.max(...vals, 1);
  const today = new Date().toISOString().slice(0, 10);
  let best = null;
  for (const [d, v] of Object.entries(dailyEl)) if (!best || v > best[1]) best = [d, v];
  const MOIS = ['JANV', 'FÉV', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC'];
  const radius = v => 1 + (Math.min(s, rh) / 2 - 1.4) * Math.sqrt(v / max);
  [1, 10, 20, 31].forEach(d => text(g, x0 + (d - 1) * s + s / 2, y0 - 10, String(d), 'sk-lbl', 'middle'));
  const cells = [];
  months.forEach((m, r) => {
    const cy = y0 + r * rh + rh / 2;
    text(g, x0 - 8, cy + 4, MOIS[m.getUTCMonth()], 'sk-lbl', 'end');
    const len = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
    for (let d = 1; d <= len; d++) {
      const t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), d);
      if (t < +start || t > +end) continue;
      const key = new Date(t).toISOString().slice(0, 10), v = dailyEl[key] || 0, cx = x0 + (d - 1) * s + s / 2;
      cells.push({ key, r, d, v });
      if (key > today) continue;
      if (!v) { line(g, cx - 1.2, cy, cx + 1.2, cy, { cls: 'sk-pencil', w: 1, over: 0, amp: .1, draw: false }); continue; }
      el('path', { d: blotD(cx, cy, radius(v)), class: best && key === best[0] ? 'sk-dot-acc' : 'sk-dot' }, g);
    }
  });
  if (best) {
    const b = cells.find(x => x.key === best[0]);
    if (b) {
      const cx = x0 + (b.d - 1) * s + s / 2, cy = y0 + b.r * rh + rh / 2;
      path(g, loopD(cx, cy, 8, 8), 'sk-pen', 1.4);
      const lbl = `record : ${nf(best[1])} m, le ${new Date(best[0] + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
      text(g, W / 2, H - 16, lbl, 'sk-hand', 'middle');
    }
  }
  const hit = el('rect', { x: x0, y: y0, width: 31 * s, height: months.length * rh, fill: 'transparent' }, g);
  hit.addEventListener('pointermove', ev => {
    const p = svgPoint(hit, ev), d = Math.floor((p.x - x0) / s) + 1, r = Math.floor((p.y - y0) / rh);
    const cell = cells.find(x => x.d === d && x.r === r);
    if (!cell || cell.key > today) return tip.hide();
    const lbl = new Date(cell.key + 'T00:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    tip.show(`<b>${lbl}</b><br>${cell.v ? nf(cell.v) + ' m de D+' : 'aucune sortie'}`, ev);
  });
  hit.addEventListener('pointerleave', () => tip.hide());
}
function svgPoint(node, ev) {
  const svg = node.ownerSVGElement, p = svg.createSVGPoint();
  p.x = ev.clientX; p.y = ev.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

/* ============================================================
   BARRES (semaines, mois) : hachurées, la meilleure en croisillons
   ============================================================ */
export function drawHatchBars(dom, items) {
  const W = widthOf(dom, 300, 640), H = 170, x0 = 8, x1 = W - 8, yb = 140, yt = 18, n = items.length;
  const { svg, g } = sheet(dom, W, H, 'sk-bars');
  const tip = tooltip(dom);
  const max = Math.max(...items.map(i => i.value), 1), slot = (x1 - x0) / n, bw = slot * (n > 20 ? .62 : .7);
  const bestI = items.reduce((b, it, i) => it.value > items[b].value ? i : b, 0);
  line(g, x0 - 4, yb, x1 + 4, yb, { w: 1.5, passes: 2 });
  items.forEach((it, i) => {
    const x = x0 + i * slot + (slot - bw) / 2, h = (yb - yt) * it.value / max;
    if (h >= 1) {
      const fill = i === bestI ? motifFill(svg, 1, '--ink', true) : { color: 'transparent' };
      const grp = filledBox(svg, g, x, yb - h, bw, h, fill, { base: false, w: 1.1 });
      grp.addEventListener('pointermove', ev => tip.show(it.tip, ev));
      grp.addEventListener('pointerleave', () => tip.hide());
    }
    // Mois : trois lettres si elles tiennent dans la colonne, sinon l'initiale
    if (it.tick) text(g, x + bw / 2, yb + 16, (slot < it.tick.length * 9 + 4 && /^\D/.test(it.tick) ? it.tick[0] : it.tick).toUpperCase(), 'sk-lbl', 'middle');
    if (i === bestI && it.value) {
      const cx = Math.max(x0 + 34, Math.min(x1 - 34, x + bw / 2));
      markUnder(g, cx, yb - h - 12, it.best.length * 8.2 + 10, 16);
      text(g, cx, yb - h - 7, it.best, 'sk-hand-ink', 'middle');
    }
  });
}

/* ============================================================
   2025 CONTRE 2026 : crayon fin, quadrillage du carnet
   ============================================================ */
export function drawCompare(dom, s2025, s2026, t2025, t2026, athleteId) {
  // Écran étroit : à la largeur de l'écran, repères allégés (un mois sur trois, milliers en K)
  const compact = (dom.clientWidth || 1000) < 560;
  const W = compact ? widthOf(dom, 280, 560) : widthOf(dom, 560, 1000);
  const H = compact ? 300 : 380, X0 = compact ? 46 : 84, X1 = W - (compact ? 14 : 70), Y0 = H - 50, Y1 = 26;
  const { g } = sheet(dom, W, H, compact ? 'sk-compare' : 'sk-compare sk-wide');
  const tip = tooltip(dom);
  const doy = md => { const [m, d] = md.split('-').map(Number); return (Date.UTC(2025, m - 1, d) - Date.UTC(2025, 0, 1)) / 86400000; };
  const oneYear = s => { const out = []; for (const p of s) { if (out.length && doy(p.x) < doy(out[out.length - 1].x)) break; out.push(p); } return out; };
  s2025 = oneYear(s2025); s2026 = oneYear(s2026);
  const all = [...s2025, ...s2026];
  if (!all.length) return;
  const dmin = Math.min(...all.map(p => doy(p.x))), dmax = Math.max(364, ...all.map(p => doy(p.x)));
  const ymaxRaw = Math.max(...all.map(p => p.y), 1);
  const stepY = niceStep(ymaxRaw / 4), ymax = Math.ceil(ymaxRaw / stepY) * stepY;
  const sx = d => X0 + (X1 - X0) * (d - dmin) / (dmax - dmin || 1), sy = v => Y0 - (Y0 - Y1) * v / ymax;
  for (let v = stepY; v <= ymax; v += stepY) {
    line(g, X0, sy(v), X1, sy(v), { cls: 'sk-faint', w: 1, amp: .5, over: 0, draw: false });
    text(g, X0 - (compact ? 6 : 10), sy(v) + 4, compact && v >= 1000 ? nf(v / 1000) + 'K' : nf(v) + ' M', 'sk-lbl sk-lbl--ink', 'end');
  }
  line(g, X0, Y0, X0, Y1, { cls: 'sk-pencil', w: 1.2, amp: .6 });
  line(g, X0, Y0, X1, Y0, { cls: 'sk-pencil', w: 1.2, amp: .6 });
  const MOIS = ['JANV', 'FÉV', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC'];
  MOIS.forEach((m, i) => { const d = (Date.UTC(2025, i, 1) - Date.UTC(2025, 0, 1)) / 86400000; if (d >= dmin && d <= dmax && (!compact || i % 3 === 0)) text(g, sx(d), Y0 + 22, m, 'sk-lbl', 'middle'); });
  const pts = s => s.filter((p, i) => i % 3 === 0 || i === s.length - 1).map(p => [sx(doy(p.x)), sy(p.y)]);
  const color = athleteId ? crayonOf(athleteId) : null;
  if (s2025.length > 1) curve(g, pts(s2025), { cls: 'sk-pencil', w: 1.3, amp: .5, step: 40 });
  if (s2026.length > 1) {
    path(g, smooth(pts(s2026)), 'sk-mk', 11);
    const c = curve(g, pts(s2026), { cls: 'sk-ink', w: 1.9, amp: .5, step: 40 });
    if (color) c.forEach(p => p.style.stroke = color);
  }
  const end = (s, cls, dy) => { if (!s.length) return; const p = s[s.length - 1], x = sx(doy(p.x)), y = sy(p.y); return [x, y, cls, dy]; };
  const e26 = end(s2026), e25 = end(s2025);
  if (e26) {
    path(g, loopD(e26[0], e26[1], 8, 8), 'sk-ink', 1.2);
    text(g, e26[0] - 14, e26[1] - 26, t2026, 'sk-hand-ink', 'end');
    text(g, e26[0] - 14, e26[1] - 8, nf(s2026[s2026.length - 1].y) + ' m', 'sk-hand-acc', 'end');
  }
  if (e25) {
    text(g, Math.min(e25[0], X1) - 4, e25[1] + 22, t2025, 'sk-hand-s', 'end');
    text(g, Math.min(e25[0], X1) - 4, e25[1] + 40, nf(s2025[s2025.length - 1].y) + ' m', 'sk-hand-s', 'end');
  }
  // Survol : une règle verticale et les deux valeurs du jour
  const rule = el('path', { class: 'sk-rule', d: '' }, g);
  const hit = el('rect', { x: X0, y: Y1, width: X1 - X0, height: Y0 - Y1, fill: 'transparent' }, g);
  const at = (s, d) => { let v = null; for (const p of s) { if (doy(p.x) <= d) v = p.y; else break; } return v; };
  hit.addEventListener('pointermove', ev => {
    const p = svgPoint(hit, ev), d = Math.round(dmin + (p.x - X0) / (X1 - X0) * (dmax - dmin));
    rule.setAttribute('d', `M${sx(d)} ${Y1} L${sx(d)} ${Y0}`);
    const date = new Date(Date.UTC(2025, 0, 1) + d * 86400000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const a = at(s2025, d), b = at(s2026, d);
    tip.show(`<b>${date}</b>` + (b != null ? `<br>${esc(t2026)} : ${nf(b)} m` : '') + (a != null ? `<br>${esc(t2025)} : ${nf(a)} m` : ''), ev);
  });
  hit.addEventListener('pointerleave', () => { tip.hide(); rule.setAttribute('d', ''); });
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/* ============================================================
   ÉVOLUTION DES POINTS : lignes au crayon, noms au bout,
   ta ligne repassée au feutre sur un coup de marqueur
   ============================================================ */
export function drawPoints(dom, seasons, byAthlete, mode, selectedId, tipFor) {
  const ids = Object.keys(byAthlete), me = ME();
  const focus = selectedId || (ids.includes(me) ? me : '');
  // Écran étroit : à la largeur de l'écran, prénoms seuls au bout des lignes
  const compact = (dom.clientWidth || 1000) < 560;
  const W = compact ? widthOf(dom, 280, 560) : widthOf(dom, 560, 1000);
  const X0 = compact ? 40 : 64, X1 = W - (compact ? 78 : 150), Y1 = 30;
  const shortName = nm => compact ? String(nm).split(' ')[0] : nm;
  const rank = mode !== 'cumulative';
  const n = seasons.length;
  const valOf = (id, i) => rank ? byAthlete[id].ranks[i]?.rank : byAthlete[id].cumulative[i]?.points;
  const maxV = rank ? ids.length : Math.max(1, ...ids.flatMap(id => seasons.map((_, i) => valOf(id, i) || 0)));
  const H = rank ? Math.max(360, 40 + ids.length * 24) : 420, Y0 = H - 44;
  const { svg, g } = sheet(dom, W, H, compact ? 'sk-points' : 'sk-points sk-wide');
  const tip = tooltip(dom);
  const sx = i => n === 1 ? (X0 + X1) / 2 : X0 + (X1 - X0) * i / (n - 1);
  const sy = v => rank ? Y1 + (Y0 - Y1) * (v - 1) / Math.max(1, maxV - 1) : Y0 - (Y0 - Y1) * v / maxV;
  // Échelles
  seasons.forEach((s, i) => { if (!compact || n <= 6 || i % 2 === 0 || i === n - 1) text(g, sx(i), H - 16, (compact ? 'S' : 'SAISON ') + s, 'sk-lbl', 'middle'); });
  if (rank) {
    for (let r = 1; r <= maxV; r += maxV > 12 ? 2 : 1) text(g, X0 - (compact ? 12 : 26), sy(r) + 4, r + 'E', 'sk-lbl', 'end');
  } else {
    const st = niceStep(maxV / 4);
    for (let v = st; v <= maxV; v += st) {
      line(g, X0, sy(v), X1, sy(v), { cls: 'sk-faint', w: 1, amp: .4, over: 0, draw: false });
      text(g, X0 - (compact ? 6 : 12), sy(v) + 4, nf(v) + (compact ? '' : ' PTS'), 'sk-lbl', 'end');
    }
    line(g, X0, Y0, X1 + 10, Y0, { cls: 'sk-pencil', w: 1.2 });
  }
  // Noms au bout des lignes, écartés pour ne pas se chevaucher
  const ends = ids.map(id => ({ id, y: sy(valOf(id, n - 1) || (rank ? maxV : 0)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  const order = [...ids].sort((a, b) => (a === focus) - (b === focus));   // ta ligne dessinée en dernier
  order.forEach(id => {
    const info = byAthlete[id], hot = id === focus, faded = selectedId && !hot;
    const pts = seasons.map((_, i) => valOf(id, i)).map((v, i) => v == null ? null : [sx(i), sy(v)]).filter(Boolean);
    if (!pts.length) return;
    const grp = el('g', { class: 'sk-line' + (hot ? ' is-focus' : '') + (faded ? ' is-faded' : '') }, g);
    grp.style.setProperty('--line', crayonOf(id));
    if (hot) path(grp, smooth(pts), 'sk-mk', 12);
    if (pts.length > 1) curve(grp, pts, { cls: hot ? 'sk-ink' : 'sk-line__stroke', w: hot ? 2.4 : 1.3, amp: .5, passes: hot ? 2 : 1 });
    pts.forEach((p, i) => {
      const dot = el('path', { d: hot ? blotD(p[0], p[1], 3.4) : loopD(p[0], p[1], 3, 3), class: hot ? 'sk-dot' : 'sk-line__dot' }, grp);
      const hit = el('circle', { cx: p[0], cy: p[1], r: 9, fill: 'transparent' }, grp);
      hit.addEventListener('pointermove', ev => tip.show(tipFor(id, i), ev));
      hit.addEventListener('pointerleave', () => tip.hide());
      void dot;
    });
    const e = ends.find(x => x.id === id);
    text(grp, X1 + (compact ? 8 : 14), e.y + 5, shortName(info.name), hot ? 'sk-hand-acc' : 'sk-line__name');
    // Toute la ligne s'allume au survol de son nom ou de son tracé
    grp.addEventListener('pointerenter', () => grp.classList.add('is-hot'));
    grp.addEventListener('pointerleave', () => grp.classList.remove('is-hot'));
  });
  void svg;
}

/* ============================================================
   MONEY TIME : une barre par athlète, des motifs de plus en plus
   serrés du J1 au J5, la dernière ligne droite au marqueur
   ============================================================ */
export const MONEY_STYLE = [
  { color: 'var(--mt-1)' }, { color: 'var(--mt-2)' }, { color: 'var(--mt-3)' },
  { color: 'var(--mt-4)' }, { color: 'var(--mt-5)' }, { mk: true },
];
export function drawMoneyTime(dom, entries, labels, tipFor) {
  // Écran étroit : à la largeur de l'écran, prénoms seuls, légende sur plusieurs lignes
  const compact = (dom.clientWidth || 1000) < 560;
  const me = ME(), rh = 18, gap = 8;
  const W = compact ? widthOf(dom, 280, 560) : widthOf(dom, 560, 1000);
  const x0 = compact ? 92 : 170, x1 = W - (compact ? 50 : 80);
  // Légende (place calculée d'abord : elle peut passer sur plusieurs lignes)
  const legend = [];
  let lx = compact ? 8 : x0, ly = 0;
  labels.forEach((l, i) => {
    const wl = 40 + l.length * 7.4;
    if (lx + wl > W && lx > 8) { lx = compact ? 8 : x0; ly += 22; }
    legend.push([l, i, lx, ly]);
    lx += wl;
  });
  const top = 38 + ly;
  const H = top + 26 + entries.length * (rh + gap);
  const { svg, g } = sheet(dom, W, H, compact ? 'sk-money' : 'sk-money sk-wide');
  const tip = tooltip(dom);
  legend.forEach(([l, i, x, dy]) => {
    const st = MONEY_STYLE[i];
    if (st.mk) path(g, lineD(x, 14 + dy, x + 22, 14 + dy, .4, 0), 'sk-mk sk-mk--flat', 12, false);
    else el('rect', { x, y: 8 + dy, width: 22, height: 12, class: 'sk-swatch', style: `fill: ${st.color}` }, g);
    text(g, x + 28, 18 + dy, l.toUpperCase(), 'sk-lbl');
  });
  entries.forEach((e, r) => {
    const y = top + r * (rh + gap), isMe = String(e.id) === me;
    const name = compact ? String(e.name).split(' ')[0] : e.name;
    text(g, x0 - (compact ? 8 : 12), y + 13, name.toUpperCase(), isMe ? 'sk-lbl sk-lbl--me' : 'sk-lbl sk-lbl--ink', 'end');
    let x = x0;
    e.pct.forEach((p, i) => {
      const w = (x1 - x0) * p / 100;
      if (w < .5) return;
      const st = MONEY_STYLE[i];
      const grp = el('g', { class: 'sk-hit' }, g);
      if (st.mk) path(grp, lineD(x, y + rh / 2, x + w, y + rh / 2, .3, 0), 'sk-mk sk-mk--solid sk-mk--flat', rh, false);
      else {
        el('path', { d: polyD([[x, y], [x + w, y], [x + w, y + rh], [x, y + rh]]), style: `fill: ${st.color}` }, grp);
        if (x > x0) path(grp, lineD(x, y + 1, x, y + rh - 1, .3, 0), 'sk-ink', .8, false);
      }
      el('path', { d: polyD([[x, y], [x + w, y], [x + w, y + rh], [x, y + rh]]), fill: 'transparent' }, grp);
      grp.addEventListener('pointermove', ev => tip.show(tipFor(e, i), ev));
      grp.addEventListener('pointerleave', () => tip.hide());
      x += w;
    });
    path(g, rectD(x0, y, x1 - x0, rh, .5, 2), 'sk-ink', 1.1);
    text(g, x1 + (compact ? 6 : 12), y + 15, e.pct[5].toFixed(compact ? 0 : 1).replace('.', ',') + ' %', isMe ? 'sk-hand-acc' : 'sk-hand-ink');
  });
}

/* ============================================================
   RYTHMES : courbes de crêtes, chaque crête remplie de son motif
   ============================================================ */
export function drawRidgeline(dom, keys, valsByKey, styleOf, labelOf, unitTip) {
  // Écran étroit : largeur de l'écran, une valeur par heure (les tendances,
  // pas le quart d'heure), repères toutes les 6 h. Pas de défilement.
  const compact = (dom.clientWidth || 1000) < 560;
  if (compact) {
    const hourly = {};
    keys.forEach(k => { hourly[k] = Array.from({ length: 24 }, (_, h) => valsByKey[k].slice(h * 4, h * 4 + 4).reduce((s, v) => s + v, 0)); });
    valsByKey = hourly;
    unitTip = (k, h) => `<b>${h} h – ${h + 1} h</b><br>${labelOf(k)} : ${Math.round(valsByKey[k][h] * 60)} min`;
  }
  const W = compact ? widthOf(dom, 280, 560) : widthOf(dom, 560, 1000);
  const X0 = compact ? 66 : 110, X1 = W - (compact ? 12 : 24), step = compact ? 34 : 46, amp = compact ? 80 : 120;
  const H = 40 + amp + step * (keys.length - 1) + 40, base0 = 30 + amp;
  const { svg, g } = sheet(dom, W, H, compact ? 'sk-ridge' : 'sk-ridge sk-wide');
  const tip = tooltip(dom);
  const n = valsByKey[keys[0]].length, max = Math.max(1e-9, ...keys.flatMap(k => valsByKey[k]));
  const sx = i => X0 + (X1 - X0) * i / (n - 1);
  // Curseur : un trait orange vertical au moment pointé (ou touché)
  const cursor = el('line', { x1: X0, x2: X0, y1: 22, y2: H - 30, class: 'sk-cursor', visibility: 'hidden' }, svg);
  for (let h = 0; h <= 24; h += compact ? 6 : 2) {
    const x = X0 + (X1 - X0) * h / 24;
    line(g, x, 24, x, H - 34, { cls: 'sk-faint', w: 1, amp: .4, over: 0, draw: false });
    text(g, x, H - 14, h + 'H', 'sk-lbl', 'middle');
  }
  // Du fond (en haut) vers l'avant (en bas) : les crêtes du bas passent devant
  keys.map((k, i) => [k, i]).reverse().forEach(([k, i]) => {
    const base = base0 + step * (keys.length - 1 - i), st = styleOf(k);
    // Tous les quarts d'heure, sans lissage : les pics restent marqués
    const thin = valsByKey[k].map((v, x) => [sx(x), base - amp * v / max]);
    const grp = el('g', { class: 'sk-hit' }, g);
    const fill = st.color ? null : motifFill(svg, st.motif, st.crayon, true);
    el('path', { d: smooth(thin) + ` L${X1} ${base} L${X0} ${base} Z`, class: 'sk-ridge__paper' }, grp);
    el('path', { d: smooth(thin) + ` L${X1} ${base} L${X0} ${base} Z`, ...(fill ? { fill: fill.url } : { style: `fill: ${st.color}`, 'fill-opacity': .55 }) }, grp);
    const make = () => smooth(wob2(thin));
    const o = path(grp, make(), 'sk-ink', 1.5);
    line(grp, X0, base, X1, base, { cls: 'sk-pencil', w: 1, over: 0, amp: .4, draw: false });
    text(g, X0 - (compact ? 8 : 12), base - 4, labelOf(k).toUpperCase(), 'sk-lbl sk-lbl--ink', 'end');
    boil(grp, { patterns: fill ? [fill.el] : [], outlines: [{ el: o, make }] });
    grp.addEventListener('pointermove', ev => {
      const p = svgPoint(grp, ev), x = Math.max(0, Math.min(n - 1, Math.round((p.x - X0) / (X1 - X0) * (n - 1))));
      cursor.setAttribute('x1', sx(x)); cursor.setAttribute('x2', sx(x)); cursor.setAttribute('visibility', 'visible');
      tip.show(unitTip(k, x), ev);
    });
    grp.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') cursor.setAttribute('visibility', 'hidden'); tip.hide(); });
  });
}
function wob2(pts) { return pts.map(([x, y]) => [x, y + j(.35)]); }

/** Motif inversé : la couleur du joueur en aplat, le motif ajouré (couleur du papier) */
function invertedFill(svg, id) {
  const m = motifOf(id) || { motif: 9, crayon: 0 };
  const pid = 'dmi' + id;
  if (!svg.querySelector('#' + CSS.escape(pid))) {
    const p = el('pattern', { id: pid, patternUnits: 'userSpaceOnUse', width: 12, height: 12, viewBox: '0 0 24 24' }, svg.querySelector('defs'));
    p.style.color = 'var(--panel)';
    el('rect', { x: -1, y: -1, width: 26, height: 26, style: `fill: var(${CRAYONS[m.crayon]})` }, p);
    const s = MOTIF_SHAPES[m.motif % MOTIF_SHAPES.length];
    if (s.d) el('path', { d: s.d, style: 'fill: none; stroke: var(--panel)', 'stroke-width': s.w || 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, p);
    (s.dots || []).forEach(([cx, cy, r]) => el('circle', { cx, cy, r, style: 'fill: var(--panel)' }, p));
  }
  return `url(#${pid})`;
}

/* ============================================================
   SORTIES EN GROUPE (d3, gardé) : arcs au motif de chaque joueur,
   rubans aux couleurs des sports, le tout cerné d'encre
   ============================================================ */
export function styleSocialDA(container, athleteIds) {
  const svg = container.querySelector('svg');
  if (!svg) return;
  if (!svg.querySelector('defs')) svg.insertBefore(el('defs', {}), svg.firstChild);
  svg.classList.add('da-social');
  svg.querySelectorAll('.soc-arc').forEach(a => {
    const id = athleteIds[a.__data__?.index];
    if (id == null) return;
    a.setAttribute('fill', invertedFill(svg, id));
    a.removeAttribute('stroke');
  });
  svg.querySelectorAll('.soc-label').forEach(t => {
    const id = athleteIds[t.__data__?.index];
    if (String(id) === ME()) t.classList.add('is-me');
  });
  // Cadrage sur le dessin (noms compris) : rien de coupé, pas de vide autour
  const bb = svg.getBBox();
  if (bb.width) {
    svg.setAttribute('viewBox', `${(bb.x - 10).toFixed(0)} ${(bb.y - 10).toFixed(0)} ${(bb.width + 20).toFixed(0)} ${(bb.height + 20).toFixed(0)}`);
    svg.removeAttribute('width'); svg.removeAttribute('height');
  }
}
