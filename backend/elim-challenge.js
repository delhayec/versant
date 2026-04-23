/**
 * ============================================
 * VERSANT - CHALLENGE DES ÉLIMINÉS (backend)
 * ============================================
 *
 * Portage CommonJS de la logique du challenge des éliminés, à partir de
 * public/js/standings-engine.js (frontend, ES modules).
 *
 * Source unique de vérité côté backend pour générer
 * `frozen_results.eliminatedChallengeRankings[seasonNumber]`.
 *
 * Fonctions portées (sémantique identique au frontend) :
 *   - filterByPeriod, filterByParticipant, calculateStats : helpers activités
 *   - getEliminatedActivities : activités post-élimination
 *   - getArchivedBonusesForAthlete, getAllBonusesForAthlete, getBonusesUsedInRound
 *   - getEphemeralBonusEffectsForEliminatedAthlete
 *   - getSeasonalBonusEffectsForEliminatedAthlete
 *   - calculateEliminatedChallenge : classement brut (D+ post-élimination)
 *   - computeEliminatedChallengeRankingForSeason : orchestrateur complet
 *
 * ATTENTION : si la logique frontend évolue, il faut mettre à jour ce fichier
 * pour rester synchronisé. Une suite de tests d'intégration est recommandée.
 */

const fs = require('fs').promises;
const path = require('path');

const {
  CHALLENGE_CONFIG,
  VALID_SPORTS, isValidSport,
  ELIMINATED_CHALLENGE_POINTS, getEliminatedPoints,
  getRoundDates
} = require('./shared-config');

// ============================================
// HELPERS ACTIVITÉS (portés depuis standings-engine)
// ============================================

function getActivityEndTime(activity) {
  const start = new Date(activity.start_date);
  const elapsedMs = (activity.elapsed_time || 0) * 1000;
  return new Date(start.getTime() + elapsedMs);
}

function filterByPeriod(activities, startDate, endDate) {
  return activities.filter(a => {
    if (a.excluded) return false;
    const sportType = a.sport_type || a.type;
    if (!isValidSport(sportType)) return false;
    const endTime = getActivityEndTime(a);
    return endTime >= startDate && endTime <= endDate;
  });
}

function filterByParticipant(activities, participantId) {
  const normalizedId = String(participantId);
  return activities.filter(a => {
    const athleteId = String(a.athlete?.id || a.athlete_id);
    return athleteId === normalizedId;
  });
}

function calculateStats(activities) {
  return {
    elevation: activities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
    distance: activities.reduce((s, a) => s + (a.distance || 0), 0),
    activities: activities.length
  };
}

// ============================================
// ACTIVITÉS POST-ÉLIMINATION
// ============================================

/**
 * Retourne les activités d'un athlète à partir du LENDEMAIN de son élimination
 * (inclus) jusqu'à la fin de l'année.
 *
 * @param {string|number} athleteId
 * @param {number} eliminationRound - Numéro de round GLOBAL d'élimination
 * @param {Array} allActivities
 * @param {Date} [endDate] - Borne supérieure (par défaut : fin d'année)
 */
function getEliminatedActivities(athleteId, eliminationRound, allActivities, endDate = null) {
  const normalizedId = String(athleteId);
  const roundDates = getRoundDates(eliminationRound, CHALLENGE_CONFIG);
  const startDate = new Date(roundDates.end);
  startDate.setDate(startDate.getDate() + 1);
  startDate.setHours(0, 0, 0, 0);

  const finalEnd = endDate || new Date(CHALLENGE_CONFIG.yearEndDate + 'T23:59:59.999Z');

  return filterByParticipant(
    filterByPeriod(allActivities, startDate, finalEnd),
    normalizedId
  );
}

// ============================================
// BONUS
// ============================================

/**
 * Retourne tous les bonus utilisés dans un round donné.
 *
 * Sémantique identique à public/js/standings-engine.js :
 *   - Si bonusesCache contient au moins un bonus matchant → on retourne ceux-là
 *     (ce sont les "live").
 *   - Sinon, fallback sur seasonBonusesCache (bonus archivés).
 *
 * Cela évite de double-compter un bonus présent dans les deux sources.
 */
function getBonusesUsedInRound(roundNumber, bonusesCache, seasonBonusesCache) {
  const live = Array.isArray(bonusesCache)
    ? bonusesCache.filter(b => b && Number(b.used_in_round) === Number(roundNumber) && b.status === 'used')
    : [];
  if (live.length > 0) return live;

  if (seasonBonusesCache && typeof seasonBonusesCache === 'object') {
    for (const seasonKey of Object.keys(seasonBonusesCache)) {
      const list = seasonBonusesCache[seasonKey];
      if (!Array.isArray(list)) continue;
      const archived = list.filter(b => b && Number(b.used_in_round) === Number(roundNumber) && b.status === 'used');
      if (archived.length > 0) return archived;
    }
  }
  return [];
}

function getArchivedBonusesForAthlete(athleteId, seasonBonusesCache) {
  const normalizedId = String(athleteId);
  const out = [];
  if (!seasonBonusesCache || typeof seasonBonusesCache !== 'object') return out;
  for (const seasonKey of Object.keys(seasonBonusesCache)) {
    const list = seasonBonusesCache[seasonKey];
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!b) continue;
      if (String(b.athlete_id) === normalizedId || String(b.target_athlete_id) === normalizedId) {
        out.push(b);
      }
    }
  }
  return out;
}

function getAllBonusesForAthlete(athleteId, bonusesCache, seasonBonusesCache) {
  const normalizedId = String(athleteId);
  // Sémantique identique au frontend (standings-engine.js) :
  // - live = bonusesCache filtré par athlete_id
  // - archived = getArchivedBonusesForAthlete(...)
  // - dédup par clé `${bonus_id}_${athlete_id}_${used_in_round || ''}`
  const live = Array.isArray(bonusesCache)
    ? bonusesCache.filter(b => b && String(b.athlete_id) === normalizedId)
    : [];
  const archived = getArchivedBonusesForAthlete(normalizedId, seasonBonusesCache);

  const seen = new Set(live.map(b => `${b.bonus_id}_${b.athlete_id}_${b.used_in_round || ''}`));
  const deduped = [...live];
  for (const a of archived) {
    const key = `${a.bonus_id}_${a.athlete_id}_${a.used_in_round || ''}`;
    if (!seen.has(key)) {
      deduped.push(a);
      seen.add(key);
    }
  }
  return deduped;
}

/**
 * Calcule les effets des bonus ÉPHÉMÈRES (par round) sur un athlète éliminé.
 * Gère : embuscade, marquage, malediction, kamikaze.
 * (Les bonus saisonniers — trap, second_souffle, duel, brouillard — sont
 * traités par getSeasonalBonusEffectsForEliminatedAthlete, appelé 1x par saison.)
 */
function getEphemeralBonusEffectsForEliminatedAthlete(athleteId, roundNumber, bonusesCache, seasonBonusesCache) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);
  const roundBonuses = getBonusesUsedInRound(roundNumber, bonusesCache, seasonBonusesCache);

  for (const bonus of roundBonuses) {
    const result = bonus.effect_result;

    if (bonus.bonus_id === 'embuscade') {
      const amount = result?.stolenElevation || 0;
      if (amount > 0 && String(bonus.athlete_id) === normalizedId) {
        effects.gained += amount;
        effects.details.push({ type: 'embuscade_gain', amount, from: bonus.target_athlete_name, icon: '🏹' });
      }
    }

    if (bonus.bonus_id === 'marquage') {
      const amount = result?.penaltyAmount || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.lost += amount;
        effects.details.push({ type: 'marquage', amount, by: bonus.athlete_name, icon: '🎯' });
      }
    }

    if (bonus.bonus_id === 'malediction') {
      const amount = result?.stolenThisRound || 0;
      if (amount > 0) {
        if (String(bonus.target_athlete_id) === normalizedId) {
          effects.lost += amount;
          effects.details.push({ type: 'malediction_victim', amount, by: bonus.athlete_name, icon: '🪬' });
        }
        if (String(bonus.athlete_id) === normalizedId) {
          effects.gained += amount;
          effects.details.push({ type: 'malediction_gain', amount, from: bonus.target_athlete_name, icon: '🪬' });
        }
      }
    }

    if (bonus.bonus_id === 'kamikaze') {
      if (String(bonus.target_athlete_id) === normalizedId) {
        const amount = result?.targetPenalty || 0;
        if (amount > 0) {
          effects.lost += amount;
          effects.details.push({ type: 'kamikaze_victim', amount, by: bonus.athlete_name, icon: '💣' });
        }
      }
      if (String(bonus.athlete_id) === normalizedId) {
        const amount = result?.userPenalty || 0;
        if (amount > 0) {
          effects.lost += amount;
          effects.details.push({ type: 'kamikaze_self', amount, icon: '💣' });
        }
      }
    }
  }

  return effects;
}

/**
 * Calcule les effets des bonus SAISONNIERS (one-shot) pour un éliminé.
 * Appelé UNE seule fois par athlète par saison.
 * Gère : second_souffle, trap, duel, brouillard.
 *
 * @param {Date} [endDate] - Borne sup pour la recherche des activités post-élim
 *   (utilisé par second_souffle pour ne pas considérer des activités au-delà de la saison)
 */
function getSeasonalBonusEffectsForEliminatedAthlete(athleteId, bonusesCache, seasonBonusesCache, allActivities, endDate = null) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);
  const allAthleteBonus = getAllBonusesForAthlete(normalizedId, bonusesCache, seasonBonusesCache);

  for (const bonus of allAthleteBonus) {
    // Second Souffle — double la plus petite activité
    if (bonus.bonus_id === 'second_souffle' && (bonus.status === 'active' || bonus.status === 'chosen' || bonus.status === 'used')) {
      const alreadyAdded = effects.details.some(d => d.type === 'second_souffle');
      if (!alreadyAdded) {
        const elimRound = bonus.elimination_round;
        if (elimRound) {
          const elimActivities = getEliminatedActivities(normalizedId, elimRound, allActivities, endDate);
          if (elimActivities.length > 0) {
            const minActivity = elimActivities.reduce((min, a) =>
              (a.total_elevation_gain || 0) < (min.total_elevation_gain || 0) ? a : min
            );
            const amount = Math.round(minActivity.total_elevation_gain || 0);
            if (amount > 0) {
              const actName = minActivity.name || 'activité';
              effects.gained += amount;
              effects.details.push({ type: 'second_souffle', amount, activityName: actName, icon: '🔥' });
            }
          }
        }
      }
    }

    if (bonus.bonus_id === 'trap') {
      const result = bonus.effect_result;
      const alreadyAdded = effects.details.some(d => d.type === 'trap_gain');
      if (!alreadyAdded && result?.elevation_gained) {
        const amount = result.elevation_gained;
        const victimName = result.victim_name || 'un joueur';
        effects.gained += amount;
        effects.details.push({ type: 'trap_gain', amount, from: victimName, icon: '🪤' });
      }
    }

    if (bonus.bonus_id === 'duel') {
      const alreadyAdded = effects.details.some(d => d.type === 'duel');
      if (!alreadyAdded) {
        effects.details.push({ type: 'duel', amount: 0, icon: '⚔️' });
      }
    }

    if (bonus.bonus_id === 'brouillard') {
      const alreadyAdded = effects.details.some(d => d.type === 'brouillard');
      if (!alreadyAdded) {
        effects.details.push({ type: 'brouillard', amount: 0, icon: '🌫️' });
      }
    }
  }

  return effects;
}

// ============================================
// CHALLENGE ÉLIMINÉS
// ============================================

/**
 * Calcule le classement brut du challenge des éliminés pour une saison donnée :
 *   D+ post-élimination (sans bonus).
 *
 * @param {Array} activities - Toutes les activités (année complète)
 * @param {Array} eliminatedList - Liste des éliminés (id, name, eliminatedRound GLOBAL, eliminatedSeason)
 * @param {Object} seasonDates - { start, end } en Date
 * @param {Date} currentDate - Date courante (borne sup)
 */
function calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate) {
  const ranking = [];
  const endDate = currentDate < seasonDates.end ? currentDate : seasonDates.end;

  for (const p of eliminatedList) {
    // eliminatedRound est GLOBAL ici (on le fournit directement)
    const roundDates = getRoundDates(p.eliminatedRound, CHALLENGE_CONFIG);
    const eliminationDate = new Date(roundDates.end);

    if (currentDate < eliminationDate) continue;

    const startDate = new Date(eliminationDate);
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    let pActs = [];
    let stats = { elevation: 0, distance: 0, activities: 0 };

    if (startDate <= endDate) {
      pActs = filterByParticipant(filterByPeriod(activities, startDate, endDate), p.id);
      stats = calculateStats(pActs);
    }

    ranking.push({
      participant: p,
      id: String(p.id),
      name: p.name,
      totalElevation: stats.elevation,
      rawElevation: stats.elevation,
      totalDistance: stats.distance,
      activityCount: stats.activities,
      eliminatedRound: p.eliminatedRound,
      eliminatedSeason: p.eliminatedSeason,
      daysSinceElimination: Math.max(0, Math.floor((endDate - eliminationDate) / 86400000))
    });
  }

  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedPoints(e.position);
  });
  return ranking;
}

/**
 * Orchestrateur : calcule le classement final du challenge éliminés POUR UNE SAISON
 * avec application des bonus (éphémères + saisonniers).
 *
 * Entrée :
 *   - seasonNumber : numéro de saison
 *   - activities : toutes les activités de l'année
 *   - eliminatedList : liste des éliminés de la saison, format
 *       [{ id, name, eliminatedRound (GLOBAL), eliminatedSeason }]
 *   - seasonDates : { start, end } Date
 *   - currentDate : Date courante (borne sup pour le calcul)
 *   - bonusesCache : bonus actifs (bonuses.json)
 *   - seasonBonusesCache : frozen_results.seasonBonuses
 *   - frozenRoundsMap : frozen_results.rounds (pour itérer sur les rounds de la saison)
 *
 * Sortie : classement enrichi trié par totalElevation (final) décroissant,
 *   avec `bonusEffects.gained/lost/details` par athlète, `rawElevation`,
 *   `totalElevation`, `position`, `points`.
 */
function computeEliminatedChallengeRankingForSeason({
  seasonNumber,
  activities,
  eliminatedList,
  seasonDates,
  currentDate,
  bonusesCache,
  seasonBonusesCache,
  frozenRoundsMap
}) {
  // 1. Classement brut : D+ post-élimination par athlète
  const ranking = calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate);

  // 2. Appliquer les bonus SAISONNIERS (one-shot) pour chaque athlète
  // 3. Itérer sur chaque round GLOBAL de la saison pour appliquer les bonus ÉPHÉMÈRES
  const seasonRoundNumbers = new Set();
  if (frozenRoundsMap && typeof frozenRoundsMap === 'object') {
    for (const [k, r] of Object.entries(frozenRoundsMap)) {
      if (r && Number(r.seasonNumber) === Number(seasonNumber)) {
        seasonRoundNumbers.add(Number(k));
      }
    }
  }

  for (const entry of ranking) {
    entry.bonusEffects = { gained: 0, lost: 0, details: [] };

    // Saisonnier (1x) — borné à la fin de saison pour que second_souffle ne
    // prenne en compte QUE les activités de la saison courante
    const seasonal = getSeasonalBonusEffectsForEliminatedAthlete(
      entry.id, bonusesCache, seasonBonusesCache, activities, seasonDates.end
    );
    entry.bonusEffects.gained += seasonal.gained;
    entry.bonusEffects.lost += seasonal.lost;
    entry.bonusEffects.details.push(...seasonal.details);

    // Éphémères (par round de la saison)
    for (const roundNumber of seasonRoundNumbers) {
      const ephemeral = getEphemeralBonusEffectsForEliminatedAthlete(
        entry.id, roundNumber, bonusesCache, seasonBonusesCache
      );
      entry.bonusEffects.gained += ephemeral.gained;
      entry.bonusEffects.lost += ephemeral.lost;
      entry.bonusEffects.details.push(...ephemeral.details);
    }

    // Appliquer sur totalElevation
    entry.totalElevation = Math.max(
      0,
      (entry.rawElevation || 0) + entry.bonusEffects.gained - entry.bonusEffects.lost
    );
  }

  // 4. Re-trier et réattribuer position + points
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedPoints(e.position);
  });

  return ranking;
}

module.exports = {
  // Helpers activités
  getActivityEndTime,
  filterByPeriod,
  filterByParticipant,
  calculateStats,
  getEliminatedActivities,
  // Bonus helpers
  getBonusesUsedInRound,
  getArchivedBonusesForAthlete,
  getAllBonusesForAthlete,
  getEphemeralBonusEffectsForEliminatedAthlete,
  getSeasonalBonusEffectsForEliminatedAthlete,
  // Classement
  calculateEliminatedChallenge,
  computeEliminatedChallengeRankingForSeason
};