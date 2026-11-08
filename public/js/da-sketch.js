/**
 * DA « Atelier » : graphiques dessinés à la main (page Stats). Présentation seule.
 *
 * Petits outils de tracé en SVG : traits qui tremblent, courbes repassées,
 * cercles au stylo, points d'encre, et remplissage par les motifs des joueurs
 * (js/motifs.js). Les couleurs passent par les variables CSS : le thème
 * (clair / cyanotype) s'applique sans redessiner.
 */
import { MOTIF_SHAPES } from './motifs.js';

export const isDA = () => document.documentElement.classList.contains('da-atelier');
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const canHover = () => window.matchMedia?.('(hover: hover)').matches;

const NS = 'http://www.w3.org/2000/svg';
const R = Math.random;
export const j = a => (R() - 0.5) * 2 * a;
const f = n => n.toFixed(1);
let uid = 0;

export function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
export function text(parent, x, y, s, cls, anchor) {
  const t = el('text', { x: f(x), y: f(y), class: cls, 'text-anchor': anchor || 'start' }, parent);
  t.textContent = s;
  return t;
}
/** Courbe lisse qui passe par tous les points (Catmull-Rom) */
export function smooth(p) {
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}
/** Tremblement : chaque segment est redécoupé et ses points bougent un peu */
export function wob(pts, amp = 1, step = 28) {
  const out = [[pts[0][0] + j(amp * .4), pts[0][1] + j(amp * .4)]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay) || 1, n = Math.max(1, Math.round(L / step));
    const nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let k = 1; k <= n; k++) {
      const t = k / n, o = k === n ? j(amp * .3) : j(amp);
      out.push([ax + (bx - ax) * t + nx * o, ay + (by - ay) * t + ny * o]);
    }
  }
  return out;
}
/** Trait droit à main levée : bouts qui dépassent, légère courbure */
export function lineD(x1, y1, x2, y2, amp = 1, over = 3) {
  const L = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / L, uy = (y2 - y1) / L;
  const a = R() * over, b = R() * over;
  const sx = x1 - ux * a + j(amp * .5), sy = y1 - uy * a + j(amp * .5);
  const ex = x2 + ux * b + j(amp * .5), ey = y2 + uy * b + j(amp * .5);
  const bow = j(Math.min(L * 0.01, 2.5) + amp * .4);
  return `M${f(sx)} ${f(sy)} Q${f((sx + ex) / 2 - uy * bow)} ${f((sy + ey) / 2 + ux * bow)} ${f(ex)} ${f(ey)}`;
}
export function path(parent, d, cls, w, draw = true) {
  const p = el('path', { d, class: cls + (draw ? ' dr' : ''), 'stroke-width': w || 1.4 }, parent);
  if (draw) p.setAttribute('pathLength', 1);
  return p;
}
export function line(parent, x1, y1, x2, y2, o = {}) {
  for (let k = 0; k < (o.passes || 1); k++)
    path(parent, lineD(x1, y1, x2, y2, o.amp ?? 1, o.over ?? 3), o.cls || 'sk-ink', (o.w || 1.4) * (k ? .7 : 1), o.draw ?? true);
}
export function curve(parent, pts, o = {}) {
  const out = [];
  for (let k = 0; k < (o.passes || 1); k++)
    out.push(path(parent, smooth(wob(pts, o.amp ?? .6, o.step ?? 28)), o.cls || 'sk-ink', (o.w || 1.6) * (k ? .65 : 1), o.draw ?? true));
  return out;
}
/** Contour de rectangle : quatre traits qui se croisent aux angles */
export function rectD(x, y, w, h, amp = .6, over = 2, base = true) {
  return [lineD(x, y + h, x, y, amp, over), lineD(x, y, x + w, y, amp, over), lineD(x + w, y, x + w, y + h, amp, over),
    base ? lineD(x, y + h, x + w, y + h, amp, over) : ''].join(' ');
}
export function arrowHead(parent, x, y, ang, o = {}) {
  const s = o.size || 7;
  for (const da of [2.6, -2.6]) line(parent, x, y, x + Math.cos(ang + da) * s, y + Math.sin(ang + da) * s, { ...o, over: 0, amp: .4 });
}
/** Cercle au stylo : on dépasse le point de départ */
export function loopD(cx, cy, rx, ry) {
  const start = Math.PI * (0.9 + R() * .3), sweep = Math.PI * 2 * (1.08 + R() * .06), pts = [];
  for (let i = 0; i <= 28; i++) {
    const t = start + sweep * i / 28, k = 1 + j(.05) + (i / 28) * .06;
    pts.push([cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k]);
  }
  return smooth(pts);
}
/** Point d'encre : rond plein, pas tout à fait rond */
export function blotD(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 9; i++) { const t = i / 8 * Math.PI * 2; pts.push([cx + Math.cos(t) * r * (1 + j(.1)), cy + Math.sin(t) * r * (1 + j(.1))]); }
  return smooth(pts) + 'Z';
}
export const polyD = p => 'M' + p.map(q => f(q[0]) + ' ' + f(q[1])).join(' L') + ' Z';

/* --- Feuille : un SVG à la taille du conteneur --- */
export function sheet(container, w, h, cls = '') {
  container.innerHTML = '';
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'da-sketch ' + cls, role: 'img' }, container);
  el('defs', {}, svg);
  const g = el('g', {}, svg);
  revealOnView(container, svg);
  return { svg, g };
}

/* --- Motif d'un joueur (ou d'un sport) en remplissage SVG ---
   own : un motif propre à la forme, pour pouvoir le faire « bouillir » seul. */
export function motifFill(svg, motif, crayonVar, own = false) {
  svg._pats = svg._pats || new Map();
  const key = motif + '|' + crayonVar;
  if (!own && svg._pats.has(key)) return svg._pats.get(key);
  const id = 'dm' + (++uid);
  const p = el('pattern', { id, patternUnits: 'userSpaceOnUse', width: 12, height: 12, viewBox: '0 0 24 24' }, svg.querySelector('defs'));
  p.style.color = `var(${crayonVar})`;
  const s = MOTIF_SHAPES[motif % MOTIF_SHAPES.length];
  // Couleur posée sur les traits eux-mêmes : héritée du <pattern>, Chrome la perd parfois au rendu
  const ink = `var(${crayonVar})`;
  if (s.d) el('path', { d: s.d, style: `fill: none; stroke: ${ink}`, 'stroke-width': s.w || 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, p);
  (s.dots || []).forEach(([cx, cy, r]) => el('circle', { cx, cy, r, style: `fill: ${ink}` }, p));
  const out = { url: `url(#${id})`, el: p };
  if (!own) svg._pats.set(key, out);
  return out;
}
/** Le même motif en canvas, pour les graphiques ECharts gardés tels quels */
export function motifCanvas(motif, color, size = 14, tint = 0) {
  const c = document.createElement('canvas');
  const dpr = 2;
  c.width = c.height = size * dpr;
  const x = c.getContext('2d');
  x.scale(size * dpr / 24, size * dpr / 24);
  // Un voile de la couleur sous le motif : la forme se lit même où le motif est clairsemé
  if (tint) { x.globalAlpha = tint; x.fillStyle = color; x.fillRect(0, 0, 24, 24); x.globalAlpha = 1; }
  const s = MOTIF_SHAPES[motif % MOTIF_SHAPES.length];
  x.strokeStyle = x.fillStyle = color;
  x.lineWidth = s.w || 1.8; x.lineCap = 'round'; x.lineJoin = 'round';
  if (s.d) x.stroke(new Path2D(s.d));
  (s.dots || []).forEach(([cx, cy, r]) => { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); });
  return c;
}
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* --- « Bouillir » au survol (souris) ou au toucher : trois états à peine
   différents qui alternent, comme le cercle autour de ton nom --- */
const BOIL = ['', 'translate(.9 -.6) rotate(1.6)', 'translate(-.7 .8) rotate(-1.3)'];
export function boil(hit, { patterns = [], outlines = [] } = {}) {
  if (calm()) return;
  // Trois versions du contour, tirées une fois
  const variants = outlines.map(o => [o.el.getAttribute('d'), o.make(), o.make()]);
  let timer = null, k = 0;
  const set = n => {
    patterns.forEach(p => p.setAttribute('patternTransform', BOIL[n]));
    outlines.forEach((o, i) => o.el.setAttribute('d', variants[i][n]));
  };
  const start = () => { if (timer) return; timer = setInterval(() => { k = (k + 1) % 3; set(k); }, 125); hit.classList.add('is-boiling'); };
  const stop = () => { clearInterval(timer); timer = null; k = 0; set(0); hit.classList.remove('is-boiling'); };
  if (canHover()) {
    hit.addEventListener('pointerenter', start);
    hit.addEventListener('pointerleave', stop);
  } else {
    hit.addEventListener('click', () => {
      const on = !!timer;
      document.dispatchEvent(new CustomEvent('da-boil-stop'));
      if (!on) start();
    });
    document.addEventListener('da-boil-stop', stop);
  }
}

/* --- Infobulle : une étiquette de papier, posée près du pointeur --- */
export function tooltip(container) {
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  let t = container.querySelector(':scope > .da-tip');
  if (!t) { t = document.createElement('div'); t.className = 'da-tip'; t.hidden = true; container.appendChild(t); }
  // Au toucher (pas de survol) : un appui affiche la bulle de l'endroit
  // touché, elle reste jusqu'à un appui ailleurs.
  if (!container._daTouch) {
    container._daTouch = true;
    container.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      t._sticky = true;
      e.target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType }));
    });
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' && !container.contains(e.target)) { t._sticky = false; t.hidden = true; }
    });
  }
  return {
    show(html, evt) {
      t.innerHTML = html; t.hidden = false;
      // Toujours au même endroit, au-dessus du graphique : la bulle ne
      // saute plus d'un coin à l'autre et ne cache pas ce qu'on pointe
      // calée à droite : le titre du graphique, à gauche, reste lisible
      t.style.left = Math.max(0, container.clientWidth - t.offsetWidth) + 'px';
      t.style.top = -(t.offsetHeight + 8) + 'px';
    },
    hide() { if (!t._sticky) t.hidden = true; },
  };
}

/* --- Tracé à la première apparition (une fois par conteneur) --- */
const drawn = new WeakSet();
function revealOnView(container, svg) {
  if (calm() || drawn.has(container) || !('IntersectionObserver' in window)) return;
  drawn.add(container);
  svg.classList.add('sk-wait');
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.disconnect();
    const s = container.querySelector('svg.da-sketch');
    if (s) { s.classList.remove('sk-wait'); s.classList.add('sk-anim'); }
  }), { threshold: .25 });
  io.observe(container);
}
