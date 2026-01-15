/**
 * ============================================
 * VERSANT - CONFIGURATION DU CHALLENGE
 * ============================================
 */

// ============================================
// CONFIGURATION GÉNÉRALE
// ============================================
export const CHALLENGE_CONFIG = {
  name: "Versant",
  fullName: "Challenge Versant 2025",
  description: "Course à élimination progressive par saisons",
  yearStartDate: "2025-01-01",
  yearEndDate: "2025-12-31",
  roundDurationDays: 5,
  eliminationsPerRound: 2,
  mainMetric: "elevation",
  mainMetricLabel: "Dénivelé positif",
  mainMetricUnit: "m",
  specialRuleFrequency: 4,  // 1 round spécial sur 4
  dataYear: 2025,
  dateLocale: "fr-FR"
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
// SYSTÈME DE POINTS
// ============================================
export const MAIN_CHALLENGE_POINTS = {
  1: 15, 2: 12, 3: 10, 4: 8, 5: 7, 6: 6, 7: 5, 8: 4, 9: 3, 10: 2, 11: 1, 12: 0, 13: 0, default: 0
};

export const ELIMINATED_CHALLENGE_POINTS = {
  1: 9, 2: 6, 3: 3, 4: 1, 5: 0, default: 0
};

// ============================================
// PARTICIPANTS
// ============================================
export const PARTICIPANTS = [
  { id: "3953180", name: "Clement D", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "6635902", name: "Bapt I", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "3762537", name: "Bapt M", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "68391361", name: "Elo F", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "5231535", name: "Franck P", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "87904944", name: "Guillaume B", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "1841009", name: "Mana S", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "106477520", name: "Matt X", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "119310419", name: "Max 2Peuf", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "19523416", name: "Morguy D", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "110979265", name: "Pef B", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "84388438", name: "Remi S", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] },
  { id: "25332977", name: "Thomas G", jokers: ["duel", "multiplicateur", "bouclier", "sabotage"] }
];

// ============================================
// JOKERS (BONUS)
// ============================================
export const JOKER_TYPES = {
  duel: {
    id: "duel",
    name: "Duel",
    icon: "⚔️",
    description: "Défiez un adversaire et volez 50% de son D+ si vous gagnez",
    effect: "Choisissez un adversaire et un critère. Actif au round suivant.",
    usableInFinal: true,
    parameters: {
      stealPercentage: 50,
      challengeCriteria: [
        { id: "single_elevation", name: "D+ d'une seule activité" },
        { id: "single_distance", name: "Distance d'une seule activité" },
        { id: "only_bike", name: "D+ vélo uniquement" },
        { id: "only_run", name: "D+ course uniquement" }
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
    parameters: { multiplier: 2 }
  },
  bouclier: {
    id: "bouclier",
    name: "Bouclier",
    icon: "🛡️",
    description: "Évitez l'élimination (quelqu'un prend votre place)",
    effect: "Protection contre l'élimination. NON UTILISABLE en finale.",
    usableInFinal: false
  },
  sabotage: {
    id: "sabotage",
    name: "Sabotage",
    icon: "💣",
    description: "Divise le D+ du premier par 2",
    effect: "Le leader perd 50% de son D+. Actif au round suivant.",
    usableInFinal: true,
    parameters: { divisor: 2 }
  }
};

// ============================================
// RÈGLES SPÉCIALES DES ROUNDS
// ============================================
export const ROUND_RULES = {
  standard: {
    id: "standard",
    name: "Standard",
    icon: "📊",
    description: "D+ classique",
    fullDescription: "Round classique : le D+ de toutes vos activités compte normalement.",
    isSpecial: false
  },
  handicap: {
    id: "handicap",
    name: "Handicap",
    icon: "⚖️",
    description: "Top 5 annuel avec malus progressif",
    fullDescription: "Les 5 premiers du classement général annuel ont un malus : 5e=-5%, 4e=-10%, 3e=-15%, 2e=-20%, 1er=-25%. Non applicable en saison 1.",
    isSpecial: true,
    notInFirstSeason: true,
    parameters: {
      malusPerPosition: { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 }
    }
  },
  combinado: {
    id: "combinado",
    name: "Combiné",
    icon: "🔄",
    description: "D+ ×2 si 2 sports différents le même jour",
    fullDescription: "Le D+ compte double les jours où vous pratiquez 2 sports différents.",
    isSpecial: true,
    implemented: true,
    parameters: { multiplier: 2 }
  },
  pentes_raides: {
    id: "pentes_raides",
    name: "Pentes Raides",
    icon: "📐",
    description: "Seul le D+ sur pentes >10% compte",
    fullDescription: "⚠️ Nécessite l'analyse des fichiers GPX bruts. Non implémenté actuellement.",
    isSpecial: true,
    implemented: false,
    requiresGPX: true
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
  sportColors: { 'Run': '#f97316', 'Bike': '#eab308', 'Hike': '#10b981', 'Ski': '#22d3ee' }
};

// ============================================
// GÉNÉRATION DU PLANNING DES ROUNDS
// ============================================
function generateRoundsSchedule() {
  const schedule = [];
  const specialRules = Object.values(ROUND_RULES).filter(r => r.isSpecial && r.implemented !== false);
  const frequency = CHALLENGE_CONFIG.specialRuleFrequency;
  const roundsPerSeason = Math.ceil(PARTICIPANTS.length / CHALLENGE_CONFIG.eliminationsPerRound);
  const totalRounds = roundsPerSeason * 12;
  
  let specialRuleIndex = 0;
  for (let i = 1; i <= totalRounds; i++) {
    const isSpecialRound = (i % frequency === 0);
    let rule = "standard";
    if (isSpecialRound && specialRules.length > 0) {
      rule = specialRules[specialRuleIndex % specialRules.length].id;
      specialRuleIndex++;
    }
    schedule.push({ number: i, rule: rule });
  }
  return schedule;
}

export const ROUNDS_SCHEDULE = generateRoundsSchedule();

// ============================================
// FONCTIONS UTILITAIRES DE CONFIG
// ============================================
export const getParticipantById = (id) => PARTICIPANTS.find(p => p.id === String(id));
export const getMainChallengePoints = (pos) => MAIN_CHALLENGE_POINTS[pos] ?? 0;
export const getEliminatedChallengePoints = (pos) => ELIMINATED_CHALLENGE_POINTS[pos] ?? 0;
export const getRoundsPerSeason = () => Math.ceil((PARTICIPANTS.length - 1) / CHALLENGE_CONFIG.eliminationsPerRound);
export const getSeasonDurationDays = () => getRoundsPerSeason() * CHALLENGE_CONFIG.roundDurationDays;
export const isValidSport = (type) => type in SPORT_SETTINGS.validSports;
export const getSportCategory = (type) => SPORT_SETTINGS.validSports[type] || null;

export function getSeasonNumber(date) {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  return Math.floor(days / getSeasonDurationDays()) + 1;
}

export function getSeasonDates(seasonNumber) {
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const duration = getSeasonDurationDays();
  const start = new Date(yearStart);
  start.setDate(start.getDate() + (seasonNumber - 1) * duration);
  const end = new Date(start);
  end.setDate(end.getDate() + duration - 1);
  const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate);
  if (end > yearEnd) end.setTime(yearEnd.getTime());
  return { start, end, duration };
}

export function getGlobalRoundNumber(date) {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  return Math.floor(days / CHALLENGE_CONFIG.roundDurationDays) + 1;
}

export function getRoundInSeason(date) {
  const global = getGlobalRoundNumber(date);
  const perSeason = getRoundsPerSeason();
  return ((global - 1) % perSeason) + 1;
}

export function getRoundInfo(globalRoundNumber) {
  const schedule = ROUNDS_SCHEDULE[globalRoundNumber - 1];
  if (!schedule) return null;
  const rule = ROUND_RULES[schedule.rule] || ROUND_RULES.standard;
  return { ...schedule, rule };
}

export function getRoundDates(globalRoundNumber) {
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const duration = CHALLENGE_CONFIG.roundDurationDays;
  const start = new Date(yearStart);
  start.setDate(start.getDate() + (globalRoundNumber - 1) * duration);
  const end = new Date(start);
  end.setDate(end.getDate() + duration - 1);
  return { start, end, duration };
}

export function isFinaleRound(roundInSeason) {
  const eliminated = (roundInSeason - 1) * CHALLENGE_CONFIG.eliminationsPerRound;
  return PARTICIPANTS.length - eliminated <= 2;
}

export function getTotalSeasons() {
  return Math.floor(365 / getSeasonDurationDays());
}
