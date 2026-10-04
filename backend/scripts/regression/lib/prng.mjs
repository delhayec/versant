/**
 * ============================================
 * VERSANT - HARNAIS : HASARD À GRAINE FIXE
 * ============================================
 * Le gel utilise Math.random (embuscade : frozen-results.js:1419 ; tirage des
 * choix de bonus : frozen-results.js:368). Pour comparer deux versions du code,
 * chaque scénario repart d'une graine dérivée de son nom.
 */

const realRandom = Math.random;

// mulberry32 : générateur 32 bits, suffisant pour rendre un tirage reproductible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32 bits : graine stable à partir d'un libellé.
function seedFromLabel(label) {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seedMathRandom(label) {
  Math.random = mulberry32(seedFromLabel(label));
}

export function restoreMathRandom() {
  Math.random = realRandom;
}
