/**
 * ============================================
 * VERSANT - GESTION DES RÉSULTATS FIGÉS
 * ============================================
 * 
 * Ce module stocke les résultats de chaque round de façon DÉFINITIVE.
 * Une fois un round terminé, ses résultats ne changent JAMAIS.
 * 
 * IMPORTANT: Deux modes de fonctionnement:
 * 1. freezeRoundResults() - Recalcule les résultats (ancienne méthode)
 * 2. freezeRoundWithData() - Accepte les données pré-calculées du frontend (RECOMMANDÉ)
 *
 * Le mode 2 est recommandé car il garantit que les résultats figés correspondent
 * exactement à ce qui est affiché sur la page principale (avec jokers, etc.)
 */

const fs = require('fs').promises;
const path = require('path');

// Import de la fonction d'application des bonus
let applyBonusEffectsForRound = null;
try {
  const bonusesRoutes = require('./bonuses-routes.js');
  applyBonusEffectsForRound = bonusesRoutes.applyBonusEffectsForRound;
} catch (e) {
  console.warn('⚠️ Impossible de charger bonuses-routes pour auto-apply');
}

// Configuration
const DATA_DIR = path.join(__dirname, 'data');
const FROZEN_FILE = path.join(DATA_DIR, 'frozen_results.json');

// Sports valides pour le challenge (doit correspondre à config.js frontend)
const VALID_SPORTS = [
  'Run', 'TrailRun',
  'Hike', 'Walk', 'Snowshoe',
  'Ride', 'MountainBikeRide', 'GravelRide',
  'BackcountrySki', 'NordicSki'
];

function isValidSport(type) {
  return !type || VALID_SPORTS.includes(type);
}

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
// NOUVELLE MÉTHODE: FREEZE AVEC DONNÉES PRÉ-CALCULÉES
// ============================================

/**
 * Fige un round avec des données pré-calculées provenant du frontend
 * Cette méthode ne recalcule RIEN - elle sauvegarde exactement les données reçues
 *
 * @param {number} roundNumber - Numéro du round
 * @param {Object} roundData - Données du round calculées par le frontend
 * @param {Object} options - Options (force: true pour remplacer un round existant)
 * @returns {Object} Les données sauvegardées
 */
async function freezeRoundWithData(roundNumber, roundData, options = {}) {
  const data = await loadFrozenResults();
  const roundKey = String(roundNumber);

  // Vérifier si déjà figé (sauf si force=true)
  if (data.rounds[roundKey]?.frozen && !options.force) {
    console.log(`⚠️ Round ${roundNumber} déjà figé. Utilisez force=true pour remplacer.`);
    return { success: false, error: 'already_frozen', existing: data.rounds[roundKey] };
  }

  // Valider les données minimales requises
  if (!roundData.ranking || !Array.isArray(roundData.ranking)) {
    return { success: false, error: 'missing_ranking' };
  }
  if (!roundData.eliminations || !Array.isArray(roundData.eliminations)) {
    return { success: false, error: 'missing_eliminations' };
  }

  // Construire l'objet de résultat
  const frozenRound = {
    roundNumber: roundNumber,
    seasonNumber: roundData.seasonNumber || 1,
    roundInSeason: roundData.roundInSeason || roundNumber,
    dates: roundData.dates || {
      start: new Date().toISOString(),
      end: new Date().toISOString()
    },
    frozen: true,
    frozenAt: new Date().toISOString(),
    frozenMethod: 'frontend_data', // Indique que les données viennent du frontend
    activeParticipants: roundData.activeParticipants || roundData.ranking.map(r => String(r.id)),
    ranking: roundData.ranking.map(entry => ({
      id: String(entry.id),
      name: entry.name,
      elevation: entry.elevation || entry.totalElevation || 0,
      activitiesCount: entry.activitiesCount || 0,
      originalElevation: entry.originalElevation || entry.elevation || 0,
      position: entry.position,
      mainPoints: entry.mainPoints || 0,
      eliminatedPosition: entry.eliminatedPosition,
      hasShield: entry.hasShield || entry.jokerEffects?.hasShield || false,
      jokerEffects: entry.jokerEffects || null
    })),
    eliminations: roundData.eliminations.map(elim => ({
      id: String(elim.id),
      name: elim.name,
      elevation: elim.elevation || elim.totalElevation || 0,
      reason: elim.reason || (elim.elevation === 0 ? 'zero_elevation' : 'last_position'),
      position: elim.position,
      zeroElimination: elim.zeroElimination || elim.elevation === 0
    })),
    jokersUsed: roundData.jokersUsed || [],
    stats: roundData.stats || {
      totalActivities: roundData.ranking.reduce((sum, r) => sum + (r.activitiesCount || 0), 0),
      totalElevation: roundData.ranking.reduce((sum, r) => sum + (r.elevation || 0), 0),
      eliminationsCount: roundData.eliminations.length
    }
  };

  // Sauvegarder
  data.rounds[roundKey] = frozenRound;
  await saveFrozenResults(data);

  console.log(`❄️ Round ${roundNumber} figé (via frontend): ${frozenRound.eliminations.length} éliminé(s)`);

  // Appliquer automatiquement les effets des bonus si la fonction est disponible
  let appliedBonuses = [];
  if (applyBonusEffectsForRound && roundData.activities) {
    try {
      appliedBonuses = await applyBonusEffectsForRound(roundNumber, roundData.activities, {
        yearStartDate: roundData.dates?.start || new Date().toISOString(),
        roundDurationDays: 5
      });
    } catch (e) {
      console.warn(`⚠️ Erreur application auto bonus round ${roundNumber}:`, e.message);
    }
  }

  // Générer automatiquement les choix de bonus pour le meilleur éliminé
  let bonusChoiceGenerated = null;
  if (frozenRound.eliminations && frozenRound.eliminations.length >= 2) {
    try {
      bonusChoiceGenerated = await generateBonusChoiceForBestEliminated(frozenRound.eliminations, roundNumber);
    } catch (e) {
      console.warn(`⚠️ Erreur génération choix bonus round ${roundNumber}:`, e.message);
    }
  }

  return {
    success: true,
    round: frozenRound,
    method: 'frontend_data',
    appliedBonuses: appliedBonuses.length,
    bonusChoiceGenerated
  };
}

/**
 * Génère un choix de bonus pour le meilleur des 2 éliminés
 */
async function generateBonusChoiceForBestEliminated(eliminations, roundNumber) {
  if (!eliminations || eliminations.length < 2) return null;

  // Trier par D+ décroissant pour trouver le meilleur
  const sorted = [...eliminations].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
  const bestEliminated = sorted[0];

  // Ne pas donner de bonus si le meilleur a 0 D+
  if (!bestEliminated.elevation || bestEliminated.elevation === 0) {
    console.log(`🎁 Pas de bonus pour round ${roundNumber}: meilleur éliminé à 0 D+`);
    return null;
  }

  // Charger les choix en attente
  const pendingFile = path.join(DATA_DIR, 'pending_bonus_choices.json');
  let pendingChoices = {};
  try {
    const content = await fs.readFile(pendingFile, 'utf8');
    pendingChoices = JSON.parse(content);
  } catch (e) {
    // Fichier n'existe pas encore
  }

  // Vérifier si déjà généré pour ce joueur
  const playerId = String(bestEliminated.id);
  if (pendingChoices[playerId]) {
    console.log(`🎁 Choix bonus déjà existant pour ${bestEliminated.name}`);
    return null;
  }

  // Liste des bonus disponibles
  const BONUS_IDS = ['embuscade', 'ravitaillement', 'duel', 'brouillard', 'marquage', 'trap', 'second_souffle', 'kamikaze', 'malediction'];

  // Tirer 2 bonus au hasard
  const shuffled = [...BONUS_IDS].sort(() => Math.random() - 0.5);
  const choices = shuffled.slice(0, 2);

  // Ajouter le choix
  pendingChoices[playerId] = {
    choices,
    elimination_round: roundNumber,
    athlete_name: bestEliminated.name,
    created_at: new Date().toISOString(),
    expires_at: `${new Date().getFullYear()}-12-31T23:59:59.999Z`
  };

  // Sauvegarder
  await fs.writeFile(pendingFile, JSON.stringify(pendingChoices, null, 2));

  console.log(`🎁 Choix bonus généré pour ${bestEliminated.name} (round ${roundNumber}): ${choices.join(', ')}`);

  return {
    athleteId: playerId,
    athleteName: bestEliminated.name,
    choices,
    eliminationRound: roundNumber
  };
}

/**
 * Importe plusieurs rounds depuis un fichier JSON complet
 * Utile pour restaurer ou corriger les données
 *
 * @param {Object} importData - Données à importer (format frozen_results.json)
 * @param {Object} options - Options (merge: true pour fusionner, false pour remplacer)
 */
async function importFrozenResults(importData, options = { merge: true }) {
  const currentData = await loadFrozenResults();

  if (!importData.rounds) {
    return { success: false, error: 'invalid_format' };
  }

  let imported = 0;
  let skipped = 0;

  for (const [roundKey, roundData] of Object.entries(importData.rounds)) {
    // En mode merge, ne pas remplacer les rounds existants
    if (options.merge && currentData.rounds[roundKey]?.frozen) {
      skipped++;
      continue;
    }

    // Ajouter les métadonnées d'import
    roundData.importedAt = new Date().toISOString();
    roundData.frozen = true;

    currentData.rounds[roundKey] = roundData;
    imported++;
  }

  await saveFrozenResults(currentData);

  console.log(`📥 Import: ${imported} round(s) importé(s), ${skipped} ignoré(s)`);

  return {
    success: true,
    imported,
    skipped,
    totalRounds: Object.keys(currentData.rounds).length
  };
}

// ============================================
// ANCIENNE MÉTHODE: CALCUL DES RÉSULTATS
// ============================================

/**
 * Calcule et fige les résultats d'un round terminé
 * ATTENTION: Cette méthode recalcule tout - préférer freezeRoundWithData()
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

  // Filtrer les activités du round (date ET type de sport valide)
  const roundStart = roundDates.start.getTime();
  const roundEnd = roundDates.end.getTime();

  const roundActivities = activities.filter(a => {
    // Vérifier la date
    const actDate = new Date(a.start_date).getTime();
    if (actDate < roundStart || actDate > roundEnd) return false;

    // Ignorer les activités exclues par l'admin
    if (a.excluded) return false;

    // Vérifier le type de sport (AlpineSki, Snowboard, etc. sont exclus)
    const sportType = a.sport_type || a.type;
    if (!isValidSport(sportType)) return false;

    return true;
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

  // ============================================
  // NOUVELLES RÈGLES D'ÉLIMINATION (à partir du R7)
  // ============================================
  // - Si ≥2 joueurs à 0 D+ → éliminer TOUS les 0 D+ (et seulement eux)
  // - Sinon → éliminer les 2 derniers (règle normale)
  // - Finale: éliminer tous sauf 1
  //
  // Note: Les rounds 1-6 utilisent les anciennes règles (2 derniers toujours)
  // pour ne pas casser les résultats déjà figés
  // ============================================

  const eliminations = [];

  // Joueurs éligibles (sans bouclier)
  const eligibleForElimination = ranking.filter(e => !e.hasShield);

  // Joueurs à 0 D+ (éligibles uniquement)
  const zeroElevationPlayers = eligibleForElimination.filter(e => e.elevation === 0);

  // Déterminer qui éliminer
  let toEliminate = [];

  // Appliquer les nouvelles règles seulement à partir du R7
  const useNewRules = roundNumber >= 7;

  if (isFinale) {
    // FINALE: éliminer tous sauf 1
    toEliminate = eligibleForElimination.slice(1); // Garder seulement le premier
  } else if (useNewRules && zeroElevationPlayers.length >= 2) {
    // NOUVELLE RÈGLE: Si ≥2 joueurs à 0 D+ → éliminer TOUS les 0 D+
    toEliminate = zeroElevationPlayers;
    console.log(`📋 Round ${roundNumber}: ${zeroElevationPlayers.length} joueurs à 0 D+ → tous éliminés`);
  } else {
    // RÈGLE NORMALE: éliminer les 2 derniers
    const eliminationsNeeded = config.eliminationsPerRound;
    toEliminate = eligibleForElimination.slice(-eliminationsNeeded);
  }

  // Trier par position (du pire au meilleur) pour l'attribution des points
  // Le dernier du classement doit être en premier dans eliminations
  toEliminate.sort((a, b) => b.position - a.position);

  toEliminate.forEach(entry => {
    eliminations.push({
      id: entry.id,
      name: entry.name,
      elevation: entry.elevation,
      reason: entry.elevation === 0 ? 'zero_elevation' : 'last_position',
      position: entry.position
    });
  });

  // Calculer les points pour chaque participant
  const activeAtRoundStart = activeParticipants.length;

  ranking.forEach(entry => {
    const eliminationEntry = eliminations.find(e => e.id === entry.id);

    if (eliminationEntry) {
      // indexInElims: 0 = dernier, 1 = avant-dernier, etc.
      const indexInElims = eliminations.findIndex(e => e.id === entry.id);
      // Position: dernier = activeAtRoundStart, avant-dernier = activeAtRoundStart - 1
      // Exemple avec 11 actifs: dernier → 11 (2 pts), avant-dernier → 10 (4 pts)
      const position = activeAtRoundStart - indexInElims;
      entry.mainPoints = getMainPoints(Math.max(1, Math.min(position, totalParticipants)));
      entry.eliminatedPosition = position;
    } else if (isFinale && ranking.filter(e => !eliminations.some(el => el.id === e.id)).length === 1) {
      entry.mainPoints = getMainPoints(1);
      entry.isWinner = true;
    } else {
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
    frozenMethod: 'calculated', // Indique que c'est recalculé
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
 * Fige les résultats d'un round (ANCIENNE MÉTHODE - recalcule)
 */
async function freezeRoundResults(roundNumber, activities, athletes, jokerUsage, config) {
  const data = await loadFrozenResults();

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

  console.log(`❄️ Round ${roundNumber} figé (calculé): ${results.eliminations.length} éliminé(s)`);

  return results;
}

/**
 * Vérifie et fige automatiquement les rounds terminés
 */
async function autoFreezeCompletedRounds(activities, athletes, jokerUsage, config) {
  const now = new Date();
  const data = await loadFrozenResults();
  const frozenRounds = [];

  const yearStart = new Date(config.yearStartDate);
  const daysSinceStart = Math.floor((now - yearStart) / (1000 * 60 * 60 * 24));
  const currentRound = Math.floor(daysSinceStart / config.roundDurationDays) + 1;

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
  freezeRoundWithData,      // NOUVELLE: fige avec données du frontend
  importFrozenResults,       // NOUVELLE: import de fichier JSON
  autoFreezeCompletedRounds,
  calculateYearlyStandings,
  resetAllFrozenResults,
  isRoundFrozen,
  unfreezeRound,
  getRoundDates,
  getSeasonNumber,
  getRoundInSeason
};