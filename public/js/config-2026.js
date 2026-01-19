/**
 * ============================================
 * VERSANT - CONFIGURATION LIGUE 2026
 * ============================================
 */

// ============================================
// CONFIGURATION GÉNÉRALE
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
  apiBaseUrl: "/api"
};

// ============================================
// TYPES DE SAISONS (identique à 2025)
// ============================================
export const SEASON_TYPES = {
  standard: {
    id: "standard",
    name: "Standard",
    description: "Individuel - D+ cumulé",
    metric: "elevation",
    isTeamBased: false
  },
  distance: {
    id: "distance",
    name: "Distance",
    description: "Individuel - Distance cumulée",
    metric: "distance",
    isTeamBased: false
  },
  team: {
    id: "team",
    name: "Équipes",
    description: "Par équipes aléatoires - D+ cumulé",
    metric: "elevation",
    isTeamBased: true,
    teamSize: 3,
    reshuffleEachRound: true
  }
};

export const SEASON_PLANNING = {
  1: "standard",
  2: "standard",
  3: "distance",
  4: "standard",
  5: "team",
  6: "standard",
  7: "standard",
  8: "distance",
  9: "standard",
  10: "team",
  11: "standard"
};

export function getSeasonType(seasonNumber) {
  const typeId = SEASON_PLANNING[seasonNumber] || "standard";
  return SEASON_TYPES[typeId];
}

// ============================================
// SYSTÈME DE POINTS (identique)
// ============================================
export const MAIN_CHALLENGE_POINTS = {
  1: 18, 2: 15, 3: 12, 4: 10, 5: 8, 6: 6, 7: 5, 8: 4, 9: 3, 10: 2, 11: 1, 12: 0, 13: 0, default: 0
};

export const ELIMINATED_CHALLENGE_POINTS = {
  1: 9, 2: 6, 3: 3, 4: 2, 5: 1, default: 0
};

// ============================================
// PARTICIPANTS - CHARGÉS DYNAMIQUEMENT
// ============================================
// Les participants seront chargés depuis l'API
// au lieu d'être en dur dans le code
let participantsCache = null;

export async function loadParticipants() {
  if (participantsCache) return participantsCache;
  
  try {
    const response = await fetch(`${CHALLENGE_CONFIG.apiBaseUrl}/athletes/${CHALLENGE_CONFIG.leagueId}`);
    if (!response.ok) throw new Error('Erreur chargement participants');
    
    participantsCache = await response.json();
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

export const PARTICIPANTS = []; // Sera rempli dynamiquement

// ============================================
// JOKERS (identique à 2025)
// ============================================
export const JOKER_TYPES = {
  duel: {
    id: "duel",
    name: "Duel",
    icon: "⚔️",
    description: "Défiez un adversaire et volez 50% de son D+ si vous gagnez",
    effect: "Choisissez un adversaire et un critère. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: true,
    requiresCriteria: true,
    parameters: {
      stealPercentage: 50,
      criteria: [
        { id: "single_elevation", name: "Meilleur D+ sur une activité", metric: "total_elevation_gain", type: "single_best" },
        { id: "single_distance", name: "Meilleure distance sur une activité", metric: "distance", type: "single_best" },
        { id: "only_bike", name: "D+ vélo uniquement", metric: "total_elevation_gain", sportFilter: ["Ride", "MountainBikeRide", "GravelRide"] },
        { id: "only_run", name: "D+ course uniquement", metric: "total_elevation_gain", sportFilter: ["Run", "TrailRun"] }
      ]
    }
  },
  multiplicateur: {
    id: "multiplicateur",
    name: "Multiplicateur",
    icon: "✖️",
    description: "Double le D+ d'une journée choisie",
    effect: "×2 sur une journée du round. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: false,
    parameters: { multiplier: 2 }
  },
  bouclier: {
    id: "bouclier",
    name: "Bouclier",
    icon: "🛡️",
    description: "Protection contre l'élimination pour un round",
    effect: "Actif au round suivant. Ne fonctionne pas en finale.",
    usableInFinal: false,
    requiresTarget: false,
    parameters: {}
  },
  sabotage: {
    id: "sabotage",
    name: "Sabotage",
    icon: "💣",
    description: "Divise par 2 le D+ d'un adversaire",
    effect: "Ciblez un adversaire. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: true,
    parameters: { divisor: 2 }
  }
};

// ============================================
// RÈGLES SPÉCIALES
// ============================================
export const ROUND_RULES = {
  //
};

// ============================================
// FONCTIONS UTILITAIRES
// ============================================
export function getRoundInfo(roundNumber) {
  const startDate = new Date(CHALLENGE_CONFIG.yearStartDate);
  startDate.setDate(startDate.getDate() + (roundNumber - 1) * CHALLENGE_CONFIG.roundDurationDays);
  
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + CHALLENGE_CONFIG.roundDurationDays - 1);
  
  return {
    roundNumber,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

export function getRoundDates(roundNumber) {
  const info = getRoundInfo(roundNumber);
  return { start: info.startDate, end: info.endDate };
}

export function getSeasonNumber(roundNumber) {
  const roundsPerSeason = getRoundsPerSeason();
  return Math.ceil(roundNumber / roundsPerSeason);
}

export function getRoundsPerSeason() {
  return 5; // 5 rounds par saison
}

export function isValidSport(sportType) {
  const validSports = [
    'Run', 'TrailRun', 'Hike',
    'Ride', 'MountainBikeRide', 'GravelRide',
    'BackcountrySki', 'NordicSki', 'AlpineSki'
  ];
  return validSports.includes(sportType);
}

export function getMainChallengePoints(position) {
  return MAIN_CHALLENGE_POINTS[position] || MAIN_CHALLENGE_POINTS.default;
}

export function getEliminatedChallengePoints(position) {
  return ELIMINATED_CHALLENGE_POINTS[position] || ELIMINATED_CHALLENGE_POINTS.default;
}
