/**
 * ============================================
 * VERSANT - CONFIGURATION PARTAGÉE BACKEND
 * ============================================
 * Source unique de vérité pour les constantes backend.
 * Doit rester synchronisé avec public/js/config.js (frontend).
 * 
 * Si vous modifiez ces valeurs, mettez aussi à jour config.js.
 */

// ============================================
// CONFIGURATION DU CHALLENGE
// ============================================
const CHALLENGE_CONFIG = {
  leagueId: 'versant-2026',
  yearStartDate: '2026-02-02',
  yearEndDate: '2026-12-31',
  roundDurationDays: 5,
  eliminationsPerRound: 2
};

// ============================================
// SPORTS VALIDES
// ============================================
const VALID_SPORTS = [
  'Run', 'TrailRun',
  'Hike', 'Walk', 'Snowshoe',
  'Ride', 'MountainBikeRide', 'GravelRide',
  'BackcountrySki', 'NordicSki'
];

function isValidSport(type) {
  return !type || VALID_SPORTS.includes(type);
}

// ============================================
// RÈGLE MÉTÉO — "LA PLUIE QUI MOUILLE"
// ============================================
// Seuil de détection : une activité compte comme "sous la pluie" dès qu'il a plu
// pendant au moins minRainMinutes sur sa durée (fenêtre start_date → +elapsed_time).
//
// Pourquoi une durée et pas un cumul en mm : sur 173 activités géolocalisées
// réelles, le cumul MAXIMUM observé sur une sortie entière est de 1,33 mm. Un
// seuil classique (2 ou 5 mm) ne se déclencherait jamais — mécanique, on sort
// 45-90 min, pas toute la journée. Le critère "≥ 15 min" touche ~10 % des sorties.
//
// La neige est volontairement exclue : on lit `rain` (liquide) et non
// `precipitation`, sinon toutes les randos à ski en poudreuse déclencheraient.
const WEATHER_RULE = {
  minRainMinutes: 15,
  multiplier: 1.5
};

function isRainyActivity(activity) {
  const w = activity?.weather;
  if (w?.status !== 'ok') return false;
  if ((w.rain_minutes || 0) < WEATHER_RULE.minRainMinutes) return false;

  // Précipitation mixte (neige fondue) : il faut que la phase LIQUIDE domine.
  // Sans ce garde-fou, une sortie à ski sous une neige modérée créditant
  // 0,17 mm de pluie résiduelle déclencherait "la pluie qui mouille", ce qui
  // n'est pas l'esprit de la règle. 1 cm de neige ≈ 1 mm d'équivalent en eau.
  const snowWaterMm = (w.snowfall_cm || 0);
  return (w.rain_mm || 0) > snowWaterMm;
}

/**
 * D+ d'UNE activité, pondéré par la règle spéciale du round.
 *
 * Contrairement à `handicap` qui ajuste le D+ agrégé par athlète, cette règle
 * pondère chaque activité AVANT la somme. C'est donc ici, et pas dans un
 * équivalent de applyHandicapRule(), que le multiplicateur s'applique.
 *
 * @param {object} activity
 * @param {string|null} ruleId - id de la règle spéciale du round, ou null
 */
function getActivityElevation(activity, ruleId = null) {
  const elevation = activity?.total_elevation_gain || 0;
  if (ruleId === 'pluie_qui_mouille' && isRainyActivity(activity)) {
    return elevation * WEATHER_RULE.multiplier;
  }
  return elevation;
}

// ============================================
// SYSTÈME DE POINTS
// ============================================
const MAIN_CHALLENGE_POINTS = {
  1: 24, 2: 21, 3: 18, 4: 15, 5: 12, 6: 10, 7: 8, 8: 6, 9: 5, 10: 4, 11: 3, 12: 2, 13: 1
};

const ELIMINATED_CHALLENGE_POINTS = {
  1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1
};

const getMainPoints = (pos) => MAIN_CHALLENGE_POINTS[pos] ?? 0;
const getEliminatedPoints = (pos) => ELIMINATED_CHALLENGE_POINTS[pos] ?? 0;

// ============================================
// JOKERS
// ============================================
const JOKER_IDS = ['voleur', 'multiplicateur', 'bouclier', 'sabotage'];
const INITIAL_JOKER_STOCK = 2;

// ============================================
// UTILITAIRES DE DATES
// ============================================
function getRoundDates(roundNumber, config = CHALLENGE_CONFIG) {
  // IMPORTANT : ancrer le début du round à MINUIT LOCAL (heure de Paris, cf.
  // TZ=Europe/Paris côté serveur). `new Date('2026-02-02')` serait interprété en
  // UTC → le round démarrerait à 01h/02h Paris et laisserait un trou de 00h00 à
  // 01h00 où une activité (rattachée par son heure de FIN) ne tomberait dans
  // aucun round. On parse donc les composantes Y/M/D en local.
  const [y, m, d] = String(config.yearStartDate).split('-').map(Number);
  const start = new Date(y, m - 1, d); // minuit local
  start.setDate(start.getDate() + (roundNumber - 1) * config.roundDurationDays);
  const end = new Date(start);
  end.setDate(end.getDate() + config.roundDurationDays - 1);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getSeasonNumber(roundNumber, totalParticipants, eliminationsPerRound = CHALLENGE_CONFIG.eliminationsPerRound) {
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / eliminationsPerRound);
  return Math.ceil(roundNumber / roundsPerSeason);
}

function getRoundInSeason(roundNumber, totalParticipants, eliminationsPerRound = CHALLENGE_CONFIG.eliminationsPerRound) {
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / eliminationsPerRound);
  return ((roundNumber - 1) % roundsPerSeason) + 1;
}

// ============================================
// SAISONS
// ============================================
const SEASON_PLANNING = {
  1: "standard", 2: "standard", 3: "standard",
  4: "team", 5: "standard", 6: "standard",
  7: "standard", 8: "standard", 9: "standard",
  10: "standard", 11: "standard", 12: "standard"
};

// Définition des types de saisons (mirror du frontend public/js/config.js).
// IMPORTANT : pour les saisons "team", roundsPerSeason est variable selon le
// nombre de joueurs. Voir getRoundsForTeamSeason ci-dessous.
const SEASON_TYPES = {
  standard: {
    id: "standard",
    name: "Standard",
    isTeamBased: false
  },
  team: {
    id: "team",
    name: "Équipes",
    isTeamBased: true,
    teamSize: 3,
    eliminateWholeTeam: true,
    reshuffleEachRound: true,
    // Round supplémentaire pour le challenge éliminés en finale de saison
    extraEliminatedFinalRound: true
  }
};

function getSeasonType(seasonNumber) {
  const typeId = SEASON_PLANNING[seasonNumber] || 'standard';
  return SEASON_TYPES[typeId];
}

function isTeamSeason(seasonNumber) {
  return SEASON_PLANNING[seasonNumber] === 'team';
}

/**
 * Pour une saison team, calcule le nombre de rounds total.
 * @param {number} totalParticipants - Nombre de joueurs au début de la saison
 * @returns {number} Nombre total de rounds dont 1 round final pour le challenge éliminés
 *
 * Exemple avec 15 joueurs et teamSize=3 :
 *   R1: 5 équipes → 1 éliminée → 4 actifs
 *   R2: 4 équipes → 1 éliminée → 3 actifs
 *   R3: 3 équipes → 1 éliminée → 2 actifs
 *   R4: 2 équipes → FINALE PRINCIPALE (toute la finale est éliminée)
 *   R5: 0 actifs → FINALE ÉLIMINÉS (toutes les équipes du challenge éliminés)
 *   Total: 5 rounds
 */
function getRoundsForTeamSeason(totalParticipants, teamSize = 3) {
  if (totalParticipants < teamSize * 2) {
    // Pas assez pour avoir au moins 2 équipes → 1 seul round + final éliminés
    return 2;
  }
  let teamCount = Math.ceil(totalParticipants / teamSize);
  // Rounds d'élimination jusqu'à la finale (où il reste 2 équipes)
  // Au round R, on commence avec teamCount - (R-1) équipes
  // On veut atteindre 2 équipes au début du round finale
  // Donc nombre de rounds avec éliminations = teamCount - 1
  // + 1 round final pour le challenge éliminés
  return (teamCount - 1) + 1;
}

// ============================================
// BARÈME DES POINTS — CHALLENGE ÉLIMINÉS SAISON TEAM
// ============================================
// teamRank: 1 = meilleure équipe d'éliminés (D+ cumulé le plus élevé du challenge)
// posInTeam: 1 = meilleur contributeur de l'équipe (D+ individuel le plus élevé)
// Au-delà de 3 équipes ou 3 joueurs par équipe : 0 pts
const TEAM_ELIMINATED_POINTS = {
  1: { 1: 12, 2: 11, 3: 10 },
  2: { 1:  8, 2:  7, 3:  6 },
  3: { 1:  4, 2:  3, 3:  2 }
};

function getTeamEliminatedPoints(teamRank, posInTeam) {
  return TEAM_ELIMINATED_POINTS[teamRank]?.[posInTeam] ?? 0;
}

// ============================================
// BONUS ÉPHÉMÈRES (IDs pour tirage au sort)
// ============================================
const BONUS_IDS = [
  'embuscade', 'ravitaillement', 'duel', 'brouillard',
  'marquage', 'trap', 'second_souffle', 'kamikaze', 'malediction'
];

module.exports = {
  CHALLENGE_CONFIG,
  SEASON_PLANNING,
  SEASON_TYPES,
  getSeasonType,
  isTeamSeason,
  getRoundsForTeamSeason,
  TEAM_ELIMINATED_POINTS,
  getTeamEliminatedPoints,
  VALID_SPORTS,
  isValidSport,
  WEATHER_RULE,
  isRainyActivity,
  getActivityElevation,
  MAIN_CHALLENGE_POINTS,
  ELIMINATED_CHALLENGE_POINTS,
  getMainPoints,
  getEliminatedPoints,
  JOKER_IDS,
  INITIAL_JOKER_STOCK,
  BONUS_IDS,
  getRoundDates,
  getSeasonNumber,
  getRoundInSeason
};