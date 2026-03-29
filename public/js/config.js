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
 * 
 * Détection automatique: demo.html → 2025, sinon → 2026
 */

// ============================================
// DÉTECTION DU MODE (DEMO vs PRODUCTION)
// ============================================
const IS_DEMO = typeof window !== 'undefined' && window.location.pathname.includes('demo');
const CURRENT_YEAR = IS_DEMO ? 2025 : 2026;

console.log(`⚙️ Config: mode ${IS_DEMO ? 'DEMO (2025)' : 'PRODUCTION (2026)'}`);

// ============================================
// CONFIGURATION PRINCIPALE DE LA LIGUE
// ============================================

// Date de début différente selon l'année : 2025 = 1er janvier (démo), 2026 = 1er février 02-01
const CHALLENGE_START_DATE = IS_DEMO ? `${CURRENT_YEAR}-01-01` : `${CURRENT_YEAR}-02-02`;

export const CHALLENGE_CONFIG = {
  name: "Versant",
  fullName: `Challenge Versant ${CURRENT_YEAR}`,
  description: "Course à élimination progressive par saisons",
  leagueId: `versant-${CURRENT_YEAR}`,
  yearStartDate: CHALLENGE_START_DATE,
  yearEndDate: `${CURRENT_YEAR}-12-31`,
  roundDurationDays: 5,
  eliminationsPerRound: 2,
  mainMetric: "elevation",
  mainMetricLabel: "Dénivelé positif",
  mainMetricUnit: "m",
  specialRuleFrequency: 4,
  dataYear: CURRENT_YEAR,
  dateLocale: "fr-FR",
  isDemo: IS_DEMO
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
  1: "standard", 2: "standard", 3: "standard",
  4: "standard", 5: "team", 6: "standard",
  7: "standard", 8: "standard", 9: "standard",
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
  1: 24, 2: 21, 3: 18, 4: 15, 5: 12, 6: 10, 7: 8, 8: 6, 9: 5, 10: 4, 11: 3, 12: 2, 13: 1, default: 0
};

export const ELIMINATED_CHALLENGE_POINTS = {
  1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1, default: 0
};

export const getMainChallengePoints = (pos) => MAIN_CHALLENGE_POINTS[pos] ?? MAIN_CHALLENGE_POINTS.default ?? 0;
export const getEliminatedChallengePoints = (pos) => ELIMINATED_CHALLENGE_POINTS[pos] ?? ELIMINATED_CHALLENGE_POINTS.default ?? 0;

// ============================================
// JOKERS (BONUS) - Définition complète
// ============================================
export const JOKER_TYPES = {
   voleur: {
    id: "voleur",
    name: "Voleur",
    icon: "🦹",
    description: "Vole l'activité avec le plus de D+ d'un adversaire",
    effect: "Choisissez un adversaire. Vous lui volez son activité avec le plus de D+.",
    usableInFinal: true,
    requiresTarget: true,
    canActivateNow: true,
    maxDayForImmediateUse: 3
  },
  multiplicateur: {
    id: "multiplicateur",
    name: "Multiplicateur",
    icon: "✖️",
    description: "Multiplie votre D+ par 1.5",
    effect: "×1.5 sur tout votre D+ du round.",
    usableInFinal: true,
    requiresTarget: false,
    canActivateNow: true,
    maxDayForImmediateUse: 3
  },
  bouclier: {
    id: "bouclier",
    name: "Bouclier",
    icon: "🛡️",
    description: "Évitez l'élimination",
    effect: "Protection contre l'élimination. NON UTILISABLE en finale.",
    usableInFinal: false,
    requiresTarget: false,
    canActivateNow: true,
    maxDayForImmediateUse: 3
  },
  sabotage: {
    id: "sabotage",
    name: "Sabotage",
    icon: "💣",
    description: "Retire 30% du D+ d'un adversaire",
    effect: "Ciblez un adversaire. -30% sur son D+ du round.",
    usableInFinal: true,
    requiresTarget: true,
    canActivateNow: true,
    maxDayForImmediateUse: 3
  }
};

// ============================================
// BONUS ÉPHÉMÈRES (Challenge des Éliminés)
// ============================================
// Attribués au meilleur des 2 éliminés d'un round
// Le joueur choisit 1 bonus parmi 2 tirés au sort
// Expirent à la fin de la saison s'ils ne sont pas utilisés

export const BONUS_TYPES = {
  embuscade: {
    id: "embuscade",
    name: "Embuscade",
    icon: "🏹",
    description: "Vole une activité aléatoire d'un joueur actif",
    effect: "Choisis un joueur actif. Une de ses activités (+20min) est tirée au sort : son D+ lui est retiré et t'est transféré dans le challenge des éliminés.",
    timing: "⏰ Activation : 3 premiers jours du round · ⚡ Effet : fin du round",
    category: "offensif",
    requiresTarget: true,
    targetType: "active",
    activation: {
      timing: "3_premiers_jours",
      effect: "fin_round"
    },
    parameters: {
      minActivityDuration: 20
    }
  },
  ravitaillement: {
    id: "ravitaillement",
    name: "Ravitaillement",
    icon: "🎒",
    description: "Donne une de tes activités aléatoire à un joueur actif",
    effect: "Choisis un joueur actif. Une de tes activités (+20min) est tirée au sort : son D+ lui est ajouté en bonus. Tu conserves aussi ce D+ dans ton total.",
    timing: "⏰ Activation : 3 premiers jours du round · ⚡ Effet : fin du round",
    category: "soutien",
    requiresTarget: true,
    targetType: "active",
    activation: {
      timing: "3_premiers_jours",
      effect: "fin_round"
    },
    parameters: {
      minActivityDuration: 20
    }
  },
  duel: {
    id: "duel",
    name: "Duel",
    icon: "⚔️",
    description: "Défie ton co-éliminé pour un point bonus",
    effect: "Tu défies automatiquement l'autre joueur éliminé en même temps que toi. À la fin de la saison, celui avec le plus de D+ (depuis l'élimination) gagne +1 point au classement général. Égalité = aucun point.",
    timing: "⏰ Activation : automatique dès le choix · ⚡ Effet : fin de saison",
    category: "competitif",
    requiresTarget: false,
    targetType: "co_eliminated",
    activation: {
      timing: "automatique",
      effect: "fin_saison"
    }
  },
  brouillard: {
    id: "brouillard",
    name: "Brouillard",
    icon: "🌫️",
    description: "Cache ton D+ jusqu'à la fin de la saison",
    effect: "Tu te caches ! Ton D+ est masqué : tu apparais dernier du classement des éliminés pour tous. Seul toi vois ton vrai D+ dans ton dashboard. Révélation à la fin de la saison.",
    timing: "⏰ Activation : dans les 48h après élimination · ⚡ Effet : fin de saison",
    category: "defensif",
    requiresTarget: false,
    targetType: "self",
    activation: {
      timing: "48h_apres_elimination",
      effect: "fin_saison"
    }
  },
  marquage: {
    id: "marquage",
    name: "Marquage",
    icon: "🎯",
    description: "Parie sur l'élimination d'un joueur actif",
    effect: "Le 1er jour d'un round, marque un joueur actif. S'il termine dans les 2 dernières places (éliminé) à la fin du round, tu gagnes +1 point au classement général. Sinon, le bonus est perdu.",
    timing: "⏰ Activation : jour 1 du round uniquement · ⚡ Effet : fin du round",
    category: "pari",
    requiresTarget: true,
    targetType: "active",
    activation: {
      timing: "jour_1",
      effect: "fin_round"
    }
  },
  trap: {
    id: "trap",
    name: "It's a TRAP !",
    icon: "🪤",
    description: "Piège le prochain dernier éliminé",
    effect: "Piège passif qui reste actif. Quand un joueur est éliminé en dernière position, tu récupères le D+ de sa dernière activité du round (copie, pas vol). Le piège se désactive après déclenchement.",
    timing: "⏰ Activation : automatique dès réception · ⚡ Effet : au prochain éliminé dernier",
    category: "piege",
    requiresTarget: false,
    targetType: "passive",
    activation: {
      timing: "automatique",
      effect: "debut_round_suivant"
    }
  },
  second_souffle: {
    id: "second_souffle",
    name: "Second Souffle",
    icon: "🔥",
    description: "Double ta plus petite activité de la saison",
    effect: "Récompense la régularité ! À la fin de la saison, ton activité avec le D+ le plus faible (depuis ton élimination) compte double dans ton total.",
    timing: "⏰ Activation : automatique dès réception · ⚡ Effet : fin de saison",
    category: "boost",
    requiresTarget: false,
    targetType: "self",
    activation: {
      timing: "automatique",
      effect: "fin_saison"
    }
  },
  kamikaze: {
    id: "kamikaze",
    name: "Kamikaze",
    icon: "💣",
    description: "Tu te sacrifies pour entraîner un adversaire dans ta chute",
    effect: "Tu perds 25% de ton D+ du round, mais ta cible (joueur actif de ton choix) perd aussi 25% de son D+ du round. Sacrifice mutuel !",
    timing: "⏰ Activation : 3 premiers jours du round · ⚡ Effet : fin du round",
    category: "offensif",
    requiresTarget: true,
    targetType: "active",
    activation: {
      timing: "3_premiers_jours",
      effect: "fin_round"
    },
    parameters: {
      percentageLost: 25 // pourcentage de D+ perdu
    }
  },
  malediction: {
    id: "malediction",
    name: "Malédiction",
    icon: "🪬",
    description: "Tu maudis l'un des responsables de ton élimination",
    effect: "Tu maudis un joueur parmi les 3 juste au-dessus de toi lors de ton élimination. À chaque fin de round, 10% de son D+ lui est volé et ajouté à ton total. L'effet cesse quand il est éliminé.",
    timing: "⏰ Activation : automatique dès le choix · ⚡ Effet : chaque fin de round",
    category: "offensif",
    requiresTarget: true,
    targetType: "eliminator", // les 3 joueurs au-dessus lors de l'élimination
    activation: {
      timing: "automatique",
      effect: "chaque_fin_round"
    },
    parameters: {
      percentageStolen: 10, // pourcentage de D+ volé par round
      maxTargets: 3 // nombre de cibles possibles (3 au-dessus)
    }
  }
};

// Liste des IDs de bonus pour le tirage au sort
export const BONUS_IDS = Object.keys(BONUS_TYPES);

// Nombre de bonus proposés au choix (style roguelite)
export const BONUS_CHOICE_COUNT = 2;

// Stock initial de jokers par participant (2 de chaque)
// Note: le calcul du stock réel se fait dans jokers.js basé sur les utilisations serveur
export const INITIAL_JOKERS = {
  voleur: 2,
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

// Note: Les jokers ne sont PAS stockés dans PARTICIPANTS
// Tout le stock/usage des jokers vient du serveur via jokers.js

// Participants 2025 (pour demo - statique)
const PARTICIPANTS_2025 = [
  { id: "3953180", name: "Clement D" },
  { id: "6635902", name: "Bapt I" },
  { id: "3762537", name: "Bapt M" },
  { id: "68391361", name: "Elo F" },
  { id: "5231535", name: "Franck P" },
  { id: "87904944", name: "Guillaume B" },
  { id: "1841009", name: "Mana S" },
  { id: "106477520", name: "Matt X" },
  { id: "119310419", name: "Max 2Peuf" },
  { id: "19523416", name: "Morguy D" },
  { id: "110979265", name: "Pef B" },
  { id: "84388438", name: "Remi S" },
  { id: "25332977", name: "Thomas G" }
];

// Participants 2026 (tableau mutable, chargé depuis l'API)
let PARTICIPANTS_2026 = [];

// Liste des participants active (mutable pour permettre le chargement dynamique)
export let PARTICIPANTS = IS_DEMO ? [...PARTICIPANTS_2025] : [];

/**
 * Charge les participants depuis l'API (pour mode production 2026)
 * À appeler au démarrage de l'application
 */
// Helper pour fetch avec timeout et cache-busting (important pour mobile)
async function fetchWithTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Ajouter cache-buster pour éviter le cache mobile
  const cacheBuster = Date.now();
  const separator = url.includes('?') ? '&' : '?';
  const urlWithCacheBuster = `${url}${separator}_=${cacheBuster}`;

  try {
    const response = await fetch(urlWithCacheBuster, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout après ${timeout/1000}s`);
    }
    throw error;
  }
}

export async function loadParticipants() {
  if (IS_DEMO) {
    console.log('📋 Mode démo: utilisation des participants 2025 statiques');
    return PARTICIPANTS_2025;
  }

  try {
    console.log('📋 Chargement des participants depuis l\'API...');

    // Utiliser le même endpoint que l'admin : /api/athletes/versant-2026
    // Timeout de 8 secondes pour éviter blocage sur mobile
    const response = await fetchWithTimeout(`/api/athletes/${CHALLENGE_CONFIG.leagueId}`, 8000);

    if (!response.ok) {
      throw new Error(`Erreur API: ${response.status}`);
    }

    const athletes = await response.json();

    if (athletes && athletes.length > 0) {
      // Transformer le format API en format PARTICIPANTS
      // Inclure registered_at pour gérer les inscriptions tardives
      const loadedParticipants = athletes.map(a => ({
        id: String(a.id),
        name: a.name || `${a.firstname || ''} ${a.lastname || ''}`.trim(),
        registeredAt: a.registered_at || a.registeredAt || null
      }));

      // Mettre à jour la liste globale
      PARTICIPANTS.length = 0;
      PARTICIPANTS.push(...loadedParticipants);

      console.log(`✅ ${PARTICIPANTS.length} participants chargés depuis l'API`);
    } else {
      console.warn('⚠️ Aucun participant dans athletes.json, tentative d\'extraction depuis les activités...');
      await loadParticipantsFromActivities();
    }

    return PARTICIPANTS;
  } catch (error) {
    console.error('❌ Erreur chargement participants:', error);
    // Tenter de charger depuis les activités en cas d'erreur
    await loadParticipantsFromActivities();
    return PARTICIPANTS;
  }
}

/**
 * Extrait les participants uniques depuis les activités
 * Utilisé comme fallback quand athletes.json est vide
 */
async function loadParticipantsFromActivities() {
  try {
    const response = await fetchWithTimeout(`/api/activities/${CHALLENGE_CONFIG.leagueId}`, 10000);
    if (!response.ok) return;

    const activities = await response.json();
    if (!activities || activities.length === 0) return;

    // Extraire les participants uniques
    const participantsMap = new Map();

    for (const activity of activities) {
      const athleteId = String(activity.athlete?.id || activity.athlete_id);
      if (!athleteId || participantsMap.has(athleteId)) continue;

      const name = activity.athlete_name ||
                   (activity.athlete?.firstname && activity.athlete?.lastname
                     ? `${activity.athlete.firstname} ${activity.athlete.lastname.charAt(0)}.`
                     : `Athlète ${athleteId}`);

      participantsMap.set(athleteId, {
        id: athleteId,
        name: name
      });
    }

    if (participantsMap.size > 0) {
      PARTICIPANTS.length = 0;
      PARTICIPANTS.push(...participantsMap.values());
      console.log(`✅ ${PARTICIPANTS.length} participants extraits depuis les activités`);
    }
  } catch (error) {
    console.error('❌ Erreur extraction participants depuis activités:', error);
  }
}

export const getParticipantById = (id) => PARTICIPANTS.find(p => p.id === String(id));

// ============================================
// UTILITAIRES DE DATE
// ============================================

// Utiliser PARTICIPANTS.length dynamiquement (pas de variable statique)
export function getRoundsPerSeason() {
  const count = PARTICIPANTS.length || 13; // Fallback à 13 si pas encore chargé
  return Math.ceil((count - 1) / CHALLENGE_CONFIG.eliminationsPerRound);
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
// GESTION DES INSCRIPTIONS TARDIVES
// ============================================

/**
 * Vérifie si un participant était inscrit avant le début du challenge
 * @param {Object} participant - Le participant avec sa date d'inscription
 * @returns {boolean} true si inscrit à temps pour le challenge principal
 */
export function wasRegisteredBeforeStart(participant) {
  if (!participant.registeredAt) {
    // Si pas de date d'inscription, on considère qu'il était là au début
    return true;
  }
  
  const registrationDate = new Date(participant.registeredAt);
  const challengeStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  
  return registrationDate < challengeStart;
}

/**
 * Retourne la liste des participants éligibles au challenge principal
 * (ceux inscrits AVANT le début du challenge)
 */
export function getEligibleParticipants() {
  return PARTICIPANTS.filter(p => wasRegisteredBeforeStart(p));
}

/**
 * Retourne la liste des participants inscrits en retard
 * (directement dans le challenge des éliminés)
 */
export function getLateRegistrations() {
  return PARTICIPANTS.filter(p => !wasRegisteredBeforeStart(p));
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