/**
 * ============================================
 * VERSANT - CONFIGURATION DÉMO / 2026
 * ============================================
 * Étend la configuration de base avec les spécificités
 * de la page démo et de la ligue 2026
 * 
 * Cette config partage toutes les règles avec config.js
 * mais utilise des dates et API différentes
 */

// Import de la configuration de base partagée
import {
  SEASON_TYPES,
  SEASON_PLANNING,
  getSeasonType as baseGetSeasonType,
  MAIN_CHALLENGE_POINTS,
  ELIMINATED_CHALLENGE_POINTS,
  getMainChallengePoints,
  getEliminatedChallengePoints,
  JOKER_TYPES,
  INITIAL_JOKERS,
  ROUND_RULES,
  SPORT_SETTINGS,
  isValidSport,
  getSportCategory,
  getSportIcon,
  createDateUtils,
  generateRoundsSchedule,
  formatElevationWithBonuses,
  renderDuelIcons,
  calculateSteepElevation,
  calculateOffRoadElevation
} from './league-config.js';

// ============================================
// CONFIGURATION SPÉCIFIQUE DÉMO/2026
// ============================================
export const CHALLENGE_CONFIG = {
  name: "Versant",
  fullName: "Challenge Versant 2026",
  description: "Course à élimination progressive par saisons",
  leagueId: "versant-2026",
  yearStartDate: "2026-02-01", // Début le 1er février 2026
  yearEndDate: "2026-12-31",
  roundDurationDays: 5,
  eliminationsPerRound: 2,
  mainMetric: "elevation",
  mainMetricLabel: "Dénivelé positif",
  mainMetricUnit: "m",
  specialRuleFrequency: 4,
  dataYear: 2026,
  dateLocale: "fr-FR",
  apiBaseUrl: "/api",
  isDemo: true
};

// ============================================
// PARTICIPANTS - CHARGÉS DYNAMIQUEMENT VIA API
// ============================================
let participantsCache = null;
let participantsCount = 13; // Valeur par défaut

export async function loadParticipants() {
  if (participantsCache) return participantsCache;
  
  try {
    const response = await fetch(`${CHALLENGE_CONFIG.apiBaseUrl}/athletes/${CHALLENGE_CONFIG.leagueId}`);
    if (!response.ok) throw new Error('Erreur chargement participants');
    
    participantsCache = await response.json();
    participantsCount = participantsCache.length;
    
    // Initialiser les jokers pour chaque participant
    participantsCache = participantsCache.map(p => ({
      ...p,
      jokers: p.jokers || { ...INITIAL_JOKERS }
    }));
    
    return participantsCache;
  } catch (error) {
    console.error('Erreur chargement participants:', error);
    return [];
  }
}

export function getParticipantById(id) {
  if (!participantsCache) return null;
  return participantsCache.find(p => p.id === String(id));
}

export function getParticipants() {
  return participantsCache || [];
}

// Placeholder pour compatibilité
export const PARTICIPANTS = [];

// ============================================
// UTILITAIRES DE DATE DYNAMIQUES
// ============================================
function getDateUtils() {
  return createDateUtils({
    yearStartDate: CHALLENGE_CONFIG.yearStartDate,
    yearEndDate: CHALLENGE_CONFIG.yearEndDate,
    roundDurationDays: CHALLENGE_CONFIG.roundDurationDays,
    eliminationsPerRound: CHALLENGE_CONFIG.eliminationsPerRound,
    participantsCount: participantsCount
  });
}

// Export des fonctions de date (wrapper pour gérer le comptage dynamique)
export function getRoundsPerSeason() {
  return getDateUtils().getRoundsPerSeason();
}

export function getSeasonDurationDays() {
  return getDateUtils().getSeasonDurationDays();
}

export function getTotalSeasons() {
  return getDateUtils().getTotalSeasons();
}

export function getSeasonNumber(date) {
  return getDateUtils().getSeasonNumber(date);
}

export function getSeasonDates(seasonNumber) {
  return getDateUtils().getSeasonDates(seasonNumber);
}

export function getGlobalRoundNumber(date) {
  return getDateUtils().getGlobalRoundNumber(date);
}

export function getRoundInSeason(date) {
  return getDateUtils().getRoundInSeason(date);
}

export function getRoundDates(globalRoundNumber) {
  return getDateUtils().getRoundDates(globalRoundNumber);
}

export function isFinaleRound(roundInSeason) {
  return getDateUtils().isFinaleRound(roundInSeason);
}

export function isLastDayOfRound(date, globalRoundNumber) {
  return getDateUtils().isLastDayOfRound(date, globalRoundNumber);
}

// ============================================
// INFO DE ROUND AVEC RÈGLES
// ============================================
export function getRoundInfo(roundNumber) {
  const schedule = generateRoundsSchedule({
    ...CHALLENGE_CONFIG,
    participantsCount: participantsCount
  });
  
  const roundSchedule = schedule[roundNumber - 1];
  if (!roundSchedule) return null;
  
  const rule = ROUND_RULES[roundSchedule.rule] || ROUND_RULES.standard;
  const dates = getRoundDates(roundNumber);
  
  return {
    roundNumber,
    rule,
    startDate: dates.start.toISOString().split('T')[0],
    endDate: dates.end.toISOString().split('T')[0]
  };
}

// ============================================
// FONCTIONS UTILITAIRES SPÉCIFIQUES À LA DÉMO
// ============================================
export const getSeasonType = baseGetSeasonType;

/**
 * Vérifie si un joker peut être utilisé
 */
export function canUseJoker(participantId, jokerId, roundInSeason, currentDate, globalRoundNumber) {
  const participant = getParticipantById(participantId);
  if (!participant) return { canUse: false, reason: "Participant non trouvé" };
  
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) return { canUse: false, reason: "Joker inconnu" };
  
  // Vérifier le stock
  const stock = participant.jokers?.[jokerId] || 0;
  if (stock <= 0) return { canUse: false, reason: "Plus de joker disponible" };
  
  // Vérifier finale
  if (!jokerType.usableInFinal && isFinaleRound(roundInSeason)) {
    return { canUse: false, reason: "Non utilisable en finale" };
  }
  
  // Vérifier dernier jour (pour duel)
  if (jokerType.notOnLastDay && isLastDayOfRound(currentDate, globalRoundNumber)) {
    return { canUse: false, reason: "Non utilisable le dernier jour du round (avant-dernier au mieux)" };
  }
  
  return { canUse: true };
}

// ============================================
// RÉ-EXPORT DES CONSTANTES PARTAGÉES
// ============================================
export {
  SEASON_TYPES,
  SEASON_PLANNING,
  MAIN_CHALLENGE_POINTS,
  ELIMINATED_CHALLENGE_POINTS,
  getMainChallengePoints,
  getEliminatedChallengePoints,
  JOKER_TYPES,
  INITIAL_JOKERS,
  ROUND_RULES,
  SPORT_SETTINGS,
  isValidSport,
  getSportCategory,
  getSportIcon,
  formatElevationWithBonuses,
  renderDuelIcons,
  calculateSteepElevation,
  calculateOffRoadElevation
};
