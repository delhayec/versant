/**
 * ============================================
 * VERSANT - HARNAIS : HORLOGE FIGÉE
 * ============================================
 * Remplace le `Date` global par une sous-classe dont « maintenant » est fixé.
 *
 * Le moteur lit l'heure courante à plusieurs endroits sans la recevoir en
 * paramètre (ex. getRoundsPerSeason → getSeasonNumber(new Date())). Sans horloge
 * figée, deux captures faites à des moments différents divergeraient.
 *
 * À installer AVANT d'importer le code testé : toutes les dates créées ensuite
 * sont alors des instances de la même classe. Une date créée avant reste
 * reconnue par `instanceof Date` (cf. Symbol.hasInstance).
 */

const RealDate = globalThis.Date;
let fixedNow = null;

class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fixedNow ?? RealDate.now());
    else super(...args);
  }

  static now() {
    return fixedNow ?? RealDate.now();
  }

  static [Symbol.hasInstance](obj) {
    return obj instanceof RealDate;
  }
}

export function setNow(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : new RealDate(isoOrMs).getTime();
  if (Number.isNaN(ms)) throw new Error(`Horloge figée : date invalide (${isoOrMs})`);
  fixedNow = ms;
}

export function installFixedClock(isoOrMs) {
  setNow(isoOrMs);
  globalThis.Date = FixedDate;
}

export { RealDate };
