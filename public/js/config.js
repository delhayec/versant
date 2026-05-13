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
    description: "Par équipes de 3 – D+ cumulé – toute l'équipe dernière est éliminée",
    metric: "elevation",
    isTeamBased: true,
    teamSize: 3,
    eliminateWholeTeam: true,
    reshuffleEachRound: true,
    balancingMethod: "points", // Équilibrage sur les points du classement général
    candidateCount: 16, // Nombre de partitions candidates parmi lesquelles tirer au sort
    extraEliminatedFinalRound: true // Round supplémentaire pour le challenge éliminés
  }
};

// Planning des types de saisons sur l'année
export const SEASON_PLANNING = {
  1: "standard", 2: "standard", 3: "standard",
  4: "team", 5: "standard", 6: "standard",
  7: "standard", 8: "standard", 9: "standard",
  10: "standard", 11: "standard", 12: "standard"
};

export function getSeasonType(seasonNumber) {
  const typeId = SEASON_PLANNING[seasonNumber] || "standard";
  return SEASON_TYPES[typeId];
}

/**
 * Helper : la saison est-elle de type team ?
 * Mirror de la fonction backend pour usage uniforme.
 */
export function isTeamSeason(seasonNumber) {
  return getSeasonType(seasonNumber)?.isTeamBased === true;
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
// BARÈME — CHALLENGE ÉLIMINÉS SAISON TEAM
// ============================================
// teamRank: 1 = meilleure équipe d'éliminés (D+ cumulé le plus élevé)
// posInTeam: 1 = meilleur contributeur de l'équipe (D+ individuel le plus élevé)
// Au-delà de 3 équipes / 3 joueurs : 0 pts.
export const TEAM_ELIMINATED_POINTS = {
  1: { 1: 12, 2: 11, 3: 10 },
  2: { 1:  8, 2:  7, 3:  6 },
  3: { 1:  4, 2:  3, 3:  2 }
};

export const getTeamEliminatedPoints = (teamRank, posInTeam) =>
  TEAM_ELIMINATED_POINTS[teamRank]?.[posInTeam] ?? 0;

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
    description: "Top 10 malus, 5 derniers bonus, 4 éliminés",
    fullDescription: "Top 10 du classement général avec malus dégressif (1ᵉʳ : -50%, 2ᵉ : -40%, …, 10ᵉ : -5%). Les 5 derniers bénéficient de +10%. ⚠️ 4 éliminés au lieu de 2 !",
    isSpecial: true,
    notInFirstSeason: true,
    parameters: {
      malusPerPosition: { 1: 50, 2: 40, 3: 35, 4: 30, 5: 25, 6: 20, 7: 15, 8: 10, 9: 7, 10: 5 },
      bonusLastCount: 5,
      bonusLastPercent: 10,
      eliminationsOverride: 4
    }
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
    return PARTICIPANTS_2025;
  }

  try {

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

/**
 * Retourne le nombre de rounds pour une saison donnée.
 * Saison standard = ceil((N-1)/2), Saison équipe = ceil((N-1)/3) + 1 (finale)
 */
export function getRoundsForSeason(seasonNumber) {
  const seasonType = getSeasonType(seasonNumber);
  const count = PARTICIPANTS.length || 13;

  if (seasonType?.isTeamBased) {
    const teamSize = seasonType.teamSize || 3;
    // Chaque round élimine 1 équipe complète (teamSize joueurs)
    // Rounds d'élim = ceil((count - teamSize) / teamSize)
    // +1 pour la finale (dernières équipes s'affrontent)
    return Math.ceil((count - teamSize) / teamSize) + 1;
  }

  return Math.ceil((count - 1) / CHALLENGE_CONFIG.eliminationsPerRound);
}

/**
 * Retourne le round global du premier round d'une saison
 */
export function getSeasonStartRound(seasonNumber) {
  let globalRound = 1;
  for (let s = 1; s < seasonNumber; s++) {
    globalRound += getRoundsForSeason(s);
  }
  return globalRound;
}

/**
 * Nombre de jours d'une saison
 */
export function getSeasonDurationDays(seasonNumber) {
  const sn = seasonNumber || 1;
  return getRoundsForSeason(sn) * CHALLENGE_CONFIG.roundDurationDays;
}

/**
 * Jour de début d'une saison (en jours depuis yearStartDate)
 */
function getSeasonStartDay(seasonNumber) {
  let day = 0;
  for (let s = 1; s < seasonNumber; s++) {
    day += getRoundsForSeason(s) * CHALLENGE_CONFIG.roundDurationDays;
  }
  return day;
}

export function getTotalSeasons() {
  let totalDays = 0;
  let s = 0;
  while (totalDays < 365) {
    s++;
    totalDays += getRoundsForSeason(s) * CHALLENGE_CONFIG.roundDurationDays;
  }
  return s - 1; // La dernière saison dépasse → on ne la compte pas
}

/**
 * Retourne le numéro de saison pour une date donnée.
 * Priorité : on s'appuie sur `eliminatedChallengeRankings` du backend
 * (= saisons figées) pour déduire la saison courante. Si la saison N
 * est figée, on est dans la saison N+1.
 *
 * Fallback : calcul théorique basé sur les durées de saison
 * (peut se tromper si une saison a été raccourcie/allongée par des
 * règles spéciales handicap ou multi-éliminations).
 *
 * @param {Date} date
 * @param {Object} [frozenData] - Cache de /api/frozen-results pour la détection robuste
 */
export function getSeasonNumber(date, frozenData = null) {
  // 1. DÉTECTION ROBUSTE : on prend la dernière saison figée + 1.
  // Si frozenData est fourni (cas du rendu principal), on l'utilise en priorité.
  if (frozenData?.eliminatedChallengeRankings) {
    const frozenSeasonNumbers = Object.keys(frozenData.eliminatedChallengeRankings)
      .map(k => Number(k))
      .filter(n => !isNaN(n))
      .sort((a, b) => b - a);
    if (frozenSeasonNumbers.length > 0) {
      return frozenSeasonNumbers[0] + 1;
    }
  }

  // 2. FALLBACK : calcul théorique
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
  let accumulated = 0;
  let s = 1;
  while (s <= 20) {
    const seasonDays = getRoundsForSeason(s) * CHALLENGE_CONFIG.roundDurationDays;
    if (accumulated + seasonDays > days) return s;
    accumulated += seasonDays;
    s++;
  }
  return s;
}

export function getSeasonDates(seasonNumber) {
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const startDay = getSeasonStartDay(seasonNumber);
  const duration = getRoundsForSeason(seasonNumber) * CHALLENGE_CONFIG.roundDurationDays;

  const start = new Date(yearStart);
  start.setDate(start.getDate() + startDay);
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
  const seasonNumber = getSeasonNumber(date);
  const seasonStartRound = getSeasonStartRound(seasonNumber);
  return globalRound - seasonStartRound + 1;
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

export function isFinaleRound(roundInSeason, seasonNumber) {
  const sn = seasonNumber || getSeasonNumber(new Date());
  return roundInSeason === getRoundsForSeason(sn);
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

// Overrides manuels des règles spéciales (chargé depuis le serveur)
let specialRulesOverrides = {};

/**
 * Charge les overrides de règles spéciales depuis le serveur
 */
export async function loadSpecialRulesOverrides() {
  try {
    const response = await fetchWithTimeout('/api/special-rules', 5000);
    if (response.ok) {
      specialRulesOverrides = await response.json();
    }
  } catch (e) {
    console.warn('⚠️ Impossible de charger les règles spéciales:', e);
  }
}

/**
 * Retourne la règle spéciale pour un round donné (depuis les overrides serveur)
 */
export function getSpecialRuleForRound(globalRoundNumber) {
  return specialRulesOverrides[String(globalRoundNumber)] || null;
}

export function generateRoundsSchedule() {
  const schedule = [];
  const totalSeasons = getTotalSeasons();
  let globalRound = 1;

  for (let s = 1; s <= totalSeasons; s++) {
    const roundsThisSeason = getRoundsForSeason(s);
    const seasonType = getSeasonType(s);

    for (let r = 1; r <= roundsThisSeason; r++) {
      // La règle est "standard" par défaut, les overrides sont appliqués dynamiquement via getSpecialRuleForRound()
      let rule = 'standard';

      // Appliquer l'override si défini manuellement par l'admin
      const override = specialRulesOverrides[String(globalRound)];
      if (override && !seasonType?.isTeamBased && r !== roundsThisSeason) {
        rule = override;
      }

      schedule.push({
        number: globalRound,
        season: s,
        seasonType: seasonType?.id || 'standard',
        roundInSeason: r,
        rule,
        dates: getRoundDates(globalRound)
      });
      globalRound++;
    }
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
// FORMATION DES ÉQUIPES (Saison Team)
// ============================================

/**
 * Couleurs d'équipe pour l'affichage
 */
export const TEAM_COLORS = [
  { bg: 'rgba(249, 115, 22, 0.15)', border: '#f97316', name: 'Orange' },
  { bg: 'rgba(34, 211, 238, 0.15)', border: '#22d3ee', name: 'Cyan' },
  { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7', name: 'Violet' },
  { bg: 'rgba(16, 185, 129, 0.15)', border: '#10b981', name: 'Vert' },
  { bg: 'rgba(244, 63, 94, 0.15)', border: '#f43f5e', name: 'Rose' },
  { bg: 'rgba(234, 179, 8, 0.15)', border: '#eab308', name: 'Or' },
];

/**
 * Forme des équipes équilibrées par points du classement général.
 * Brute-force exhaustif pour ≤12 joueurs, échantillonnage pour 13+.
 *
 * @param {Array} athletes - Liste des athlètes actifs [{id, name, ...}]
 * @param {Object} pointsMap - Points par athlète {id: points}
 * @param {number} seed - Graine pour le tirage (basé sur le round number pour reproductibilité)
 * @returns {Array} Équipes [{ index, color, members: [{id, name, points}], totalPoints }]
 */
export function formBalancedTeams(athletes, pointsMap, seed = 0) {
  const n = athletes.length;
  if (n < 2) return [{ index: 0, color: TEAM_COLORS[0], members: athletes.map(a => ({ ...a, points: pointsMap[a.id] || 0 })), totalPoints: 0 }];

  // Déterminer la structure des équipes
  let teamsOf3 = Math.floor(n / 3);
  let teamsOf2 = 0;
  const remainder = n % 3;

  if (remainder === 1) {
    teamsOf3 -= 1;
    teamsOf2 = 2;
  } else if (remainder === 2) {
    teamsOf2 = 1;
  }

  // Préparer les athlètes avec leurs points
  const players = athletes.map(a => ({
    ...a,
    points: pointsMap[a.id] || 0
  }));

  // Générateur pseudo-aléatoire reproductible
  function seededRandom(s) {
    let state = s | 0 || 1;
    return function() {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  const random = seededRandom(seed);

  // Fonction d'évaluation : écart-type des sommes de points
  function evaluate(teams) {
    const sums = teams.map(t => t.reduce((s, p) => s + p.points, 0));
    const mean = sums.reduce((s, v) => s + v, 0) / sums.length;
    const variance = sums.reduce((s, v) => s + (v - mean) ** 2, 0) / sums.length;
    return Math.sqrt(variance);
  }

  // Former les équipes à partir d'un tableau mélangé
  function buildTeams(arr) {
    const teams = [];
    let idx = 0;
    for (let t = 0; t < teamsOf3; t++) { teams.push(arr.slice(idx, idx + 3)); idx += 3; }
    for (let t = 0; t < teamsOf2; t++) { teams.push(arr.slice(idx, idx + 2)); idx += 2; }
    return teams;
  }

  let candidates;

  if (n <= 12) {
    // BRUTE FORCE : énumérer toutes les partitions
    candidates = [];

    function* generatePartitions(remaining, teams, teamsOf3Left, teamsOf2Left) {
      if (remaining.length === 0) {
        yield teams.map(t => [...t]);
        return;
      }

      // Prendre le premier joueur restant (il doit aller dans une équipe)
      const first = remaining[0];
      const rest = remaining.slice(1);

      if (teamsOf3Left > 0) {
        // Former une équipe de 3 avec 'first' + 2 parmi 'rest'
        for (let i = 0; i < rest.length; i++) {
          for (let j = i + 1; j < rest.length; j++) {
            const team = [first, rest[i], rest[j]];
            const newRemaining = rest.filter((_, k) => k !== i && k !== j);
            yield* generatePartitions(newRemaining, [...teams, team], teamsOf3Left - 1, teamsOf2Left);
          }
        }
      }

      if (teamsOf2Left > 0) {
        // Former une équipe de 2 avec 'first' + 1 parmi 'rest'
        for (let i = 0; i < rest.length; i++) {
          const team = [first, rest[i]];
          const newRemaining = rest.filter((_, k) => k !== i);
          yield* generatePartitions(newRemaining, [...teams, team], teamsOf3Left, teamsOf2Left - 1);
        }
      }
    }

    for (const partition of generatePartitions(players, [], teamsOf3, teamsOf2)) {
      const stdDev = evaluate(partition);
      candidates.push({ teams: partition, stdDev });
    }
  } else {
    // ÉCHANTILLONNAGE pour 13+ joueurs
    candidates = [];
    const NUM_SAMPLES = 50000;

    for (let sample = 0; sample < NUM_SAMPLES; sample++) {
      const shuffled = [...players];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const teams = buildTeams(shuffled);
      const stdDev = evaluate(teams);
      candidates.push({ teams, stdDev });
    }
  }

  // Trier par écart-type et garder les 16 meilleurs
  candidates.sort((a, b) => a.stdDev - b.stdDev);
  const KEEP_BEST = Math.min(16, candidates.length);
  const best = candidates.slice(0, KEEP_BEST);

  // Tirer une partition au hasard parmi les meilleures
  const chosen = best[Math.floor(random() * best.length)];

  // Formater le résultat : membres triés par points desc dans chaque équipe
  return chosen.teams.map((members, teamIdx) => ({
    index: teamIdx,
    color: TEAM_COLORS[teamIdx % TEAM_COLORS.length],
    members: members.sort((a, b) => b.points - a.points),
    totalPoints: members.reduce((s, p) => s + p.points, 0)
  }));
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