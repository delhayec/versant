/**
 * ============================================
 * VERSANT - STANDINGS ENGINE
 * ============================================
 *
 * Moteur de calcul des classements — port FIDÈLE depuis public/js/app.js.
 *
 * PRINCIPE : chaque fonction est une copie exacte de sa contrepartie dans app.js,
 * avec les globals (allActivities, frozenResultsCache, bonusesCache, seasonBonusesCache,
 * yearlyStandingsCache) transformés en paramètres explicites.
 *
 * Toutes les règles importantes sont portées :
 *   ✓ Élimination des 2 derniers (ou plus si inactifs ≥2 à partir du R7)
 *   ✓ Application des jokers (voleur, multiplicateur, bouclier, sabotage)
 *   ✓ Application des bonus éphémères (embuscade, ravitaillement, marquage, malédiction, kamikaze)
 *   ✓ Application des bonus saisonniers (second souffle, trap, duel, brouillard)
 *   ✓ Règle handicap (malus/bonus selon rang général + 4 éliminations)
 *   ✓ Bonus éphémère au meilleur éliminé (généré par le backend au freeze)
 *   ✓ Jeton rescapé au dernier survivant (2 pts à partir du 2ème consécutif)
 *   ✓ Points challenge principal à l'élimination (lu depuis frozen_results.mainPoints)
 *   ✓ Points challenge éliminés en fin de saison
 *
 * UTILISATION :
 *
 *   import * as Engine from './standings-engine.js';
 *
 *   // Simple : calcul du classement annuel final
 *   const standings = Engine.computeFinalStandings({
 *     activities, currentDate, participants,
 *     frozenResults, bonuses, seasonBonuses
 *   });
 *
 *   // Avancé : accès direct aux fonctions de calcul
 *   const sData = Engine.simulateSeasonEliminations(activities, seasonNumber, currentDate, {
 *     participants, frozenResults
 *   });
 */

import {
  CHALLENGE_CONFIG, PARTICIPANTS, ROUND_RULES, BONUS_TYPES,
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, isFinaleRound,
  getRoundsPerSeason, getRoundsForSeason, getSeasonStartRound, getSeasonType,
  getMainChallengePoints, getEliminatedChallengePoints,
  getLateRegistrations, wasRegisteredBeforeStart,
  formBalancedTeams, getSpecialRuleForRound
} from './config.js';

import { applyJokerEffects } from './jokers.js';

// ============================================
// BONUS HELPERS
// ============================================

/**
 * Récupère les bonus utilisés dans un round donné.
 * Cherche d'abord dans les bonus live, puis dans les bonus archivés par saison.
 * PORTÉ DEPUIS : app.js::getBonusesUsedInRound()
 */
export function getBonusesUsedInRound(roundNumber, bonusesCache, seasonBonusesCache) {
  const liveBonuses = bonusesCache.filter(b => b.used_in_round === roundNumber && b.status === 'used');
  if (liveBonuses.length > 0) return liveBonuses;

  // Fallback: chercher dans les bonus archivés par saison
  for (const [seasonNum, bonuses] of Object.entries(seasonBonusesCache)) {
    const archived = bonuses.filter(b => b.used_in_round === roundNumber && b.status === 'used');
    if (archived.length > 0) return archived;
  }
  return [];
}

/**
 * Récupère les bonus archivés pour un athlète donné (toutes saisons).
 * PORTÉ DEPUIS : app.js::getArchivedBonusesForAthlete()
 */
export function getArchivedBonusesForAthlete(athleteId, seasonBonusesCache) {
  const normalizedId = String(athleteId);
  const result = [];
  for (const [seasonNum, bonuses] of Object.entries(seasonBonusesCache)) {
    for (const b of bonuses) {
      if (String(b.athlete_id) === normalizedId) {
        result.push({ ...b, archivedSeason: parseInt(seasonNum) });
      }
    }
  }
  return result;
}

/**
 * Récupère TOUS les bonus d'un athlète (live + archivés) pour le calcul des effets.
 * PORTÉ DEPUIS : app.js::getAllBonusesForAthlete()
 */
export function getAllBonusesForAthlete(athleteId, bonusesCache, seasonBonusesCache) {
  const normalizedId = String(athleteId);
  const live = bonusesCache.filter(b => String(b.athlete_id) === normalizedId);
  const archived = getArchivedBonusesForAthlete(normalizedId, seasonBonusesCache);
  // Dédupliquer par bonus_id + athlete_id
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
 * Calcule les effets des bonus éphémères pour un joueur ACTIF (challenge principal).
 * Ces effets s'appliquent sur le D+ du round en cours.
 * PORTÉ DEPUIS : app.js::getEphemeralBonusEffectsForActiveAthlete()
 */
export function getEphemeralBonusEffectsForActiveAthlete(athleteId, roundNumber, bonusesCache, seasonBonusesCache) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);

  const roundBonuses = getBonusesUsedInRound(roundNumber, bonusesCache, seasonBonusesCache);

  for (const bonus of roundBonuses) {
    const result = bonus.effect_result;
    if (!result) continue;

    // Embuscade - le joueur actif (cible) PERD du D+ dans le challenge principal
    if (bonus.bonus_id === 'embuscade') {
      const amount = result.stolenElevation || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.lost += amount;
        effects.details.push({ type: 'embuscade_victim', amount, by: bonus.athlete_name, icon: '🏹' });
      }
    }

    // Ravitaillement - le joueur actif (cible) GAGNE du D+ dans le challenge principal
    if (bonus.bonus_id === 'ravitaillement') {
      const amount = result.bonusElevation || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.gained += amount;
        effects.details.push({ type: 'ravitaillement', amount, from: bonus.athlete_name, icon: '🍖' });
      }
    }

    // Note: marquage, malédiction, kamikaze sont des bonus entre éliminés ou ciblent des éliminés
    // Ils ne s'appliquent pas aux joueurs actifs dans le challenge principal
  }

  return effects;
}

/**
 * Calcule les effets des bonus éphémères pour un joueur ÉLIMINÉ (challenge des éliminés).
 * Ces effets s'appliquent sur le D+ cumulé depuis l'élimination.
 * PORTÉ DEPUIS : app.js::getEphemeralBonusEffectsForEliminatedAthlete()
 */
export function getEphemeralBonusEffectsForEliminatedAthlete(athleteId, roundNumber, bonusesCache, seasonBonusesCache) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);

  const roundBonuses = getBonusesUsedInRound(roundNumber, bonusesCache, seasonBonusesCache);

  for (const bonus of roundBonuses) {
    const result = bonus.effect_result;

    // Embuscade - l'éliminé (attaquant) GAGNE du D+ dans le challenge des éliminés
    if (bonus.bonus_id === 'embuscade') {
      const amount = result?.stolenElevation || 0;
      if (amount > 0 && String(bonus.athlete_id) === normalizedId) {
        effects.gained += amount;
        effects.details.push({ type: 'embuscade_gain', amount, from: bonus.target_athlete_name, icon: '🏹' });
      }
    }

    // Ravitaillement - l'éliminé donne mais ne perd rien (c'est une copie)
    // Pas d'effet négatif pour l'éliminé

    // Marquage - pénalité 20% sur un autre éliminé
    if (bonus.bonus_id === 'marquage') {
      const amount = result?.penaltyAmount || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.lost += amount;
        effects.details.push({ type: 'marquage', amount, by: bonus.athlete_name, icon: '🎯' });
      }
    }

    // Malédiction - vol 10% par round entre éliminés
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

    // Kamikaze - perte mutuelle entre éliminés
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

    // Note: trap, second_souffle, duel, brouillard sont des bonus saisonniers
    // traités par getSeasonalBonusEffectsForEliminatedAthlete() (appelé une seule fois)
  }

  return effects;
}

/**
 * Calcule les effets des bonus SAISONNIERS (one-shot) pour un éliminé.
 * Appelé UNE SEULE FOIS par athlète par saison (pas par round).
 * Gère: second_souffle, trap, duel, brouillard
 * PORTÉ DEPUIS : app.js::getSeasonalBonusEffectsForEliminatedAthlete()
 */
export function getSeasonalBonusEffectsForEliminatedAthlete(athleteId, bonusesCache, seasonBonusesCache, allActivities, frozenRoundsMap = null) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);

  const allAthleteBonus = getAllBonusesForAthlete(normalizedId, bonusesCache, seasonBonusesCache);

  // Helper: déterminer la fin de la saison à laquelle appartient un round d'élimination
  // (à partir des rounds figés s'ils sont disponibles, sinon retourne null = pas de borne).
  function getSeasonEndDateForElimRound(elimRound) {
    if (!frozenRoundsMap) return null;
    const elimRoundEntry = frozenRoundsMap[String(elimRound)];
    if (!elimRoundEntry?.seasonNumber) return null;
    const targetSeason = Number(elimRoundEntry.seasonNumber);

    // Trouver le dernier round de cette saison
    let lastRoundOfSeason = null;
    for (const [k, r] of Object.entries(frozenRoundsMap)) {
      if (r && Number(r.seasonNumber) === targetSeason) {
        const rn = Number(k);
        if (lastRoundOfSeason === null || rn > lastRoundOfSeason) {
          lastRoundOfSeason = rn;
        }
      }
    }
    if (lastRoundOfSeason === null) return null;
    const dates = getRoundDates(lastRoundOfSeason);
    return dates?.end || null;
  }

  for (const bonus of allAthleteBonus) {
    // Second Souffle — double la plus petite activité
    if (bonus.bonus_id === 'second_souffle' && (bonus.status === 'active' || bonus.status === 'chosen' || bonus.status === 'used')) {
      const alreadyAdded = effects.details.some(d => d.type === 'second_souffle');
      if (alreadyAdded) continue;

      // Si le bonus a déjà été figé au moment de la clôture de saison, on utilise
      // le effect_result archivé (source de vérité), sans recalculer.
      const result = bonus.effect_result;
      if (result?.frozenAtSeasonClose) {
        if (result.amount > 0) {
          effects.gained += result.amount;
          effects.details.push({
            type: 'second_souffle',
            amount: result.amount,
            activityName: result.activityName || 'activité',
            icon: '🔥'
          });
        }
        continue;
      }

      // Sinon, calcul live (saison en cours, pas encore figée)
      const elimRound = bonus.elimination_round;
      if (!elimRound) continue;

      const seasonEndDate = getSeasonEndDateForElimRound(elimRound);
      const elimActivities = getEliminatedActivities(normalizedId, elimRound, allActivities, seasonEndDate);
      if (elimActivities.length === 0) continue;

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

    // Trap — D+ copié du dernier éliminé
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

    // Duel — info only
    if (bonus.bonus_id === 'duel') {
      const alreadyAdded = effects.details.some(d => d.type === 'duel');
      if (!alreadyAdded) {
        effects.details.push({ type: 'duel', amount: 0, icon: '⚔️' });
      }
    }

    // Brouillard — info only
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
// FROZEN RESULTS / RESCAPÉS
// ============================================

/**
 * Récupère un round figé.
 * PORTÉ DEPUIS : app.js::getFrozenRound()
 */
export function getFrozenRound(globalRoundNumber, frozenResultsCache) {
  if (!frozenResultsCache?.rounds) return null;
  return frozenResultsCache.rounds[String(globalRoundNumber)] || null;
}

/**
 * Récupère l'ID du rescapé du round précédent.
 * Le rescapé est l'avant-avant-dernier du classement (juste au-dessus des 2 éliminés).
 * PORTÉ DEPUIS : app.js::getRescapeFromPreviousRound()
 */
export function getRescapeFromPreviousRound(currentRoundNumber, frozenResultsCache) {
  const previousRound = currentRoundNumber - 1;
  if (previousRound < 1) return null;

  const frozenRound = getFrozenRound(previousRound, frozenResultsCache);
  if (!frozenRound || !frozenRound.ranking || frozenRound.ranking.length < 4) {
    return null;
  }

  // L'avant-avant-dernier = position ranking.length - 2 (0-indexed: length - 3)
  // Exemple: 10 joueurs -> positions 0-9, éliminés = 8,9, rescapé = 7
  const rescapeIndex = frozenRound.ranking.length - 3;
  const rescapeEntry = frozenRound.ranking[rescapeIndex];

  if (rescapeEntry) {
    return String(rescapeEntry.id);
  }

  return null;
}

/**
 * Calcule les points rescapé pour tous les joueurs d'une saison.
 * Règles :
 *   - Rescapé = dernier survivant du classement (juste au-dessus des éliminés)
 *   - 1ère fois consécutive : jeton (0 pts)
 *   - 2ème+ fois consécutive : +2 pts
 *   - Si le joueur quitte la position rescapé : compteur reset
 *
 * PORTÉ DEPUIS : app.js::calculateRescapePointsForSeason()
 */
export function calculateRescapePointsForSeason(seasonNumber, frozenResultsCache) {
  const result = {};
  PARTICIPANTS.forEach(p => {
    result[p.id] = { totalPoints: 0, streaks: [] };
  });

  if (!frozenResultsCache?.rounds) return result;

  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  // Tracker le compteur consécutif par joueur
  const consecutiveCount = {};
  PARTICIPANTS.forEach(p => { consecutiveCount[p.id] = 0; });

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const round = frozenResultsCache.rounds[String(roundNum)];
    if (!round?.frozen || !round.ranking || round.ranking.length < 4) continue;

    const eliminations = round.eliminations || [];
    if (eliminations.length === 0) continue;

    // Trouver le rescapé de ce round
    const eliminatedIds = new Set(eliminations.map(e => String(e.id)));
    const roundInSeason = ((roundNum - 1) % roundsPerSeason) + 1;
    const isFinale = roundInSeason === roundsPerSeason;

    // Pas de rescapé en finale
    if (isFinale) {
      PARTICIPANTS.forEach(p => { consecutiveCount[p.id] = 0; });
      continue;
    }

    // Le rescapé = dernier survivant du classement (dernier non-éliminé)
    const survivors = round.ranking.filter(e => !eliminatedIds.has(String(e.id)));
    const rescapeEntry = survivors.length > 0 ? survivors[survivors.length - 1] : null;
    const rescapeId = rescapeEntry ? String(rescapeEntry.id) : null;

    // Mettre à jour les compteurs
    PARTICIPANTS.forEach(p => {
      const pid = p.id;
      if (eliminatedIds.has(pid)) {
        // Éliminé → reset
        consecutiveCount[pid] = 0;
        return;
      }

      if (pid === rescapeId) {
        consecutiveCount[pid]++;
        const streak = consecutiveCount[pid];
        let pts = 0;
        if (streak >= 2) {
          pts = 2;
        }
        result[pid].streaks.push({
          round: roundNum,
          roundInSeason,
          consecutive: streak,
          points: pts
        });
        result[pid].totalPoints += pts;
      } else {
        // Pas rescapé ce round → reset
        consecutiveCount[pid] = 0;
      }
    });
  }

  return result;
}

/**
 * Récupère les infos rescapé d'un round spécifique (pour l'affichage historique).
 * PORTÉ DEPUIS : app.js::getRescapeInfoForRound()
 */
export function getRescapeInfoForRound(globalRoundNumber, frozenResultsCache) {
  const roundsPerSeason = getRoundsPerSeason();
  const seasonNumber = Math.ceil(globalRoundNumber / roundsPerSeason);
  const rescapeData = calculateRescapePointsForSeason(seasonNumber, frozenResultsCache);

  for (const [athleteId, data] of Object.entries(rescapeData)) {
    const streak = data.streaks.find(s => s.round === globalRoundNumber);
    if (streak) {
      return {
        athleteId,
        consecutive: streak.consecutive,
        points: streak.points
      };
    }
  }
  return null;
}

// ============================================
// UTILITAIRES ACTIVITÉS
// ============================================

/**
 * Retourne l'heure de fin d'une activité (start_date + elapsed_time).
 * PORTÉ DEPUIS : app.js::getActivityEndTime()
 */
export function getActivityEndTime(activity) {
  const start = new Date(activity.start_date).getTime();
  const elapsedMs = (activity.elapsed_time || 0) * 1000;
  return start + elapsedMs;
}

/**
 * Filtre les activités dans une période (inclusif).
 * Utilise l'heure de FIN pour rattacher au bon round.
 * PORTÉ DEPUIS : app.js::filterByPeriod()
 */
export function filterByPeriod(activities, startDate, endDate) {
  const start = new Date(startDate).setHours(0, 0, 0, 0);
  const end = new Date(endDate).setHours(23, 59, 59, 999);
  return activities.filter(a => {
    // Ignorer les activités exclues par l'admin
    if (a.excluded) return false;
    const date = getActivityEndTime(a);
    return date >= start && date <= end;
  });
}

/**
 * Filtre les activités d'un athlète.
 * PORTÉ DEPUIS : app.js::filterByParticipant()
 */
export function filterByParticipant(activities, participantId) {
  const pid = String(participantId);
  return activities.filter(a => {
    const athleteId = a.athlete?.id || a.athlete_id;
    return String(athleteId) === pid;
  });
}

/**
 * Calcule les statistiques cumulées d'une liste d'activités.
 * PORTÉ DEPUIS : app.js::calculateStats()
 */
export function calculateStats(activities) {
  return {
    elevation: activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0),
    distance: activities.reduce((sum, a) => sum + (a.distance || 0), 0),
    activities: activities.length,
    movingTime: activities.reduce((sum, a) => sum + (a.moving_time || 0), 0)
  };
}

/**
 * Calcule le classement des participants actifs pour un ensemble d'activités.
 * PORTÉ DEPUIS : app.js::calculateRanking()
 */
export function calculateRanking(activities, activeParticipants) {
  const participantsList = activeParticipants.length > 0 ? activeParticipants : PARTICIPANTS;

  return participantsList
    .map(participant => {
      const pActivities = filterByParticipant(activities, participant.id);
      const stats = calculateStats(pActivities);
      return {
        participant,
        totalElevation: stats.elevation,
        totalDistance: stats.distance,
        activityCount: stats.activities,
        activities: pActivities
      };
    })
    .sort((a, b) => b.totalElevation - a.totalElevation)
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}

/**
 * Récupère les activités d'un éliminé depuis son élimination.
 * @param {string} athleteId
 * @param {number} eliminationRound
 * @param {Array} allActivities
 * @param {Date} [endDate] - Borne supérieure optionnelle (utile pour second_souffle :
 *   le bonus ne doit considérer que les activités de la saison où il a été choisi).
 *   Si omis, retourne les activités jusqu'à aujourd'hui.
 * PORTÉ DEPUIS : app.js::getEliminatedActivities()
 */
export function getEliminatedActivities(athleteId, eliminationRound, allActivities, endDate = null) {
  const roundDates = getRoundDates(eliminationRound);
  const startDate = new Date(roundDates.end);
  startDate.setDate(startDate.getDate() + 1);
  const startMs = startDate.getTime();
  const endMs = endDate instanceof Date ? endDate.getTime() : null;

  return allActivities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    const t = getActivityEndTime(a);
    if (t < startMs) return false;
    if (endMs !== null && t > endMs) return false;
    return true;
  });
}

/**
 * Calcule le D+ d'un éliminé depuis son élimination.
 * PORTÉ DEPUIS : app.js::getEliminatedElevationSince()
 */
export function getEliminatedElevationSince(athleteId, eliminationRound, allActivities) {
  const activities = getEliminatedActivities(athleteId, eliminationRound, allActivities);
  return activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
}

/**
 * Calcule le D+ d'un athlète pour un round donné.
 * PORTÉ DEPUIS : app.js::getRoundElevation()
 */
export function getRoundElevation(athleteId, roundDates, allActivities) {
  if (!allActivities) return 0;
  const startMs = roundDates.start.getTime();
  const endMs = roundDates.end.getTime();
  const activities = allActivities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    const endTime = getActivityEndTime(a);
    return endTime >= startMs && endTime <= endMs;
  });
  return activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
}

/**
 * Récupère les activités éligibles pour un bonus (>20min).
 * PORTÉ DEPUIS : app.js::getEligibleActivitiesForBonus()
 */
export function getEligibleActivitiesForBonus(athleteId, roundNumber, allActivities) {
  if (!allActivities) return [];

  let activities = allActivities;
  if (roundNumber) {
    const roundDates = getRoundDates(roundNumber);
    activities = filterByPeriod(allActivities, roundDates.start, roundDates.end);
  }

  return activities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    const duration = a.moving_time || a.elapsed_time || 0;
    return duration >= 20 * 60; // 20 minutes en secondes
  });
}

/**
 * Trouve le co-éliminé d'un joueur.
 * PORTÉ DEPUIS : app.js::findCoEliminated()
 */
export function findCoEliminated(athleteId, eliminationRound, frozenResultsCache) {
  if (!frozenResultsCache?.rounds) return null;
  const roundData = frozenResultsCache.rounds[String(eliminationRound)];
  if (!roundData?.eliminations) return null;

  const coElim = roundData.eliminations.find(e => String(e.id) !== String(athleteId));
  return coElim?.id || null;
}

// ============================================
// RÈGLE HANDICAP
// ============================================

/**
 * Applique la règle Handicap sur le ranking du round.
 * - Top 10 du classement général : malus dégressif sur le D+
 * - 5 derniers du classement général : bonus de +10%
 * Le ranking est re-trié après application.
 * PORTÉ DEPUIS : app.js::applyHandicapRule()
 */
export function applyHandicapRule(ranking, yearlyStandings) {
  const rule = ROUND_RULES.handicap;
  if (!rule?.parameters) return ranking;

  const { malusPerPosition, bonusLastCount, bonusLastPercent } = rule.parameters;

  // Créer un map rang classement général → participant
  const generalRankMap = {};
  const totalParticipants = yearlyStandings.length;
  yearlyStandings.forEach(e => {
    generalRankMap[String(e.participant.id)] = e.rank;
  });

  const adjusted = ranking.map(entry => {
    const pid = String(entry.participant.id);
    const generalRank = generalRankMap[pid];
    const rawElevation = entry.totalElevation;
    let adjustmentPercent = 0;
    let adjustmentLabel = null;

    if (generalRank && malusPerPosition[generalRank]) {
      // Malus pour le top 10
      adjustmentPercent = -malusPerPosition[generalRank];
      adjustmentLabel = `${adjustmentPercent}% (${generalRank}${generalRank === 1 ? 'ᵉʳ' : 'ᵉ'} au général)`;
    } else if (generalRank && totalParticipants - generalRank < bonusLastCount) {
      // Bonus pour les 5 derniers
      adjustmentPercent = bonusLastPercent;
      adjustmentLabel = `+${adjustmentPercent}% (${generalRank}${generalRank === 1 ? 'ᵉʳ' : 'ᵉ'} au général)`;
    }

    const adjustedElevation = adjustmentPercent !== 0
      ? Math.round(rawElevation * (1 + adjustmentPercent / 100))
      : rawElevation;

    return {
      ...entry,
      rawElevation,
      adjustmentPercent,
      adjustmentLabel,
      totalElevation: adjustedElevation
    };
  });

  // Re-trier par D+ ajusté
  adjusted.sort((a, b) => b.totalElevation - a.totalElevation);
  adjusted.forEach((e, i) => { e.position = i + 1; });

  return adjusted;
}

// ============================================
// SIMULATION DES ÉLIMINATIONS
// ============================================

/**
 * Simulation pour les saisons en mode ÉQUIPE.
 * PORTÉ DEPUIS : app.js::simulateTeamSeasonEliminations()
 */
export function simulateTeamSeasonEliminations(activities, seasonNumber, currentDate, yearlyStandingsCache, frozenResultsCache) {
  const seasonDates = getSeasonDates(seasonNumber);
  const seasonStartRound = getSeasonStartRound(seasonNumber);
  const maxRounds = getRoundsForSeason(seasonNumber);

  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Calculer les points du classement général pour l'équilibrage
  const yearlyStandings = yearlyStandingsCache || [];
  const pointsMap = {};
  yearlyStandings.forEach(e => { pointsMap[e.participant.id] = e.totalPoints || 0; });
  PARTICIPANTS.forEach(p => { if (!(p.id in pointsMap)) pointsMap[p.id] = 0; });

  for (let roundInSeason = 1; roundInSeason <= maxRounds; roundInSeason++) {
    if (active.length <= 1) break;

    const globalRound = seasonStartRound + roundInSeason - 1;
    const roundDates = getRoundDates(globalRound);

    // Round pas encore commencé
    if (currentDate < roundDates.start) break;

    // Round en cours (pas terminé)
    if (currentDate <= roundDates.end) {
      const teams = formBalancedTeams(active, pointsMap, globalRound);
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);

      const teamsWithElevation = teams.map(team => {
        const membersWithElev = team.members.map(m => {
          const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
          const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
          return { ...m, elevation: elev };
        }).sort((a, b) => b.elevation - a.elevation);

        return {
          ...team,
          members: membersWithElev,
          totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
        };
      }).sort((a, b) => b.totalElevation - a.totalElevation);

      roundResults.push({
        round: roundInSeason,
        status: 'active',
        active: [...active],
        teams: teamsWithElevation,
        eliminated: []
      });
      break;
    }

    // ROUND TERMINÉ — vérifier si figé
    const frozenRound = getFrozenRound(globalRound, frozenResultsCache);

    if (frozenRound && frozenRound.frozen) {
      frozenRound.eliminations.forEach(elim => {
        const participant = PARTICIPANTS.find(p => String(p.id) === String(elim.id));
        if (participant) {
          eliminated.push({
            ...participant,
            eliminatedRound: roundInSeason,
            eliminatedSeason: seasonNumber,
            zeroElimination: elim.reason === 'zero_elevation'
          });
          active = active.filter(a => String(a.id) !== String(elim.id));
        }
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: frozenRound.ranking,
        teams: frozenRound.teams || null,
        eliminated: frozenRound.eliminations.map(e => e.id),
        frozen: true
      });
    } else {
      // CALCULER — round terminé mais pas encore figé
      const teams = formBalancedTeams(active, pointsMap, globalRound);
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);

      const teamsWithElevation = teams.map(team => {
        const membersWithElev = team.members.map(m => {
          const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
          const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
          return { ...m, elevation: elev };
        }).sort((a, b) => b.elevation - a.elevation);

        return {
          ...team,
          members: membersWithElev,
          totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
        };
      }).sort((a, b) => b.totalElevation - a.totalElevation);

      const lastTeam = teamsWithElevation[teamsWithElevation.length - 1];
      const teamMembersSorted = [...lastTeam.members].sort((a, b) => a.elevation - b.elevation);

      teamMembersSorted.forEach((member, idx) => {
        const position = active.length - idx;
        const mainPts = getMainChallengePoints(position);

        eliminated.push({
          ...PARTICIPANTS.find(p => p.id === member.id) || member,
          eliminatedRound: roundInSeason,
          eliminatedSeason: seasonNumber,
          zeroElimination: member.elevation === 0,
          teamElimination: true,
          mainPoints: mainPts
        });
        active = active.filter(a => a.id !== member.id);
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        teams: teamsWithElevation,
        eliminatedTeamIndex: teamsWithElevation.length - 1,
        eliminated: lastTeam.members.map(m => m.id)
      });
    }

    if (active.length <= 3) {
      return {
        seasonComplete: active.length <= 1,
        winner: active.length === 1 ? active[0] : null,
        active,
        eliminated,
        roundResults,
        isTeamSeason: true,
        actualRoundsPlayed: roundInSeason
      };
    }
  }

  return {
    seasonComplete: false,
    active,
    eliminated,
    roundResults,
    isTeamSeason: true,
    actualRoundsPlayed: roundResults.length
  };
}

/**
 * Simulation des éliminations pour une saison individuelle.
 * PORTÉ DEPUIS : app.js::simulateSeasonEliminations()
 */
export function simulateSeasonEliminations(activities, seasonNumber, currentDate, frozenResultsCache, yearlyStandingsCache) {
  const seasonType = getSeasonType(seasonNumber);

  // Branchement vers la logique Équipe si applicable
  if (seasonType?.isTeamBased) {
    return simulateTeamSeasonEliminations(activities, seasonNumber, currentDate, yearlyStandingsCache, frozenResultsCache);
  }

  const seasonDates = getSeasonDates(seasonNumber);

  // TOUS les participants (éligibles + tardifs) pour le calcul du nombre de rounds
  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Inscriptions tardives = éliminées d'office au Round 1 (comptent dans le quota)
  const lateRegistrations = getLateRegistrations();

  // Calculer le nombre de rounds pour cette saison
  const maxRoundsPerSeason = getRoundsForSeason(seasonNumber);
  const seasonStartRoundGlobal = getSeasonStartRound(seasonNumber);

  for (let roundInSeason = 1; roundInSeason <= maxRoundsPerSeason; roundInSeason++) {
    // VÉRIFICATION: Si plus qu'un seul joueur actif, la saison est finie
    if (active.length <= 1) {
      break;
    }

    const globalRound = seasonStartRoundGlobal + roundInSeason - 1;
    const roundDates = getRoundDates(globalRound);

    // Round pas encore commencé
    if (currentDate < roundDates.start) break;

    // Round en cours (pas encore terminé)
    if (currentDate <= roundDates.end) {
      roundResults.push({
        round: roundInSeason,
        status: 'active',
        active: [...active],
        eliminated: []
      });
      break;
    }

    // ============================================
    // VÉRIFIER SI LE ROUND EST FIGÉ
    // ============================================
    const frozenRound = getFrozenRound(globalRound, frozenResultsCache);

    if (frozenRound && frozenRound.frozen) {
      // UTILISER LES RÉSULTATS FIGÉS
      frozenRound.eliminations.forEach(elim => {
        const participant = PARTICIPANTS.find(p => String(p.id) === String(elim.id));
        if (participant) {
          eliminated.push({
            ...participant,
            eliminatedRound: roundInSeason,
            eliminatedSeason: seasonNumber,
            zeroElimination: elim.reason === 'zero_elevation'
          });
          active = active.filter(a => String(a.id) !== String(elim.id));
        }
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: frozenRound.ranking,
        eliminated: frozenRound.eliminations.map(e => e.id),
        frozen: true
      });

    } else {
      // CALCULER LES RÉSULTATS (round non figé - RÈGLES SIMPLES)
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
      const ranking = calculateRanking(roundActivities, active);

      // Appliquer les effets des jokers
      const rankingWithEffects = applyJokerEffects(ranking, globalRound);

      // ============================================
      // RÈGLES D'ÉLIMINATION
      // ============================================
      const toEliminate = [];

      // Vérifier si ce round a une règle spéciale avec override d'éliminations
      const roundSpecialRule = getSpecialRuleForRound(globalRound);
      const roundRuleDetails = roundSpecialRule ? (ROUND_RULES[roundSpecialRule] || null) : null;
      const roundElimCount = roundRuleDetails?.parameters?.eliminationsOverride || CHALLENGE_CONFIG.eliminationsPerRound;

      // Déterminer si c'est une finale
      const isCurrentRoundFinale = active.length <= roundElimCount + 1;

      // Joueurs éligibles (sans bouclier)
      const eligibleForElimination = rankingWithEffects.filter(e => !e.jokerEffects?.hasShield);

      // Joueurs à 0 D+ (éligibles uniquement)
      const zeroElevationPlayers = eligibleForElimination.filter(e => e.totalElevation === 0);

      // Appliquer les nouvelles règles seulement à partir du R7
      const useNewRules = globalRound >= 7;

      if (isCurrentRoundFinale) {
        // FINALE: éliminer tous sauf 1
        eligibleForElimination.slice(1).forEach(entry => {
          toEliminate.push({
            ...entry.participant,
            zeroElimination: entry.totalElevation === 0
          });
        });
      } else if (useNewRules && zeroElevationPlayers.length >= 2) {
        // NOUVELLE RÈGLE (R7+): Si ≥2 joueurs à 0 D+ → éliminer TOUS les 0 D+
        zeroElevationPlayers.forEach(entry => {
          toEliminate.push({
            ...entry.participant,
            zeroElimination: true
          });
        });
      } else {
        // RÈGLE NORMALE: éliminer les N derniers (2 par défaut, 4 pour handicap)
        const eliminationsNeeded = roundElimCount;

        // Round 1: Les inscriptions tardives sont éliminées en PREMIER (comptent dans le quota)
        if (roundInSeason === 1 && lateRegistrations.length > 0) {
          lateRegistrations.forEach(p => {
            if (toEliminate.length < eliminationsNeeded && active.find(a => a.id === p.id)) {
              toEliminate.push({
                ...p,
                zeroElimination: false,
                lateRegistration: true
              });
            }
          });
        }

        // Compléter avec les derniers du classement
        for (let i = eligibleForElimination.length - 1; i >= 0 && toEliminate.length < eliminationsNeeded; i--) {
          const entry = eligibleForElimination[i];
          if (toEliminate.find(e => e.id === entry.participant.id)) continue;

          toEliminate.push({
            ...entry.participant,
            zeroElimination: entry.totalElevation === 0
          });
        }
      }

      toEliminate.forEach(p => {
        eliminated.push({
          ...p,
          eliminatedRound: roundInSeason,
          eliminatedSeason: seasonNumber,
          zeroElimination: p.zeroElimination || false,
          lateRegistration: p.lateRegistration || false
        });
        active = active.filter(a => a.id !== p.id);
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: rankingWithEffects,
        eliminated: toEliminate.map(p => p.id)
      });
    }

    // Vérifier si la saison est terminée (un seul joueur restant)
    if (active.length <= 1) {
      return {
        seasonComplete: true,
        winner: active[0] || null,
        active,
        eliminated,
        roundResults,
        actualRoundsPlayed: roundInSeason
      };
    }
  }

  return {
    seasonComplete: false,
    active,
    eliminated,
    roundResults,
    actualRoundsPlayed: roundResults.length
  };
}

// ============================================
// CHALLENGE DES ÉLIMINÉS
// ============================================

/**
 * Retourne le classement figé du challenge éliminés pour une saison, s'il existe.
 * Source : frozen_results.json → eliminatedChallengeRankings[seasonNumber].ranking
 *
 * Format retourné compatible avec le résultat de calculateEliminatedChallenge +
 * application des bonus : objets avec { participant, id, name, totalElevation,
 * rawElevation, bonusEffects, position, points }.
 *
 * Permet à calculateYearlyStandings/calculatePointsForSeason d'éviter le
 * recalcul complet (bonus éphémères + saisonniers + retri) pour les saisons
 * déjà terminées et figées.
 *
 * @returns {Array|null} ranking (copie défensive) ou null si absent/invalide.
 */
export function getCachedEliminatedChallengeRanking(seasonNumber, frozenResultsCache) {
  if (!frozenResultsCache || typeof frozenResultsCache !== 'object') return null;
  const cache = frozenResultsCache.eliminatedChallengeRankings;
  if (!cache || typeof cache !== 'object') return null;
  const entry = cache[String(seasonNumber)];
  if (!entry || !Array.isArray(entry.ranking)) return null;
  // Copie défensive pour éviter que les consommateurs modifient la source
  return entry.ranking.map(r => ({ ...r, bonusEffects: r.bonusEffects ? { ...r.bonusEffects } : undefined }));
}

/**
 * Calcule le classement du challenge des éliminés.
 * PORTÉ DEPUIS : app.js::calculateEliminatedChallenge()
 */
export function calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate) {
  const ranking = [];
  const endDate = currentDate < seasonDates.end ? currentDate : seasonDates.end;
  const roundsPerSeason = getRoundsPerSeason();

  for (const p of eliminatedList) {
    // Calculer le round global à partir du round dans la saison et de la saison d'élimination
    const globalRound = (p.eliminatedSeason - 1) * roundsPerSeason + p.eliminatedRound;
    const roundDates = getRoundDates(globalRound);

    // L'éliminé peut participer dès la fin de son round d'élimination
    const eliminationDate = new Date(roundDates.end);

    // Vérifier que le round d'élimination est bien terminé
    if (currentDate < eliminationDate) continue;

    // Les activités comptent à partir du lendemain de l'élimination
    const startDate = new Date(eliminationDate);
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    // Même si pas encore d'activités, l'éliminé doit apparaître
    let pActs = [];
    let stats = { elevation: 0, distance: 0, activities: 0 };

    if (startDate <= endDate) {
      pActs = filterByParticipant(filterByPeriod(activities, startDate, endDate), p.id);
      stats = calculateStats(pActs);
    }

    ranking.push({
      participant: p,
      totalElevation: stats.elevation,
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
    e.points = getEliminatedChallengePoints(e.position);
  });
  return ranking;
}

/**
 * Compte le nombre total d'éliminés avant un round donné dans une saison.
 * PORTÉ DEPUIS : app.js::countEliminationsBeforeRound()
 */
export function countEliminationsBeforeRound(eliminatedList, roundInSeason) {
  return eliminatedList.filter(e => e.eliminatedRound < roundInSeason).length;
}

// ============================================
// CLASSEMENT ANNUEL
// ============================================

/**
 * Calcule le classement annuel complet.
 * PORTÉ DEPUIS : app.js::calculateYearlyStandings()
 */
export function calculateYearlyStandings(activities, currentDate, frozenResultsCache, bonusesCache, seasonBonusesCache) {
  const currentSeason = getSeasonNumber(currentDate);
  const totals = {};

  // Initialiser pour TOUS les participants
  PARTICIPANTS.forEach(p => {
    totals[p.id] = {
      participant: p,
      totalMainPoints: 0,
      totalEliminatedPoints: 0,
      totalRescapePoints: 0,
      totalPoints: 0,
      wins: 0,
      seasonsPlayed: 0,
      isLateRegistration: !wasRegisteredBeforeStart(p)
    };
  });

  for (let s = 1; s <= currentSeason; s++) {
    const seasonDates = getSeasonDates(s);
    if (currentDate < seasonDates.start) continue;

    const sData = simulateSeasonEliminations(activities, s, currentDate, frozenResultsCache);

    // Règle métier : les points du challenge des éliminés n'apparaissent dans
    // le classement général qu'une fois la saison TERMINÉE ET FIGÉE (cache
    // eliminatedChallengeRankings rempli). Pendant la saison en cours, ils
    // restent invisibles (0 pour tous).
    //
    // Note : on se fie à l'existence du cache plutôt qu'à sData.seasonComplete
    // car celui-ci peut retourner false à la date exacte de fin de saison
    // (currentDate === R7.dates.end → round marqué "active" et boucle break).
    const cached = getCachedEliminatedChallengeRanking(s, frozenResultsCache);
    const elimPointsMap = {};

    if (cached) {
      // Saison terminée ET figée : on lit directement les points figés
      cached.forEach(e => {
        const id = String(e.participant?.id ?? e.id);
        elimPointsMap[id] = e.points;
      });
    }
    // Sinon (saison en cours OU saison finie mais pas encore figée) : points elim invisibles (0)

    // Calculer les points rescapé de cette saison
    const rescapeData = calculateRescapePointsForSeason(s, frozenResultsCache);

    // Calcul des points pour TOUS les participants
    PARTICIPANTS.forEach(p => {
      const elim = sData.eliminated.find(e => e.id === p.id);
      let mainPts = 0, elimPts = 0;

      if (elim) {
        const elimsBeforeThisRound = countEliminationsBeforeRound(sData.eliminated, elim.eliminatedRound);
        const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;
        const sameRoundElims = sData.eliminated.filter(e => e.eliminatedRound === elim.eliminatedRound);
        const indexInRound = sameRoundElims.findIndex(e => e.id === elim.id);
        const position = activeAtRoundStart - indexInRound;
        mainPts = getMainChallengePoints(Math.max(1, Math.min(position, PARTICIPANTS.length)));
        elimPts = elimPointsMap[p.id] || 0;
      } else if (sData.winner?.id === p.id) {
        mainPts = getMainChallengePoints(1);
        totals[p.id].wins++;
      } else if (sData.seasonComplete) {
        mainPts = getMainChallengePoints(2);
      }

      // Points rescapé
      const rescapePts = rescapeData[p.id]?.totalPoints || 0;

      if (sData.seasonComplete || elim) {
        totals[p.id].totalMainPoints += mainPts;
        totals[p.id].totalEliminatedPoints += elimPts;
        totals[p.id].totalRescapePoints += rescapePts;
        totals[p.id].totalPoints += mainPts + elimPts + rescapePts;
        if (sData.seasonComplete) {
          totals[p.id].seasonsPlayed++;
        }
      } else {
        // Saison en cours : ajouter les points rescapé même pour les joueurs encore actifs
        totals[p.id].totalRescapePoints += rescapePts;
        totals[p.id].totalPoints += rescapePts;
      }
    });
  }

  const standings = Object.values(totals);
  standings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins);
  standings.forEach((e, i) => e.rank = i + 1);
  return standings;
}

// ============================================
// CALCUL DES POINTS DEPUIS FROZEN RESULTS
// ============================================

/**
 * Calcule les points depuis les résultats figés.
 * PORTÉ DEPUIS : app.js::calculatePointsFromFrozenResults()
 */
export function calculatePointsFromFrozenResults(frozenResultsCache, currentDate = null) {
  const pointsMap = {};

  PARTICIPANTS.forEach(p => {
    pointsMap[p.id] = {
      mainPoints: 0,
      elimPoints: 0,
      bonusPoints: 0,
      currentRoundPoints: 0,
      wins: 0
    };
  });

  if (!frozenResultsCache?.rounds) return pointsMap;

  // Parcourir tous les rounds figés
  const frozenRounds = Object.entries(frozenResultsCache.rounds)
    .map(([key, value]) => ({ roundNum: parseInt(key), ...value }))
    .sort((a, b) => a.roundNum - b.roundNum);

  // Si currentDate est fourni, on ignore les rounds dont la fin est STRICTEMENT après.
  // Un round exactement à currentDate est inclus (son résultat est déjà figé à ce moment).
  const cutoffTime = currentDate ? new Date(currentDate).getTime() : null;

  for (const round of frozenRounds) {
    if (!round.frozen || !round.ranking) continue;
    if (cutoffTime !== null) {
      const roundEndTime = round.dates?.end ? new Date(round.dates.end).getTime() : null;
      if (roundEndTime !== null && roundEndTime > cutoffTime) continue;
    }

    // Ajouter les mainPoints de chaque participant dans ce round
    for (const entry of round.ranking) {
      const id = String(entry.id);
      if (!pointsMap[id]) continue;

      // Les mainPoints sont attribués aux éliminés et au gagnant dans frozen_results
      if (entry.mainPoints > 0) {
        pointsMap[id].mainPoints += entry.mainPoints;
      }

      // Vérifier si c'est un gagnant de saison
      if (entry.isWinner) {
        pointsMap[id].wins++;
      }
    }
  }

  return pointsMap;
}

/**
 * Calcule les points pour une saison donnée depuis les résultats figés.
 * PORTÉ DEPUIS : app.js::calculatePointsForSeason()
 */
export function calculatePointsForSeason(seasonNumber, activities, currentDate, frozenResultsCache, bonusesCache, seasonBonusesCache) {
  const pointsMap = {};

  PARTICIPANTS.forEach(p => {
    pointsMap[p.id] = { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };
  });

  if (!frozenResultsCache?.rounds || seasonNumber < 1) return pointsMap;

  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const round = frozenResultsCache.rounds[String(roundNum)];
    if (!round?.frozen || !round.ranking) continue;

    for (const entry of round.ranking) {
      const id = String(entry.id);
      if (!pointsMap[id]) continue;

      if (entry.mainPoints > 0) {
        pointsMap[id].mainPoints += entry.mainPoints;
      }
    }
  }

  // Calculer les elimPoints : seulement si la saison est terminée ET figée
  const sData = simulateSeasonEliminations(activities, seasonNumber, currentDate, frozenResultsCache);

  if (sData.eliminated.length > 0) {
    // Règle métier : points elim visibles UNIQUEMENT pour les saisons terminées
    // et figées. On se fie à l'existence du cache (plus fiable que sData.seasonComplete).
    const cached = getCachedEliminatedChallengeRanking(seasonNumber, frozenResultsCache);

    if (cached) {
      for (const e of cached) {
        const id = String(e.participant?.id ?? e.id);
        if (pointsMap[id]) {
          pointsMap[id].elimPoints = e.points || 0;
        }
      }
    }
    // Sinon : on laisse elimPoints à 0 (initialisés à 0 plus haut)
  }

  // Calculer les points rescapé
  const rescapeData = calculateRescapePointsForSeason(seasonNumber, frozenResultsCache);
  for (const id in pointsMap) {
    pointsMap[id].rescapePoints = rescapeData[id]?.totalPoints || 0;
  }

  // Calculer le total
  for (const id in pointsMap) {
    pointsMap[id].total = pointsMap[id].mainPoints + pointsMap[id].elimPoints + pointsMap[id].rescapePoints;
  }

  return pointsMap;
}

// ============================================
// API ORCHESTRATION (spécifique au besoin de stats.js)
// ============================================

/**
 * Calcule le classement annuel final COMPLET (équivalent de renderFinalStandings sans le HTML).
 *
 * @param {Object} params
 * @param {Array}  params.activities
 * @param {Date}   params.currentDate
 * @param {Object} params.frozenResults   - contenu de /api/frozen-results
 * @param {Array}  params.bonuses         - contenu de /api/bonuses/all
 */
export function computeFinalStandings({ activities, currentDate, frozenResults, bonuses = [] }) {
  const frozenResultsCache = frozenResults;
  const seasonBonusesCache = frozenResults?.seasonBonuses || {};
  const bonusesCache = bonuses;

  // 1. Classement annuel complet (main + elim + rescape)
  const yearlyStandings = calculateYearlyStandings(
    activities, currentDate, frozenResultsCache, bonusesCache, seasonBonusesCache
  );

  // 2. Enrichissement depuis les données figées (source de vérité pour mainPoints)
  //    Borner par currentDate pour que les snapshots historiques (ex: fin S1) ne prennent
  //    pas en compte les rounds postérieurs.
  const frozenPoints = calculatePointsFromFrozenResults(frozenResultsCache, currentDate);

  // 3. Breakdown par saison pour affichage (comme renderFinalStandings)
  const currentSeasonNumber = getSeasonNumber(currentDate);
  const previousSeasonPoints = calculatePointsForSeason(
    currentSeasonNumber - 1, activities, currentDate, frozenResultsCache, bonusesCache, seasonBonusesCache
  );
  const currentSeasonPoints = calculatePointsForSeason(
    currentSeasonNumber, activities, currentDate, frozenResultsCache, bonusesCache, seasonBonusesCache
  );

  // 4. Enrichir les standings (réplique exacte de renderFinalStandings())
  const enrichedStandings = yearlyStandings.map(e => {
    const id = String(e.participant.id);
    const frozen = frozenPoints[id] || { mainPoints: 0, elimPoints: 0, bonusPoints: 0, wins: 0 };
    const prevSeason = previousSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };
    const currSeason = currentSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };

    // Utiliser les points figés s'ils sont supérieurs (plus fiables)
    const mainPts = Math.max(e.totalMainPoints || 0, frozen.mainPoints);
    const elimPts = e.totalEliminatedPoints || 0;
    const rescapePts = e.totalRescapePoints || 0;
    const bonusPts = frozen.bonusPoints || 0;
    const wins = Math.max(e.wins || 0, frozen.wins);

    return {
      ...e,
      totalMainPoints: mainPts,
      totalEliminatedPoints: elimPts,
      totalRescapePoints: rescapePts,
      bonusPoints: bonusPts,
      totalPoints: mainPts + elimPts + rescapePts + bonusPts,
      wins,
      previousSeasonTotal: prevSeason.total,
      currentSeasonMain: currSeason.mainPoints,
      currentSeasonElim: currSeason.elimPoints,
      currentSeasonRescape: currSeason.rescapePoints,
      currentSeasonTotal: currSeason.total
    };
  });

  // Re-trier
  enrichedStandings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins || b.totalMainPoints - a.totalMainPoints);
  enrichedStandings.forEach((e, i) => e.rank = i + 1);

  return enrichedStandings;
}

/**
 * Calcule le classement tel qu'il était à la fin d'une saison donnée.
 * Utile pour tracer l'évolution saison par saison.
 */
export function computeStandingsAtEndOfSeason(params, targetSeason) {
  const seasonDates = getSeasonDates(targetSeason);
  return computeFinalStandings({
    ...params,
    currentDate: seasonDates.end
  });
}