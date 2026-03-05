/**
 * ============================================
 * VERSANT - GESTION DES RÉSULTATS FIGÉS
 * ============================================
 * 
 * Ce module stocke les résultats de chaque round de façon DÉFINITIVE.
 * Une fois un round terminé, ses résultats ne changent JAMAIS.
 * 
 * Structure du fichier frozen_results.json:
 * {
 *   "rounds": {
 *     "1": {
 *       "roundNumber": 1,
 *       "seasonNumber": 1,
 *       "roundInSeason": 1,
 *       "dates": { "start": "2026-02-02", "end": "2026-02-06" },
 *       "frozen": true,
 *       "frozenAt": "2026-02-07T00:00:00Z",
 *       "activeParticipants": ["id1", "id2", ...],
 *       "ranking": [
 *         { "id": "123", "name": "Jean", "elevation": 1500, "position": 1, "points": 24 }
 *       ],
 *       "eliminations": [
 *         { "id": "456", "name": "Pierre", "elevation": 100, "reason": "last", "position": 12 }
 *       ],
 *       "jokersUsed": [
 *         { "athleteId": "123", "jokerId": "voleur", "targetId": "456" }
 *       ]
 *     }
 *   }
 * }
 */

const fs = require('fs').promises;
const path = require('path');

// Configuration
const DATA_DIR = path.join(__dirname, 'data');
const FROZEN_FILE = path.join(DATA_DIR, 'frozen_results.json');

// Points par position dans le challenge principal
const MAIN_CHALLENGE_POINTS = {
  1: 24, 2: 21, 3: 18, 4: 15, 5: 12, 6: 10, 7: 8, 8: 6, 9: 5, 10: 4, 11: 3, 12: 2, 13: 1
};

// Points pour les éliminés
const ELIMINATED_CHALLENGE_POINTS = {
  1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1
};

const getMainPoints = (pos) => MAIN_CHALLENGE_POINTS[pos] ?? 0;
const getEliminatedPoints = (pos) => ELIMINATED_CHALLENGE_POINTS[pos] ?? 0;

// ============================================
// UTILITAIRES DE FICHIER
// ============================================

async function loadFrozenResults() {
  try {
    const data = await fs.readFile(FROZEN_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { version: "1.0", rounds: {}, lastUpdated: null };
  }
}

async function saveFrozenResults(data) {
  data.lastUpdated = new Date().toISOString();
  await fs.writeFile(FROZEN_FILE, JSON.stringify(data, null, 2));
}

// ============================================
// CALCUL DES DATES DE ROUND
// ============================================

function getRoundDates(roundNumber, config) {
  const yearStart = new Date(config.yearStartDate);
  const start = new Date(yearStart);
  start.setDate(start.getDate() + (roundNumber - 1) * config.roundDurationDays);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(start);
  end.setDate(end.getDate() + config.roundDurationDays - 1);
  end.setHours(23, 59, 59, 999);
  
  return { start, end };
}

function getSeasonNumber(roundNumber, totalParticipants, eliminationsPerRound) {
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / eliminationsPerRound);
  return Math.ceil(roundNumber / roundsPerSeason);
}

function getRoundInSeason(roundNumber, totalParticipants, eliminationsPerRound) {
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / eliminationsPerRound);
  return ((roundNumber - 1) % roundsPerSeason) + 1;
}

// ============================================
// CALCUL D'UN ROUND
// ============================================

/**
 * Calcule et fige les résultats d'un round terminé
 * 
 * @param {number} roundNumber - Numéro du round global
 * @param {Array} activities - Toutes les activités
 * @param {Array} athletes - Liste des athlètes inscrits
 * @param {Array} jokerUsage - Utilisations de jokers
 * @param {Object} config - Configuration du challenge
 * @param {Object} previousRounds - Résultats des rounds précédents
 * @returns {Object} Résultats du round
 */
function calculateRoundResults(roundNumber, activities, athletes, jokerUsage, config, previousRounds) {
  const roundDates = getRoundDates(roundNumber, config);
  const totalParticipants = athletes.length;
  const seasonNumber = getSeasonNumber(roundNumber, totalParticipants, config.eliminationsPerRound);
  const roundInSeason = getRoundInSeason(roundNumber, totalParticipants, config.eliminationsPerRound);
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / config.eliminationsPerRound);
  const isFinale = roundInSeason === roundsPerSeason;
  
  // Déterminer les participants actifs (non éliminés dans les rounds précédents de cette saison)
  let activeParticipants = athletes.map(a => String(a.id));
  
  // Trouver les éliminés des rounds précédents de CETTE saison
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  for (let r = seasonStartRound; r < roundNumber; r++) {
    const prevRound = previousRounds[String(r)];
    if (prevRound?.eliminations) {
      const eliminatedIds = prevRound.eliminations.map(e => String(e.id));
      activeParticipants = activeParticipants.filter(id => !eliminatedIds.includes(id));
    }
  }
  
  // Filtrer les activités du round
  const roundStart = roundDates.start.getTime();
  const roundEnd = roundDates.end.getTime();
  
  const roundActivities = activities.filter(a => {
    const actDate = new Date(a.start_date).getTime();
    return actDate >= roundStart && actDate <= roundEnd;
  });
  
  // Calculer le D+ de chaque participant actif
  const ranking = activeParticipants.map(participantId => {
    const pActivities = roundActivities.filter(a => {
      const athleteId = String(a.athlete?.id || a.athlete_id);
      return athleteId === participantId;
    });
    
    const elevation = pActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    const athlete = athletes.find(a => String(a.id) === participantId);
    
    return {
      id: participantId,
      name: athlete?.name || `Athlète ${participantId}`,
      elevation: Math.round(elevation),
      activitiesCount: pActivities.length,
      originalElevation: Math.round(elevation)
    };
  });
  
  // Appliquer les effets des jokers actifs ce round
  const activeJokers = jokerUsage.filter(j => 
    j.round_number === roundNumber && j.status === 'active'
  );
  
  applyJokerEffects(ranking, activeJokers, roundActivities, athletes);
  
  // Trier par D+ décroissant
  ranking.sort((a, b) => b.elevation - a.elevation);
  
  // Attribuer les positions
  ranking.forEach((entry, index) => {
    entry.position = index + 1;
  });
  
  // Déterminer les éliminations selon la VRAIE règle:
  // - Cas normal: Éliminer les 2 derniers du classement
  // - Exception: Si ≥2 joueurs sont à 0 D+ → Éliminer SEULEMENT ces joueurs
  // - En finale: Éliminer tous sauf 1
  const eliminations = [];
  
  // Identifier les joueurs à 0 D+ (sans bouclier)
  const zeroElevationPlayers = ranking.filter(entry => 
    entry.elevation === 0 && !entry.hasShield
  );
  
  if (isFinale) {
    // FINALE: Éliminer tous sauf le premier (le gagnant)
    const playersToEliminate = ranking.filter(e => !e.hasShield).slice(1);
    playersToEliminate.forEach(entry => {
      eliminations.push({
        id: entry.id,
        name: entry.name,
        elevation: entry.elevation,
        reason: entry.elevation === 0 ? 'zero_elevation' : 'last_position',
        position: entry.position
      });
    });
  } else if (zeroElevationPlayers.length >= 2) {
    // EXCEPTION: ≥2 joueurs à 0 D+ → Éliminer SEULEMENT ces joueurs (pas les 2 derniers en plus)
    zeroElevationPlayers.forEach(entry => {
      eliminations.push({
        id: entry.id,
        name: entry.name,
        elevation: 0,
        reason: 'zero_elevation',
        position: entry.position
      });
    });
  } else {
    // CAS NORMAL: Éliminer les 2 derniers
    const eligibleForElimination = ranking.filter(e => !e.hasShield);
    const lastPositions = eligibleForElimination.slice(-config.eliminationsPerRound);
    lastPositions.forEach(entry => {
      eliminations.push({
        id: entry.id,
        name: entry.name,
        elevation: entry.elevation,
        reason: entry.elevation === 0 ? 'zero_elevation' : 'last_position',
        position: entry.position
      });
    });
  }
  
  // Calculer les points pour chaque participant
  // RÈGLE: Position = nombre d'actifs au début du round
  // - R1 avec 15 actifs, 3 éliminés → position 15 pour les 0D+, 14/13 pour les autres
  // - R2 avec 12 actifs, 2 éliminés → position 12 et 11
  const activeAtRoundStart = activeParticipants.length;
  
  // Séparer les éliminés par type
  const zeroEliminations = eliminations.filter(e => e.reason === 'zero_elevation');
  const normalEliminations = eliminations.filter(e => e.reason === 'last_position');
  
  ranking.forEach(entry => {
    const eliminationEntry = eliminations.find(e => e.id === entry.id);
    
    if (eliminationEntry) {
      if (eliminationEntry.reason === 'zero_elevation') {
        // Tous les 0 D+ → dernière position parmi les actifs de ce round
        entry.mainPoints = getMainPoints(activeAtRoundStart);
        entry.eliminatedPosition = activeAtRoundStart;
      } else {
        // Élimination normale → position basée sur l'ordre d'élimination
        // Si 2 éliminés normaux: avant-dernier → position (activeAtRoundStart - zeroEliminations.length - 1)
        //                        dernier → position (activeAtRoundStart - zeroEliminations.length)
        const indexInNormalElims = normalEliminations.findIndex(e => e.id === entry.id);
        const position = activeAtRoundStart - zeroEliminations.length - (normalEliminations.length - 1 - indexInNormalElims);
        entry.mainPoints = getMainPoints(Math.max(1, Math.min(position, totalParticipants)));
        entry.eliminatedPosition = position;
      }
    } else if (isFinale && ranking.filter(e => !eliminations.some(el => el.id === e.id)).length === 1) {
      // Gagnant de la saison
      entry.mainPoints = getMainPoints(1);
      entry.isWinner = true;
    } else {
      // Participant toujours actif - pas de points encore
      entry.mainPoints = 0;
    }
  });
  
  return {
    roundNumber,
    seasonNumber,
    roundInSeason,
    dates: {
      start: roundDates.start.toISOString(),
      end: roundDates.end.toISOString()
    },
    frozen: true,
    frozenAt: new Date().toISOString(),
    activeParticipants,
    ranking,
    eliminations,
    jokersUsed: activeJokers.map(j => ({
      athleteId: j.athlete_id,
      athleteName: j.athlete_name,
      jokerId: j.joker_id,
      targetId: j.target_athlete_id,
      targetName: j.target_athlete_name
    })),
    stats: {
      totalActivities: roundActivities.length,
      totalElevation: ranking.reduce((sum, e) => sum + e.elevation, 0),
      eliminationsCount: eliminations.length
    }
  };
}

function countPreviousEliminations(previousRounds, seasonNumber, roundsPerSeason) {
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  let count = 0;
  
  Object.values(previousRounds).forEach(round => {
    if (round.roundNumber >= seasonStartRound && round.eliminations) {
      count += round.eliminations.length;
    }
  });
  
  return count;
}

/**
 * Applique les effets des jokers sur le classement
 */
function applyJokerEffects(ranking, activeJokers, activities, athletes) {
  // Sabotages (-30%)
  activeJokers.filter(j => j.joker_id === 'sabotage').forEach(joker => {
    const target = ranking.find(e => e.id === String(joker.target_athlete_id));
    if (target) {
      const penalty = Math.round(target.originalElevation * 0.3);
      target.elevation = Math.max(0, target.elevation - penalty);
      target.sabotageReceived = { by: joker.athlete_name, amount: penalty };
    }
  });
  
  // Vols (meilleure activité)
  activeJokers.filter(j => j.joker_id === 'voleur').forEach(joker => {
    const target = ranking.find(e => e.id === String(joker.target_athlete_id));
    const thief = ranking.find(e => e.id === String(joker.athlete_id));
    
    if (target && thief) {
      const targetActivities = activities.filter(a => 
        String(a.athlete?.id || a.athlete_id) === target.id
      );
      
      if (targetActivities.length > 0) {
        const bestActivity = targetActivities.reduce((best, curr) =>
          (curr.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? curr : best
        );
        
        const stolen = Math.round(bestActivity.total_elevation_gain || 0);
        target.elevation = Math.max(0, target.elevation - stolen);
        thief.elevation += stolen;
        
        target.theftReceived = { by: joker.athlete_name, amount: stolen, activity: bestActivity.name };
        thief.theftDone = { from: target.name, amount: stolen, activity: bestActivity.name };
      }
    }
  });
  
  // Multiplicateurs (x1.5)
  activeJokers.filter(j => j.joker_id === 'multiplicateur').forEach(joker => {
    const participant = ranking.find(e => e.id === String(joker.athlete_id));
    if (participant) {
      const bonus = Math.round(participant.elevation * 0.5);
      participant.elevation += bonus;
      participant.multiplierBonus = bonus;
    }
  });
  
  // Boucliers
  activeJokers.filter(j => j.joker_id === 'bouclier').forEach(joker => {
    const participant = ranking.find(e => e.id === String(joker.athlete_id));
    if (participant) {
      participant.hasShield = true;
    }
  });
}

// ============================================
// API PUBLIQUE
// ============================================

/**
 * Récupère tous les résultats figés
 */
async function getAllFrozenResults() {
  return await loadFrozenResults();
}

/**
 * Récupère les résultats d'un round spécifique
 */
async function getFrozenRoundResult(roundNumber) {
  const data = await loadFrozenResults();
  return data.rounds[String(roundNumber)] || null;
}

/**
 * Fige les résultats d'un round (à appeler quand un round se termine)
 */
async function freezeRoundResults(roundNumber, activities, athletes, jokerUsage, config) {
  const data = await loadFrozenResults();
  
  // Ne pas re-figer un round déjà figé
  if (data.rounds[String(roundNumber)]?.frozen) {
    console.log(`⚠️ Round ${roundNumber} déjà figé`);
    return data.rounds[String(roundNumber)];
  }
  
  const results = calculateRoundResults(
    roundNumber, 
    activities, 
    athletes, 
    jokerUsage, 
    config,
    data.rounds
  );
  
  data.rounds[String(roundNumber)] = results;
  await saveFrozenResults(data);
  
  console.log(`❄️ Round ${roundNumber} figé: ${results.eliminations.length} éliminé(s)`);
  return results;
}

/**
 * Vérifie et fige automatiquement les rounds terminés
 */
async function autoFreezeCompletedRounds(activities, athletes, jokerUsage, config) {
  const now = new Date();
  const data = await loadFrozenResults();
  const frozenRounds = [];
  
  // Calculer le nombre de rounds depuis le début
  const yearStart = new Date(config.yearStartDate);
  const daysSinceStart = Math.floor((now - yearStart) / (1000 * 60 * 60 * 24));
  const currentRound = Math.floor(daysSinceStart / config.roundDurationDays) + 1;
  
  // Figer tous les rounds terminés (jusqu'au round précédent)
  for (let r = 1; r < currentRound; r++) {
    if (!data.rounds[String(r)]?.frozen) {
      const result = await freezeRoundResults(r, activities, athletes, jokerUsage, config);
      frozenRounds.push(result);
    }
  }
  
  return frozenRounds;
}

/**
 * Recalcule le classement annuel basé sur les résultats figés
 */
async function calculateYearlyStandings(athletes) {
  const data = await loadFrozenResults();
  const standings = {};
  
  // Initialiser tous les participants
  athletes.forEach(a => {
    standings[String(a.id)] = {
      id: String(a.id),
      name: a.name,
      totalMainPoints: 0,
      totalEliminatedPoints: 0,
      totalPoints: 0,
      wins: 0,
      seasonsPlayed: 0
    };
  });
  
  // Parcourir les rounds figés
  Object.values(data.rounds).forEach(round => {
    if (!round.frozen) return;
    
    round.ranking.forEach(entry => {
      if (standings[entry.id]) {
        standings[entry.id].totalMainPoints += entry.mainPoints || 0;
        if (entry.isWinner) {
          standings[entry.id].wins++;
        }
      }
    });
  });
  
  // Convertir en tableau et trier
  const standingsArray = Object.values(standings);
  standingsArray.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins);
  standingsArray.forEach((e, i) => e.rank = i + 1);
  
  return standingsArray;
}

/**
 * Réinitialise tous les résultats figés (ATTENTION!)
 */
async function resetAllFrozenResults() {
  await saveFrozenResults({ version: "1.0", rounds: {}, lastUpdated: null });
  console.log('🗑️ Tous les résultats figés ont été supprimés');
}

/**
 * Vérifie si un round est figé
 */
async function isRoundFrozen(roundNumber) {
  const data = await loadFrozenResults();
  return !!data.rounds[String(roundNumber)]?.frozen;
}

/**
 * Défige un round spécifique (admin only)
 */
async function unfreezeRound(roundNumber) {
  const data = await loadFrozenResults();
  if (data.rounds[String(roundNumber)]) {
    delete data.rounds[String(roundNumber)];
    await saveFrozenResults(data);
    console.log(`🔓 Round ${roundNumber} défigé`);
    return true;
  }
  return false;
}

module.exports = {
  getAllFrozenResults,
  getFrozenRoundResult,
  freezeRoundResults,
  autoFreezeCompletedRounds,
  calculateYearlyStandings,
  resetAllFrozenResults,
  isRoundFrozen,
  unfreezeRound,
  getRoundDates,
  getSeasonNumber,
  getRoundInSeason
};
