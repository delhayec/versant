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
  eliminationsPerRound: 2,
  // Nombre de finalistes qui s'affrontent au dernier round d'une saison.
  // On élimine jusqu'à n'en garder que finalistsCount, puis un round de finale
  // les départage (tous éliminés sauf le premier).
  finalistsCount: 4,
  // Règle 0 D+ (cf. frozen-results : tous les joueurs à 0 D+ éliminés) appliquée
  // à partir de ce round. Avant le R7, versant-2026 suivait l'ancien règlement.
  zeroElevationRuleFromRound: 7,
  // Premier round où la jauge collective de D+ rapporte des points
  // (cf. ELEVATION_GAUGE). null : pas de jauge.
  elevationGaugeStartRound: 52,
  // Dernière saison avec le rescapé (L44, décision du 26/10 : mécanique
  // retirée). versant-2026 : jusqu'à la saison 8 (la 9 est en équipes, sans
  // rescapé) ; 0 pour une nouvelle édition ; null : sans limite.
  rescapeLastSeason: 8
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

// Règles des nouvelles éditions (L54) : source unique partagée avec le front.
// Une édition sans `rules` (versant-2026) garde les barèmes ci-dessus.
const EditionRules = require('../public/shared/edition-rules.js');

/**
 * Points du challenge principal pour une place de la saison.
 * @param {number} rosterSize - joueurs au départ de la saison (barème L54)
 */
function mainPointsForEdition(position, rosterSize, config = editionConfig()) {
  return EditionRules.isActive(config)
    ? EditionRules.mainPoints(position, rosterSize, config.finalistsCount)
    : getMainPoints(position);
}

/**
 * Points du challenge des éliminés pour une place.
 * @param {number} rosterSize - joueurs au départ de la saison (palier du barème L54)
 */
function eliminatedPointsForEdition(position, rosterSize, config = editionConfig()) {
  return EditionRules.isActive(config)
    ? EditionRules.eliminatedPoints(position, rosterSize)
    : getEliminatedPoints(position);
}

// ============================================
// JAUGE DE D+ COLLECTIVE
// ============================================
// À chaque round, le D+ RÉEL cumulé des joueurs du challenge principal remplit
// une jauge dont l'objectif dépend du nombre de joueurs en lice (le D+ moyen
// grimpe mécaniquement au fil de la saison, seuls les plus forts restant).
// Barème calibré sur les rounds 1→48 de 2026 (~60 % de rounds neutres).
// L44 (décision du 26/10) : l'objectif affiché (100 %) est le seuil du neutre
// (0,75 × l'ancien objectif) et les paliers sont ronds (75, 100, 175, 200 %).
// En D+ réel, le neutre et la réussite critique ne bougent pas ; l'échec
// critique passe de 0,55 à 0,5625 et la réussite de 1,30 à 1,3125 de
// l'ancien objectif. Aucun round figé n'avait encore de jauge.
// Garder synchronisé avec public/js/config.js (ELEVATION_GAUGE).
// Le round de départ est un paramètre d'édition : CHALLENGE_CONFIG.elevationGaugeStartRound.
const ELEVATION_GAUGE = {
  // Objectif de D+ MOYEN par joueur, selon le nombre de joueurs en lice
  // (0,75 × l'arrondi de la courbe 5 700 × n^-0,6 ajustée sur l'historique)
  objectivePerPlayer: [
    { minPlayers: 14, objective: 825 },
    { minPlayers: 11, objective: 975 },
    { minPlayers: 9, objective: 1125 },
    { minPlayers: 7, objective: 1312.5 },
    { minPlayers: 5, objective: 1575 },
    { minPlayers: 3, objective: 2025 },
    { minPlayers: 0, objective: 2250 }
  ],
  // Paliers en % de l'objectif (minRatio inclus), du plus haut au plus bas
  tiers: [
    { id: 'critical_success', minRatio: 2, points: 2, beneficiary: 'main' },
    { id: 'success', minRatio: 1.75, points: 1, beneficiary: 'main' },
    { id: 'neutral', minRatio: 1, points: 0, beneficiary: null },
    { id: 'failure', minRatio: 0.75, points: 1, beneficiary: 'eliminated' },
    { id: 'critical_failure', minRatio: 0, points: 2, beneficiary: 'eliminated' }
  ]
};

function getGaugeObjectivePerPlayer(nbPlayers) {
  const row = ELEVATION_GAUGE.objectivePerPlayer.find(r => nbPlayers >= r.minPlayers);
  return row ? row.objective : 0;
}

function getGaugeTier(ratio) {
  return ELEVATION_GAUGE.tiers.find(t => ratio >= t.minRatio) || ELEVATION_GAUGE.tiers[ELEVATION_GAUGE.tiers.length - 1];
}

// ============================================
// JOKERS
// ============================================
const JOKER_IDS = ['voleur', 'multiplicateur', 'bouclier', 'sabotage'];
const INITIAL_JOKER_STOCK = 2;

// ============================================
// UTILITAIRES DE DATES
// ============================================
// Durée de chaque round, en jours. Par défaut config.roundDurationDays ; un round
// peut la surcharger via round_configs.json (champ durationDays, posé par le
// planificateur des saisons Deadline). Les dates d'un round sont le CUMUL des
// durées des rounds précédents : surcharger un round ne déplace que les suivants.
const ROUND_DURATION_LIMITS = { min: 1, max: 14 };
const ROUND_DURATIONS = {};

// Planning et config de l'édition en cours (cf. edition-context.js). ROUND_DURATIONS,
// SEASON_PLANNING et SEASON_DEADLINES sont ceux de l'édition legacy (versant-2026).
// require paresseux : edition-context.js dépend lui-même de ce module.
function editionPlanning() {
  return require('./edition-context').currentEdition().planning;
}

function editionConfig() {
  return require('./edition-context').currentEdition().config;
}

function fillRoundDurations(target, roundConfigs) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [round, cfg] of Object.entries(roundConfigs || {})) {
    const days = Number(cfg?.durationDays);
    if (Number.isInteger(days) && days >= ROUND_DURATION_LIMITS.min && days <= ROUND_DURATION_LIMITS.max) {
      target[Number(round)] = days;
    }
  }
}

/** Durées de round de l'édition en cours, d'après ses configs de round. */
function setRoundDurations(roundConfigs) {
  fillRoundDurations(editionPlanning().roundDurations, roundConfigs);
}

try {
  fillRoundDurations(ROUND_DURATIONS, JSON.parse(require('fs').readFileSync(
    require('path').join(require('./data-dir').DEFAULT_EDITION_DIR, 'round_configs.json'), 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('round_configs.json illisible (durées de round):', e.message);
}

function getRoundDuration(roundNumber, config = editionConfig()) {
  return editionPlanning().roundDurations[roundNumber] || config.roundDurationDays;
}

function getRoundDates(roundNumber, config = editionConfig()) {
  // IMPORTANT : ancrer le début du round à MINUIT LOCAL (heure de Paris, cf.
  // TZ=Europe/Paris côté serveur). `new Date('2026-02-02')` serait interprété en
  // UTC → le round démarrerait à 01h/02h Paris et laisserait un trou de 00h00 à
  // 01h00 où une activité (rattachée par son heure de FIN) ne tomberait dans
  // aucun round. On parse donc les composantes Y/M/D en local.
  const [y, m, d] = String(config.yearStartDate).split('-').map(Number);
  let offsetDays = (roundNumber - 1) * config.roundDurationDays;
  for (const [r, days] of Object.entries(editionPlanning().roundDurations)) {
    if (Number(r) < roundNumber) offsetDays += days - config.roundDurationDays;
  }
  const start = new Date(y, m - 1, d + offsetDays); // minuit local
  const end = new Date(y, m - 1, d + offsetDays + getRoundDuration(roundNumber, config) - 1, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Round global contenant un instant (rattachement par getRoundDates, donc
 * compatible avec les durées variables). null avant le début du challenge.
 */
function getRoundNumberForDate(timestamp, config = editionConfig()) {
  const ts = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (ts < getRoundDates(1, config).start.getTime()) return null;
  for (let r = 1; r <= 1000; r++) {
    if (ts <= getRoundDates(r, config).end.getTime()) return r;
  }
  return null;
}

/**
 * Nombre de rounds d'une saison individuelle — SOURCE UNIQUE de la formule.
 * Miroir exact de public/js/config.js::getSeasonRoundCount.
 *
 * On élimine `eliminationsPerRound` joueurs par round jusqu'à n'en garder que
 * `finalistsCount`, puis un round de finale les départage. D'où le « + 1 ».
 *
 * Exemple avec 16 joueurs, 2 éliminations/round, 4 finalistes :
 *   ceil((16-4)/2) + 1 = 6 + 1 = 7 rounds
 *   R1 16→14, R2 →12, R3 →10, R4 →8, R5 →6, R6 →4, R7 finale 4→1
 */
function getSeasonRoundCount(
  totalParticipants,
  eliminationsPerRound = editionConfig().eliminationsPerRound,
  finalistsCount = editionConfig().finalistsCount
) {
  const toEliminate = Math.max(0, totalParticipants - finalistsCount);
  return Math.ceil(toEliminate / eliminationsPerRound) + 1;
}

function getSeasonNumber(roundNumber, totalParticipants, eliminationsPerRound = editionConfig().eliminationsPerRound) {
  const roundsPerSeason = getSeasonRoundCount(totalParticipants, eliminationsPerRound);
  return Math.ceil(roundNumber / roundsPerSeason);
}

function getRoundInSeason(roundNumber, totalParticipants, eliminationsPerRound = editionConfig().eliminationsPerRound) {
  const roundsPerSeason = getSeasonRoundCount(totalParticipants, eliminationsPerRound);
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
  double_points: {
    id: "double_points",
    name: "Points doublés",
    isTeamBased: false,
    // Tous les points du challenge principal de la saison sont multipliés
    mainPointsMultiplier: 2
  },
  deadline: {
    id: "deadline",
    name: "Deadline",
    isTeamBased: false,
    // La saison se termine à une date fixée : durée des rounds et nombre
    // d'éliminations sont planifiés pour que la finale finisse ce jour-là
    hasDeadline: true,
    durationRange: { min: 3, max: 7 },
    eliminationsRange: { min: 1, max: 4 }
  },
  team: {
    id: "team",
    name: "Équipes",
    isTeamBased: true,
    teamSize: 3,
    // Équilibrage des équipes : 'points' (classement général) ou 'elevation'
    // (D+ depuis le 1er janvier). Surchargeable par saison (teamSettings).
    balanceBy: 'points',
    eliminateWholeTeam: true,
    reshuffleEachRound: true,
    // Round supplémentaire pour le challenge éliminés en finale de saison
    extraEliminatedFinalRound: true
  }
};

// Planning modifiable depuis l'admin : data/season_planning.json surcharge les
// valeurs par défaut ci-dessus. Chargé à la lecture du module pour que serveur,
// moteur de gel et scripts voient le même planning.
const SEASON_PLANNING_FILE = require('path').join(require('./data-dir').DEFAULT_EDITION_DIR, 'season_planning.json');

// Date de fin des saisons Deadline : { [seasonNumber]: 'YYYY-MM-DD' }
const SEASON_DEADLINES = {};

// Réglages des saisons Équipes : { [seasonNumber]: { teamSize, balanceBy, elevationAdjustments } }
const SEASON_TEAM_SETTINGS = {};

/**
 * Applique le contenu de season_planning.json. Format : { types: {…}, deadlines: {…},
 * teamSettings: {…} }, ou l'ancien format plat { "9": "team" }.
 *
 * teamSettings : { "9": { "teamSize": 4, "balanceBy": "elevation",
 *   "elevationAdjustments": { "<athleteId>": 85638 } } }
 * elevationAdjustments corrige le D+ servant à l'équilibrage (athlète arrivé en
 * cours d'année dont les sorties d'avant l'inscription ne sont pas importées).
 */
function applyPlanningOverrides(planning, overrides) {
  const types = overrides?.types || (overrides?.deadlines ? {} : overrides) || {};
  for (const [season, typeId] of Object.entries(types)) {
    if (SEASON_TYPES[typeId] && Number(season) >= 1) planning.seasonTypes[Number(season)] = typeId;
  }
  for (const [season, date] of Object.entries(overrides?.deadlines || {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) planning.seasonDeadlines[Number(season)] = date;
  }
  for (const [season, settings] of Object.entries(overrides?.teamSettings || {})) {
    if (Number(season) >= 1 && settings && typeof settings === 'object') {
      planning.seasonTeamSettings[Number(season)] = settings;
    }
  }
}

/** Applique un planning (format de season_planning.json) à l'édition en cours. */
function applySeasonPlanningOverrides(overrides) {
  applyPlanningOverrides(editionPlanning(), overrides);
}

// Planning de l'édition legacy (versant-2026) : les objets ci-dessus, chargés ici
const LEGACY_PLANNING = {
  seasonTypes: SEASON_PLANNING,
  seasonDeadlines: SEASON_DEADLINES,
  seasonTeamSettings: SEASON_TEAM_SETTINGS,
  roundDurations: ROUND_DURATIONS
};

try {
  applyPlanningOverrides(LEGACY_PLANNING, JSON.parse(require('fs').readFileSync(SEASON_PLANNING_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('season_planning.json illisible:', e.message);
}

/**
 * Planning d'une édition dont les données sont rangées dans dataDir : types de
 * saisons et échéances (season_planning.json), durées de round (round_configs.json).
 * Sans fichier, toutes les saisons sont standard (pas de planning de versant-2026).
 */
function loadEditionPlanning(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const read = name => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`${name} illisible (${dataDir}):`, e.message);
      return null;
    }
  };
  const planning = { seasonTypes: {}, seasonDeadlines: {}, seasonTeamSettings: {}, roundDurations: {} };
  applyPlanningOverrides(planning, read('season_planning.json'));
  fillRoundDurations(planning.roundDurations, read('round_configs.json'));
  return planning;
}

function getSeasonDeadline(seasonNumber) {
  return editionPlanning().seasonDeadlines[seasonNumber] || null;
}

function isDeadlineSeason(seasonNumber) {
  return getSeasonType(seasonNumber)?.hasDeadline === true;
}

/** Multiplicateur des points du challenge principal pour une saison. */
function getMainPointsMultiplier(seasonNumber) {
  return getSeasonType(seasonNumber)?.mainPointsMultiplier || 1;
}

function getSeasonType(seasonNumber) {
  const typeId = editionPlanning().seasonTypes[seasonNumber] || 'standard';
  return SEASON_TYPES[typeId];
}

function isTeamSeason(seasonNumber) {
  return editionPlanning().seasonTypes[seasonNumber] === 'team';
}

/**
 * Réglages effectifs d'une saison Équipes : valeurs du type 'team' surchargées
 * par teamSettings de season_planning.json.
 * @returns {{ teamSize: number, balanceBy: 'points'|'elevation', elevationAdjustments: Object }}
 */
function getTeamSettings(seasonNumber) {
  const base = SEASON_TYPES.team;
  const custom = editionPlanning().seasonTeamSettings?.[seasonNumber] || {};
  const teamSize = Number.isInteger(custom.teamSize) && custom.teamSize >= 2 ? custom.teamSize : base.teamSize;
  return {
    teamSize,
    balanceBy: custom.balanceBy === 'elevation' ? 'elevation' : base.balanceBy,
    elevationAdjustments: custom.elevationAdjustments || {}
  };
}

/**
 * Pour une saison team, calcule le nombre de rounds total.
 * @param {number} totalParticipants - Nombre de joueurs au début de la saison
 * @returns {number} Nombre total de rounds dont 1 round final pour le challenge éliminés
 *
 * Nombre d'équipes = floor(joueurs / teamSize) : les joueurs en surplus
 * complètent des équipes existantes (cf. formBalancedTeams), ils n'en forment
 * pas une de plus. Chaque round retire exactement une équipe (16 joueurs en
 * équipes de 3 : 5 équipes → 4 → 3 → finale à 2).
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
  const teamCount = Math.floor(totalParticipants / teamSize);
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
// Au-delà de 3 équipes ou 4 joueurs par équipe : 0 pts
const TEAM_ELIMINATED_POINTS = {
  1: { 1: 12, 2: 11, 3: 10, 4: 9 },
  2: { 1:  8, 2:  7, 3:  6, 4: 5 },
  3: { 1:  4, 2:  3, 3:  2, 4: 1 }
};

function getTeamEliminatedPoints(teamRank, posInTeam) {
  return TEAM_ELIMINATED_POINTS[teamRank]?.[posInTeam] ?? 0;
}

// ============================================
// BONUS ÉPHÉMÈRES (IDs pour tirage au sort)
// ============================================
// Règles d'origine (versant-2026) : kamikaze et malediction ne sont pas tirés,
// aucun gel n'y calculait leur effet. Les nouvelles éditions (règles L54) les
// tirent, et le gel les calcule (EditionRules.BONUS_IDS).
const BONUS_IDS = [
  'embuscade', 'ravitaillement', 'duel', 'brouillard',
  'marquage', 'trap', 'second_souffle'
];

/** Bonus tirables et attribuables dans l'édition. */
function bonusIdsForEdition(config = editionConfig()) {
  return EditionRules.isActive(config) ? EditionRules.BONUS_IDS : BONUS_IDS;
}

module.exports = {
  CHALLENGE_CONFIG,
  SEASON_PLANNING,
  applySeasonPlanningOverrides,
  LEGACY_PLANNING,
  loadEditionPlanning,
  SEASON_TYPES,
  getSeasonType,
  isTeamSeason,
  getTeamSettings,
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
  EditionRules,
  bonusIdsForEdition,
  mainPointsForEdition,
  eliminatedPointsForEdition,
  ELEVATION_GAUGE,
  getGaugeObjectivePerPlayer,
  getGaugeTier,
  JOKER_IDS,
  INITIAL_JOKER_STOCK,
  BONUS_IDS,
  getRoundDates,
  getRoundDuration,
  getRoundNumberForDate,
  setRoundDurations,
  ROUND_DURATIONS,
  ROUND_DURATION_LIMITS,
  SEASON_DEADLINES,
  SEASON_TEAM_SETTINGS,
  getSeasonDeadline,
  isDeadlineSeason,
  getMainPointsMultiplier,
  getSeasonRoundCount,
  getSeasonNumber,
  getRoundInSeason
};