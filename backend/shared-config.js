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
  const yearStart = new Date(config.yearStartDate);
  const start = new Date(yearStart);
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

function isTeamSeason(seasonNumber) {
  return SEASON_PLANNING[seasonNumber] === 'team';
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
  isTeamSeason,
  VALID_SPORTS,
  isValidSport,
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