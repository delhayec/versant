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

  /**
   * Cible du sabotage, sans choix du joueur : le joueur le plus proche de lui
   * en D+ (au-dessus ou en dessous) ; à égalité d'écart, celui qui a le plus
   * de D+, puis le plus petit identifiant. En saison Équipes (entrées avec
   * teamIndex) : l'équipe la plus proche en D+ total, jamais la sienne.
   * @returns {Array} entrées touchées
   */
  function sabotageTargets(entries, user) {
    const byTeam = user.teamIndex != null;
    if (!byTeam) {
      const others = entries.filter(e => e !== user);
      if (!others.length) return [];
      const best = others.reduce((b, e) => {
        const d = Math.abs(e.originalElevation - user.originalElevation);
        const bd = Math.abs(b.originalElevation - user.originalElevation);
        if (d !== bd) return d < bd ? e : b;
        if (e.originalElevation !== b.originalElevation) return e.originalElevation > b.originalElevation ? e : b;
        return String(e.id) < String(b.id) ? e : b;
      });
      return [best];
    }
    const totals = new Map();
    for (const e of entries) totals.set(e.teamIndex, (totals.get(e.teamIndex) || 0) + e.originalElevation);
    const mine = totals.get(user.teamIndex) || 0;
    const teams = [...totals.keys()].filter(t => t !== user.teamIndex);
    if (!teams.length) return [];
    const target = teams.reduce((b, t) => {
      const d = Math.abs(totals.get(t) - mine);
      const bd = Math.abs(totals.get(b) - mine);
      if (d !== bd) return d < bd ? t : b;
      if (totals.get(t) !== totals.get(b)) return totals.get(t) > totals.get(b) ? t : b;
      return t < b ? t : b;
    });
    return entries.filter(e => e.teamIndex === target);
  }

  /**
   * Effets des jokers d'un round (règles L54), dans l'ordre d'origine :
   * sabotages (sur le D+ de base), vols, multiplicateurs, boucliers.
   * @param {Array} entries - { id, name, elevation, originalElevation, teamIndex? } (modifiés)
   * @param {Array} jokers - { type, userId, userName, targetId }
   * @param {Array} activities - activités du round { id, athleteId, elevation, name }
   * @returns {Array} effets { type, byId, byName, toId, toName, amount, activity?, factor? }
   */
  function applyJokers(entries, jokers, activities) {
    const byId = new Map(entries.map(e => [String(e.id), e]));
    const sameTeam = (a, b) => a.teamIndex != null && a.teamIndex === b.teamIndex;
    const effects = [];
    const ofType = type => jokers.filter(j => j.type === type);

    // 1. Sabotage : -30 % du D+ de base au plus proche (joueur ou équipe)
    for (const j of ofType('sabotage')) {
      const user = byId.get(String(j.userId));
      if (!user) continue;
      for (const t of sabotageTargets(entries, user)) {
        const amount = Math.round(t.originalElevation * JOKERS.sabotageShare);
        t.elevation = Math.max(0, t.elevation - amount);
        effects.push({ type: 'sabotage', byId: user.id, byName: j.userName || user.name, toId: t.id, toName: t.name, amount });
      }
    }

    // 2. Voleur : meilleure activité de moins de 1 000 m de la cible (ou de son
    // équipe). Plusieurs voleurs sur la même activité : la victime ne la perd
    // qu'une fois, chaque voleur gagne son D+.
    const lost = new Set();
    for (const j of ofType('voleur')) {
      const thief = byId.get(String(j.userId));
      const target = byId.get(String(j.targetId));
      if (!thief || !target || thief === target || sameTeam(thief, target)) continue;
      const victims = target.teamIndex != null ? entries.filter(e => e.teamIndex === target.teamIndex) : [target];
      const ids = new Set(victims.map(v => String(v.id)));
      const pool = activities.filter(a => ids.has(String(a.athleteId)) && a.elevation > 0 && a.elevation < JOKERS.thiefMaxActivityElevation);
      if (!pool.length) {
        effects.push({ type: 'voleur', byId: thief.id, byName: j.userName || thief.name, toId: target.id, toName: target.name, amount: 0, activity: null });
        continue;
      }
      const best = pool.reduce((b, a) => (a.elevation > b.elevation || (a.elevation === b.elevation && String(a.id) < String(b.id)) ? a : b));
      const amount = Math.round(best.elevation);
      const owner = byId.get(String(best.athleteId));
      if (!lost.has(String(best.id))) {
        owner.elevation = Math.max(0, owner.elevation - amount);
        lost.add(String(best.id));
      }
      thief.elevation += amount;
      effects.push({ type: 'voleur', byId: thief.id, byName: j.userName || thief.name, toId: owner.id, toName: owner.name, amount, activity: best.name || null });
    }

    // 3. Multiplicateur ×1,25 sur le D+ après sabotages et vols
    for (const j of ofType('multiplicateur')) {
      const user = byId.get(String(j.userId));
      if (!user) continue;
      const amount = Math.round(user.elevation * (JOKERS.multiplier - 1));
      user.elevation += amount;
      effects.push({ type: 'multiplicateur', byId: user.id, byName: j.userName || user.name, toId: user.id, toName: user.name, amount, factor: JOKERS.multiplier });
    }

    // 4. Bouclier : inchangé (protection contre l'élimination)
    for (const j of ofType('bouclier')) {
      const user = byId.get(String(j.userId));
      if (user) effects.push({ type: 'bouclier', byId: user.id, byName: j.userName || user.name, toId: user.id, toName: user.name, amount: 0 });
    }
    return effects;
  }

  // ============================================
  // BONUS DES ÉLIMINÉS
  // ============================================
  const BONUS_IDS = ['embuscade', 'ravitaillement', 'duel', 'brouillard', 'marquage', 'trap', 'second_souffle', 'kamikaze', 'malediction'];
  const MIN_ACTIVITY_SECONDS = 20 * 60;   // embuscade : activités de plus de 20 minutes

  /**
   * Tirage pondéré de `count` bonus distincts (sans remise).
   * @param {Array<string>} ids - bonus éligibles
   * @param {Function} random - () → [0, 1[
   */
  function drawBonuses(ids, roundInSeason, roundsInSeason, count = 2, random = Math.random) {
    let pool = ids.map(id => ({ id, w: bonusDrawWeight(id, roundInSeason, roundsInSeason) })).filter(x => x.w > 0);
    const picked = [];
    while (picked.length < count && pool.length) {
      const total = pool.reduce((s, x) => s + x.w, 0);
      let r = random() * total;
      const index = pool.findIndex(x => (r -= x.w) < 0);
      const chosen = pool[index === -1 ? pool.length - 1 : index];
      picked.push(chosen.id);
      pool = pool.filter(x => x !== chosen);
    }
    return picked;
  }

  /**
   * Embuscade : une activité de plus de 20 minutes de la cible, tirée au sort
   * HORS sa meilleure activité du round. Une seule activité : la moitié de son D+.
   * @param {Array} activities - activités du round de la cible { id, elevation, movingTime, name }
   * @returns {{activity: Object|null, amount: number}}
   */
  function embuscadePick(activities, random = Math.random) {
    const eligible = activities.filter(a => (a.movingTime || 0) >= MIN_ACTIVITY_SECONDS);
    if (!eligible.length) return { activity: null, amount: 0 };
    if (eligible.length === 1) return { activity: eligible[0], amount: Math.round((eligible[0].elevation || 0) / 2), half: true };
    const best = eligible.reduce((b, a) => ((a.elevation || 0) > (b.elevation || 0) ? a : b));
    const pool = eligible.filter(a => a !== best);
    const activity = pool[Math.floor(random() * pool.length)];
    return { activity, amount: Math.round(activity.elevation || 0) };
  }

  /**
   * Malédiction : cibles possibles = les 3 joueurs classés juste au-dessus du
   * joueur au round de son élimination et encore en lice après ce round.
   * @param {Object} round - round figé de l'élimination { ranking, eliminations }
   * @returns {Array<string>} identifiants
   */
  function maledictionTargets(round, athleteId) {
    const ranking = [...(round?.ranking || [])].sort((a, b) => a.position - b.position);
    const out = new Set((round?.eliminations || []).map(e => String(e.id)));
    const me = ranking.findIndex(e => String(e.id) === String(athleteId));
    if (me < 0) return [];
    return ranking.slice(0, me).filter(e => !out.has(String(e.id))).slice(-3).map(e => String(e.id));
  }

  /**
   * D+ gagné au challenge des éliminés par la malédiction pour un round :
   * montants posés au gel dans effect_result.rounds (règles L54 seulement).
   * @param {Array} bonuses - bonus de l'édition (actifs et archivés, doublons tolérés)
   */
  function maledictionGains(bonuses, athleteId, roundNumber) {
    const seen = new Set();
    const gains = [];
    for (const b of bonuses || []) {
      if (b?.bonus_id !== 'malediction' || String(b.athlete_id) !== String(athleteId)) continue;
      const key = `${b.athlete_id}:${b.elimination_round}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const amount = Number(b.effect_result?.rounds?.[String(roundNumber)]) || 0;
      if (amount > 0) gains.push({ amount, from: b.target_athlete_name || null });
    }
    return gains;
  }

  return {
    VERSION, MECHANICS, DEFAULT_MECHANICS, JOKERS, BONUSES, BONUS_IDS,
    defaultRules, isActive, mechanicActive, finalStep, mainPoints, eliminatedPoints, bonusDrawWeight,
    sabotageTargets, applyJokers, drawBonuses, embuscadePick, maledictionTargets, maledictionGains
  };
});
