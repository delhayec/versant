/**
 * DA Atelier : petites briques pour écrire les notes manuscrites telles que
 * dessinées dans design/editeur-manic.html (variantes de lettres choisies,
 * soulignés, cercles, ratures). Présentation seule : aucun calcul de score.
 *
 * Variantes : '1' à '3' = dessins de remplacement de MANIC (zone privée,
 * via window.daHandAlt de js/da-atelier.js) ; 'A1' à 'A3' = les trois
 * alphabets « Alternates » (polices manic-a1..a3).
 */

const ESC = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Une lettre dans la variante voulue. */
function glyph(c, v) {
  if (!v || !c.trim()) return ESC(c);
  if (v[0] === 'A') return `<span class="da-af${v[1]}">${ESC(c)}</span>`;
  const alt = typeof window !== 'undefined' && window.daHandAlt ? window.daHandAlt(c, +v) : c;
  return ESC(alt);
}

/**
 * Texte avec variantes : { index: variante } (index dans le texte), ou une
 * liste appliquée lettre par lettre (pour un nombre : 1er chiffre, 2e…, la
 * dernière variante sert aux chiffres suivants).
 */
export function hv(text, alts = {}) {
  const list = Array.isArray(alts);
  return Array.from(String(text), (c, i) => glyph(c, list ? alts[Math.min(i, alts.length - 1)] : alts[i])).join('');
}

/** Dessins MANIC posés sur un passage (public/assets/manic/<nom>.svg). */
const drawn = (kind, name, html, color, extra = '') =>
  `<span class="da-draw da-draw--${kind} da-draw--${name}${color ? ' da-draw--' + color : ''}${extra}" style="--draw:url(/assets/manic/${name}.svg)">${html}</span>`;

/** Souligné sous le passage. color : 'acc' (orange) ou 'sub' (gris), sinon la couleur du texte. */
export const under = (html, name = 'emphasis-02', color = '', thin = false) => drawn('under', name, html, color, thin ? ' da-draw--thin' : '');
/** Cercle autour du passage (orange par défaut). */
export const circle = (html, name = 'circle-05', color = 'acc') => drawn('circle', name, html, color);
/** Rature par-dessus le passage (orange par défaut). */
export const strike = (html, name = 'scribble-03', color = 'acc') => drawn('strike', name, html, color);

export const small = (html, k = 0.8) => `<span class="da-sz" style="--k:${k}">${html}</span>`;
export const muted = (html) => `<span class="da-mut">${html}</span>`;
export const accent = (html) => `<span class="da-acc">${html}</span>`;

/** Rang : « 9e » avec le petit « e » de l'éditeur (variantes possibles). */
export function rank(n, digitAlts = [], eAlt = '') {
  return `${hv(n, digitAlts)}${small(hv(n === 1 ? 'er' : 'e', eAlt ? { 0: eAlt } : {}))}`;
}

/** Rang en toutes lettres (pour « deuxième PREMIER »). */
export function rankWord(n) {
  const w = ['', 'premier', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième', 'neuvième', 'dixième'];
  return w[n] || `${n}e`;
}

/** Valeur en mètres, chiffre et unité ensemble. */
export function meters(v, digitAlts = [], mAlt = '', mSize = 0) {
  const num = Math.round(Math.abs(v)).toLocaleString('fr-FR');
  const m = hv('m', mAlt ? { 0: mAlt } : {});
  return `<span class="da-nb">${hv(num, digitAlts)} ${mSize ? small(m, mSize) : m}</span>`;
}

// Racine et somme : absentes de MANIC, tracées à la main en SVG
const SQRT = '<svg class="da-math" viewBox="0 0 20 24" aria-hidden="true"><path d="M1.5 14.2 L4.6 12.4 L9.1 21.6 L15.2 2.6 Q17 2.1 19.6 2.3"/></svg>';
const SIGMA = '<svg class="da-math da-math--sigma" viewBox="0 0 20 24" aria-hidden="true"><path d="M17.8 3.4 Q10 2.4 2.6 3.1 L11.4 12.3 L2.2 21.4 Q10.4 20.6 18.4 21.2"/></svg>';
const sqrt = (x) => `<span class="da-sqrt">${SQRT}<span class="da-sqrt__in">${x}</span></span>`;

/**
 * Formule faussement compliquée dont le résultat est n (blague du « ventre
 * mou »). seed choisit la formule, pour qu'elle reste la même toute la journée.
 */
export function mathJoke(n, seed) {
  const signed = (d) => (d > 0 ? ` + ${d}` : d < 0 ? ` − ${-d}` : '');
  const forms = [
    () => {
      const a = 2 + (seed % 3), b = 1 + (seed % 2);
      return `(${sqrt(a * a)} + ${b}^2)${signed(n - a - b * b)}`;
    },
    () => {
      let k = 1;
      while ((k * (k + 1)) / 2 < n) k++;
      return `${SIGMA}<span class="da-sigma-lim">1→${k}</span>${signed(n - (k * (k + 1)) / 2)}`;
    },
    () => `(${6 * n} + 12) ÷ 3 − ${n + 4}`,
  ];
  return `Position = ${forms[seed % forms.length]()}`;
}

/** Tirage stable sur la journée : même version du matin au soir. */
export function dailyPick(list, key, date = new Date()) {
  let h = 0;
  for (const c of key + date.toDateString()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}
