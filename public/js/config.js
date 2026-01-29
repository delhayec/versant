/**
 * ============================================
 * VERSANT - CONFIGURATION GLOBALE UNIFIÉE
 * ============================================
 * Ce fichier contient TOUTES les configurations :
 * - Paramètres de la ligue
 * - Participants
 * - Règles des rounds
 * - Jokers (bonus)
 * - Sports acceptés
 * - Système de points
 * - Utilitaires de date
 */

// ============================================
// CONFIGURATION PRINCIPALE DE LA LIGUE
// ============================================
export const CHALLENGE_CONFIG = {
  name: "Versant",
  fullName: "Challenge Versant 2025",
  description: "Course à élimination progressive par saisons",
  leagueId: "versant-2025",
  yearStartDate: "2025-01-01",
  yearEndDate: "2025-12-31",
  roundDurationDays: 5,
  eliminationsPerRound: 2,
  mainMetric: "elevation",
  mainMetricLabel: "Dénivelé positif",
  mainMetricUnit: "m",
  specialRuleFrequency: 4,
  dataYear: 2025,
  dateLocale: "fr-FR",
  isDemo: false
};

// ============================================
// AUTHENTIFICATION
// ============================================
export const AUTH_CONFIG = {
  accessCode: "versant2025",
  sessionDurationHours: 24,
  rememberMeDays: 30
};

// ============================================
// TYPES DE SAISONS
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

// Planning des types de saisons sur l'année
export const SEASON_PLANNING = {
  1: "standard", 2: "standard", 3: "distance",
  4: "standard", 5: "team", 6: "standard",
  7: "standard", 8: "distance", 9: "standard",
  10: "team", 11: "standard", 12: "standard"
};

export function getSeasonType(seasonNumber) {
  const typeId = SEASON_PLANNING[seasonNumber] || "standard";
  return SEASON_TYPES[typeId];
}

// ============================================
// SYSTÈME DE POINTS
// ============================================
export const MAIN_CHALLENGE_POINTS = {
  1: 15, 2: 12, 3: 10, 4: 8, 5: 7, 6: 6, 7: 5, 8: 4, 9: 3, 10: 2, 11: 1, 12: 0, 13: 0, default: 0
};

export const ELIMINATED_CHALLENGE_POINTS = {
  1: 9, 2: 6, 3: 3, 4: 1, 5: 0, default: 0
};

export const getMainChallengePoints = (pos) => MAIN_CHALLENGE_POINTS[pos] ?? MAIN_CHALLENGE_POINTS.default ?? 0;
export const getEliminatedChallengePoints = (pos) => ELIMINATED_CHALLENGE_POINTS[pos] ?? ELIMINATED_CHALLENGE_POINTS.default ?? 0;

// ============================================
// JOKERS (BONUS) - Définition complète
// ============================================
export const JOKER_TYPES = {
  duel: {
    id: "duel",
    name: "Duel",
    icon: "⚔️",
    description: "Défiez un adversaire et volez 25% de son D+ si vous gagnez",
    effect: "Choisissez un adversaire. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: true,
    notOnLastDay: true,
    parameters: { stealPercentage: 25 }
  },
  multiplicateur: {
    id: "multiplicateur",
    name: "Multiplicateur",
    icon: "✖️",
    description: "Multiplie votre D+ par 1.5",
    effect: "×1.5 sur tout votre D+ du round. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: false,
    parameters: { multiplier: 1.5 }
  },
  bouclier: {
    id: "bouclier",
    name: "Bouclier",
    icon: "🛡️",
    description: "Évitez l'élimination",
    effect: "Protection contre l'élimination. NON UTILISABLE en finale.",
    usableInFinal: false,
    requiresTarget: false
  },
  sabotage: {
    id: "sabotage",
    name: "Sabotage",
    icon: "💣",
    description: "Retire 25% du D+ d'un adversaire",
    effect: "Ciblez un adversaire. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: true,
    parameters: { stealPercentage: 25 }
  }
};

// Stock initial de jokers par participant
export const INITIAL_JOKERS = {
  duel: 2,
  multiplicateur: 2,
  bouclier: 2,
  sabotage: 2
};

// ============================================
// RÈGLES SPÉCIALES DES ROUNDS
// ============================================
export const ROUND_RULES = {
  standard: {
    id: "standard",
    name: "Standard",
    icon: "📊",
    description: "Classique",
    fullDescription: "Round classique : D+ cumulé.",
    isSpecial: false,
    requiresStream: false
  },
  handicap: {
    id: "handicap",
    name: "Handicap",
    icon: "⚖️",
    description: "Top 5 annuel avec malus",
    fullDescription: "Top 5 du classement général: 5e=-5%, 4e=-10%, 3e=-15%, 2e=-20%, 1er=-25%",
    isSpecial: true,
    notInFirstSeason: true,
    parameters: { malusPerPosition: { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 } }
  },
  combinado: {
    id: "combinado",
    name: "Combiné",
    icon: "🔄",
    description: "D+ doublé si 2 sports différents/jour",
    fullDescription: "Métrique ×2 les jours avec 2 sports différents.",
    isSpecial: true,
    parameters: { multiplier: 2 }
  },
  pentes_raides: {
    id: "pentes_raides",
    name: "Pentes Raides",
    icon: "📐",
    description: "Seul le D+ sur pentes >15% compte",
    fullDescription: "Seul le dénivelé sur segments avec pente >15%.",
    isSpecial: true,
    requiresStream: true,
    parameters: { minGradient: 15 }
  },
  hors_bitume: {
    id: "hors_bitume",
    name: "Hors Bitume",
    icon: "🌲",
    description: "Seul le D+ hors route compte",
    fullDescription: "Seul le dénivelé hors routes goudronnées.",
    isSpecial: true,
    requiresStream: true
  },
  double_weekend: {
    id: "double_weekend",
    name: "Double Weekend",
    icon: "📅",
    description: "D+ doublé samedi et dimanche",
    fullDescription: "Le D+ des samedis et dimanches est doublé.",
    isSpecial: true,
    parameters: { multiplier: 2 }
  }
};

// ============================================
// SPORTS ACCEPTÉS
// ============================================
export const SPORT_SETTINGS = {
  validSports: {
    'Run': 'Run', 'TrailRun': 'Run',
    'Ride': 'Bike', 'MountainBikeRide': 'Bike', 'GravelRide': 'Bike',
    'Hike': 'Hike', 'Walk': 'Hike', 'Snowshoe': 'Hike',
    'BackcountrySki': 'Ski', 'NordicSki': 'Ski'
  },
  excludedSports: ['AlpineSki', 'Snowboard', 'EBikeRide', 'EMountainBikeRide', 'VirtualRide', 'VirtualRun', 'Swim', 'Yoga', 'WeightTraining'],
  sportColors: { 'Run': '#f97316', 'Bike': '#eab308', 'Hike': '#10b981', 'Ski': '#22d3ee' },
  sportIcons: { 'Run': '🏃', 'Bike': '🚴', 'Hike': '🥾', 'Ski': '⛷️' }
};

export const isValidSport = (type) => type in SPORT_SETTINGS.validSports;
export const getSportCategory = (type) => SPORT_SETTINGS.validSports[type] || null;
export const getSportIcon = (type) => {
  const category = getSportCategory(type);
  return SPORT_SETTINGS.sportIcons[category] || '🏋️';
};

// ============================================
// PARTICIPANTS
// ============================================
function createInitialJokers() {
  return { ...INITIAL_JOKERS };
}

export const PARTICIPANTS = [
  { id: "3953180", name: "Clement D", jokers: createInitialJokers() },
  { id: "6635902", name: "Bapt I", jokers: createInitialJokers() },
  { id: "3762537", name: "Bapt M", jokers: createInitialJokers() },
  { id: "68391361", name: "Elo F", jokers: createInitialJokers() },
  { id: "5231535", name: "Franck P", jokers: createInitialJokers() },
  { id: "87904944", name: "Guillaume B", jokers: createInitialJokers() },
  { id: "1841009", name: "Mana S", jokers: createInitialJokers() },
  { id: "106477520", name: "Matt X", jokers: createInitialJokers() },
  { id: "119310419", name: "Max 2Peuf", jokers: createInitialJokers() },
  { id: "19523416", name: "Morguy D", jokers: createInitialJokers() },
  { id: "110979265", name: "Pef B", jokers: createInitialJokers() },
  { id: "84388438", name: "Remi S", jokers: createInitialJokers() },
  { id: "25332977", name: "Thomas G", jokers: createInitialJokers() }
];

export const getParticipantById = (id) => PARTICIPANTS.find(p => p.id === String(id));

// ============================================
// UTILITAIRES DE DATE
// ============================================
const participantsCount = PARTICIPANTS.length;

export function getRoundsPerSeason() {
  return Math.ceil((participantsCount - 1) / CHALLENGE_CONFIG.eliminationsPerRound);
}

export function getSeasonDurationDays() {
  return getRoundsPerSeason() * CHALLENGE_CONFIG.roundDurationDays;
}

export function getTotalSeasons() {
  return Math.floor(365 / getSeasonDurationDays());
}

export function getSeasonNumber(date) {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.floor(days / getSeasonDurationDays()) + 1);
}

export function getSeasonDates(seasonNumber) {
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const duration = getSeasonDurationDays();
  const start = new Date(yearStart);
  start.setDate(start.getDate() + (seasonNumber - 1) * duration);
  const end = new Date(start);
  end.setDate(end.getDate() + duration - 1);
  end.setHours(23, 59, 59, 999);
  const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate);
  return {
    start,
    end: end > yearEnd ? yearEnd : end
  };
}

export function getGlobalRoundNumber(date) {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.floor(days / CHALLENGE_CONFIG.roundDurationDays) + 1);
}

export function getRoundInSeason(date) {
  const globalRound = getGlobalRoundNumber(date);
  const roundsPerSeason = getRoundsPerSeason();
  return ((globalRound - 1) % roundsPerSeason) + 1;
}

export function getRoundDates(globalRoundNumber) {
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const start = new Date(yearStart);
  start.setDate(start.getDate() + (globalRoundNumber - 1) * CHALLENGE_CONFIG.roundDurationDays);
  const end = new Date(start);
  end.setDate(end.getDate() + CHALLENGE_CONFIG.roundDurationDays - 1);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function isFinaleRound(roundInSeason) {
  return roundInSeason === getRoundsPerSeason();
}

export function isLastDayOfRound(date, globalRoundNumber) {
  const roundDates = getRoundDates(globalRoundNumber);
  const today = new Date(date);
  today.setHours(0, 0, 0, 0);
  const endDay = new Date(roundDates.end);
  endDay.setHours(0, 0, 0, 0);
  return today.getTime() === endDay.getTime();
}

// ============================================
// GÉNÉRATION DU PLANNING DES ROUNDS
// ============================================
export function generateRoundsSchedule() {
  const schedule = [];
  const roundsPerSeason = getRoundsPerSeason();
  const totalSeasons = getTotalSeasons();
  const totalRounds = roundsPerSeason * totalSeasons;
  const specialRules = Object.keys(ROUND_RULES).filter(k => ROUND_RULES[k].isSpecial);
  
  for (let i = 1; i <= totalRounds; i++) {
    const seasonNumber = Math.ceil(i / roundsPerSeason);
    const roundInSeason = ((i - 1) % roundsPerSeason) + 1;
    let rule = 'standard';
    
    // Règle spéciale tous les X rounds (sauf finale)
    if (roundInSeason % CHALLENGE_CONFIG.specialRuleFrequency === 0 && roundInSeason !== roundsPerSeason) {
      const ruleIndex = Math.floor(i / CHALLENGE_CONFIG.specialRuleFrequency) % specialRules.length;
      rule = specialRules[ruleIndex];
      
      // Handicap pas en saison 1
      if (rule === 'handicap' && seasonNumber === 1) {
        rule = 'combinado';
      }
    }
    
    schedule.push({
      number: i,
      season: seasonNumber,
      roundInSeason,
      rule,
      dates: getRoundDates(i)
    });
  }
  
  return schedule;
}

export const ROUNDS_SCHEDULE = generateRoundsSchedule();

export function getRoundInfo(globalRoundNumber) {
  const schedule = ROUNDS_SCHEDULE[globalRoundNumber - 1];
  if (!schedule) return null;
  const rule = ROUND_RULES[schedule.rule] || ROUND_RULES.standard;
  return { ...schedule, ruleDetails: rule };
}

// ============================================
// COULEURS ET VISUELS DES ATHLÈTES
// ============================================
export const ATHLETE_COLORS = ['#f97316', '#22d3ee', '#a855f7', '#10b981', '#f43f5e', '#eab308', '#3b82f6', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4', '#84cc16'];

const colorMap = {};
export function getAthleteColor(id) {
  return colorMap[id] || (colorMap[id] = ATHLETE_COLORS[Object.keys(colorMap).length % ATHLETE_COLORS.length]);
}

export function getAthleteInitials(id) {
  const p = getParticipantById(id);
  if (!p) return '?';
  const n = p.name.split(' ');
  return n.length >= 2 ? n[0][0] + n[1][0] : p.name.substring(0, 2).toUpperCase();
}
