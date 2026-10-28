/**
 * ============================================
 * VERSANT - RÈGLES DES NOUVELLES ÉDITIONS (L54, SOURCE UNIQUE)
 * ============================================
 * Module UMD partagé entre le backend (require) et le frontend (global
 * window.EditionRules), comme shared/team-formation.js.
 *
 * Une édition suit ces règles quand sa config porte `rules.version >= 2`
 * (posé au lancement de toute nouvelle édition). Sans ce champ — versant-2026 —
 * les règles d'origine s'appliquent, inchangées : aucun appelant ne doit
 * passer ici pour une telle édition.
 *
 * Décisions du 28/10 (docs/audit-multi-ligues.md, §6.2, ligne L54) :
 * - barème généré par le nombre de joueurs au départ de la saison (N) et le
 *   nombre de finalistes (F) : hors finale 1 point par place (dernier 0) ;
 *   palier G (5, ou 4 sous 12 joueurs) pour entrer en finale ; +3 par place
 *   en finale, +4 pour la victoire ; challenge des éliminés : 1er G + 1, puis
 *   G - 1, G - 2… Un finaliste finit au moins à égalité avec tout éliminé,
 *   sauf le meilleur éliminé de la demi-finale vainqueur du challenge des éliminés ;
 * - multiplicateur ×1,25 ; voleur : meilleure activité de moins de 1 000 m ;
 *   sabotage : -30 % au joueur le plus proche en D+, sans cible choisie ;
 * - kamikaze : -10 % pour soi, -25 % pour la cible ; malédiction 15 % ;
 *   embuscade tirée hors meilleure activité du round de la cible ;
 * - mécaniques débloquées saison par saison, réglables par l'admin de ligue.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // backend (CommonJS)
  } else {
    root.EditionRules = api;         // navigateur (global)
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 2;

  // Saison à partir de laquelle chaque mécanique est active (null : jamais)
  const MECHANICS = ['jokers', 'eliminatedBonuses', 'specialRules', 'gauge', 'teams'];
  const DEFAULT_MECHANICS = { jokers: 1, eliminatedBonuses: 2, specialRules: 3, gauge: 3, teams: 4 };

  const JOKERS = {
    multiplier: 1.25,
    thiefMaxActivityElevation: 1000,   // le voleur prend la meilleure activité SOUS ce D+
    sabotageShare: 0.3                 // retiré au joueur (ou à l'équipe) le plus proche en D+
  };

  const BONUSES = {
    kamikazeSelfShare: 0.10,
    kamikazeTargetShare: 0.25,
    maledictionShare: 0.15,
    // Tirage pondéré (1er tiers de la saison) : bonus qui valent plus s'ils agissent longtemps
    earlyBoosted: ['malediction', 'second_souffle', 'brouillard'],
    earlyWeight: 3
  };

  /** Règles posées au lancement d'une nouvelle édition. */
  function defaultRules() {
    return { version: VERSION, mechanics: { ...DEFAULT_MECHANICS } };
  }

  /** L'édition suit-elle les règles L54 ? (config de l'édition, ou CHALLENGE_CONFIG côté front) */
  function isActive(config) {
    return Number(config?.rules?.version) >= VERSION;
  }

  /**
   * La mécanique est-elle active cette saison ? Toujours vrai sans règles L54
   * (versant-2026 garde toutes ses mécaniques).
   */
  function mechanicActive(config, mechanic, seasonNumber) {
    if (!isActive(config)) return true;
    const from = config.rules.mechanics?.[mechanic];
    return from != null && Number(seasonNumber) >= Number(from);
  }

  /** Palier entre le dernier finaliste et le premier éliminé. */
  function finalStep(rosterSize) {
    return rosterSize >= 12 ? 5 : 4;
  }

  /**
   * Points du challenge principal pour une place de la saison.
   * @param {number} position - 1 = vainqueur
   * @param {number} rosterSize - joueurs au départ de la saison (N)
   * @param {number} finalists - finalistes (F)
   */
  function mainPoints(position, rosterSize, finalists) {
    const N = Math.max(1, Number(rosterSize) || 0);
    const F = Math.max(1, Math.min(Number(finalists) || 1, N));
    const p = Number(position);
    if (!Number.isInteger(p) || p < 1 || p > N) return 0;
    if (p > F) return N - p;
    let points = (N - F - 1) + finalStep(N);
    for (let r = F - 1; r >= p; r--) points += r === 1 ? 4 : 3;
    return points;
  }

  /** Points du challenge des éliminés pour une place (1er = palier + 1, puis palier - 1…). */
  function eliminatedPoints(position, rosterSize) {
    const G = finalStep(Number(rosterSize) || 0);
    const p = Number(position);
    if (!Number.isInteger(p) || p < 1) return 0;
    if (p === 1) return G + 1;
    return Math.max(0, G - (p - 1));
  }

  /**
   * Poids d'un bonus au tirage des bonus des éliminés : plus fréquent au
   * premier tiers de la saison s'il agit dans la durée ; la malédiction n'est
   * plus proposée au dernier round avant la finale (elle n'aurait plus de cible).
   * @returns {number} poids (0 : jamais proposé)
   */
  function bonusDrawWeight(bonusId, roundInSeason, roundsInSeason) {
    const r = Number(roundInSeason) || 1;
    const total = Number(roundsInSeason) || 1;
    if (bonusId === 'malediction' && r >= total - 1) return 0;
    if (BONUSES.earlyBoosted.includes(bonusId) && r <= Math.ceil(total / 3)) return BONUSES.earlyWeight;
    return 1;
  }

  return {
    VERSION, MECHANICS, DEFAULT_MECHANICS, JOKERS, BONUSES,
    defaultRules, isActive, mechanicActive, finalStep, mainPoints, eliminatedPoints, bonusDrawWeight
  };
});
