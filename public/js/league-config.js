/**
 * ============================================
 * VERSANT - CONFIGURATION DE BASE PARTAGÉE
 * ============================================
 * Ce fichier contient toutes les configurations communes
 * entre le site principal et la démo.
 * 
 * Les fichiers config.js et config-demo.js importent
 * et étendent ces configurations de base.
 */

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
  11: "standard",
  12: "standard"
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
    effect: "Choisissez un adversaire et un critère. Actif au round suivant. Utilisable jusqu'à l'avant-dernier jour du round.",
    usableInFinal: true,
    requiresTarget: true,
    requiresCriteria: true,
    // Restriction : ne peut pas être utilisé le dernier jour du round
    notOnLastDay: true,
    parameters: {
      stealPercentage: 25, // 25% au lieu de 50%
      criteria: [
        { id: "single_elevation", name: "Meilleur D+ sur une activité", metric: "total_elevation_gain", type: "single_best" },
        { id: "single_distance", name: "Meilleure distance sur une activité", metric: "distance", type: "single_best" },
        { id: "longest_activity", name: "Plus longue activité (temps)", metric: "moving_time", type: "single_best" },
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
    description: "Évitez l'élimination (quelqu'un prend votre place)",
    effect: "Protection contre l'élimination. NON UTILISABLE en finale.",
    usableInFinal: false,
    requiresTarget: false
  },
  sabotage: {
    id: "sabotage",
    name: "Sabotage",
    icon: "💣",
    description: "Retire 250m de D+ à un adversaire",
    effect: "Ciblez un adversaire. Actif au round suivant.",
    usableInFinal: true,
    requiresTarget: true,
    parameters: { 
      fixedAmount: 250 // Montant fixe au lieu de pourcentage
    }
  }
};

// Stock initial de jokers par personne
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
    fullDescription: "Round classique : métrique principale.",
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
    requiresStream: false,
    parameters: { malusPerPosition: { 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 } }
  },
  combinado: {
    id: "combinado",
    name: "Combiné",
    icon: "🔄",
    description: "D+ doublé si 2 sports différents/jour",
    fullDescription: "Métrique ×2 les jours avec 2 sports différents.",
    isSpecial: true,
    implemented: true,
    requiresStream: false,
    parameters: { multiplier: 2 }
  },
  pentes_raides: {
    id: "pentes_raides",
    name: "Pentes Raides",
    icon: "📐",
    description: "Seul le D+ sur pentes >15% compte",
    fullDescription: "Seul le dénivelé réalisé sur des segments avec une pente >15% est comptabilisé.",
    isSpecial: true,
    implemented: true,
    requiresStream: true, // Nécessite les streams GPS
    parameters: { 
      minGradient: 15 // Pente minimale en %
    }
  },
  hors_bitume: {
    id: "hors_bitume",
    name: "Hors Bitume",
    icon: "🌲",
    description: "Seul le D+ hors route compte",
    fullDescription: "Seul le dénivelé réalisé en dehors des routes goudronnées est comptabilisé.",
    isSpecial: true,
    implemented: true,
    requiresStream: true, // Nécessite les streams GPS pour analyse
    parameters: {}
  },
  double_weekend: {
    id: "double_weekend",
    name: "Double Weekend",
    icon: "📅",
    description: "D+ doublé samedi et dimanche",
    fullDescription: "Le dénivelé réalisé les samedis et dimanches est doublé.",
    isSpecial: true,
    implemented: true,
    requiresStream: false,
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
// FONCTIONS UTILITAIRES DE CALCUL DE DATES
// ============================================
export function createDateUtils(config) {
  const { yearStartDate, yearEndDate, roundDurationDays, eliminationsPerRound, participantsCount } = config;
  
  const getRoundsPerSeason = () => Math.ceil((participantsCount - 1) / eliminationsPerRound);
  const getSeasonDurationDays = () => getRoundsPerSeason() * roundDurationDays;
  const getTotalSeasons = () => Math.floor(365 / getSeasonDurationDays());
  
  const getSeasonNumber = (date) => {
    const start = new Date(yearStartDate);
    const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
    return Math.max(1, Math.floor(days / getSeasonDurationDays()) + 1);
  };
  
  const getSeasonDates = (seasonNumber) => {
    const yearStart = new Date(yearStartDate);
    const duration = getSeasonDurationDays();
    const start = new Date(yearStart);
    start.setDate(start.getDate() + (seasonNumber - 1) * duration);
    const end = new Date(start);
    end.setDate(end.getDate() + duration - 1);
    const yearEnd = new Date(yearEndDate);
    if (end > yearEnd) end.setTime(yearEnd.getTime());
    return { start, end, duration };
  };
  
  const getGlobalRoundNumber = (date) => {
    const start = new Date(yearStartDate);
    const days = Math.floor((date - start) / (1000 * 60 * 60 * 24));
    return Math.max(1, Math.floor(days / roundDurationDays) + 1);
  };
  
  const getRoundInSeason = (date) => {
    const global = getGlobalRoundNumber(date);
    const perSeason = getRoundsPerSeason();
    return ((global - 1) % perSeason) + 1;
  };
  
  const getRoundDates = (globalRoundNumber) => {
    const yearStart = new Date(yearStartDate);
    const start = new Date(yearStart);
    start.setDate(start.getDate() + (globalRoundNumber - 1) * roundDurationDays);
    const end = new Date(start);
    end.setDate(end.getDate() + roundDurationDays - 1);
    return { start, end, duration: roundDurationDays };
  };
  
  const isFinaleRound = (roundInSeason) => {
    const eliminated = (roundInSeason - 1) * eliminationsPerRound;
    return participantsCount - eliminated <= 2;
  };
  
  const isLastDayOfRound = (date, globalRoundNumber) => {
    const { end } = getRoundDates(globalRoundNumber);
    const d = new Date(date);
    return d.toDateString() === end.toDateString();
  };
  
  return {
    getRoundsPerSeason,
    getSeasonDurationDays,
    getTotalSeasons,
    getSeasonNumber,
    getSeasonDates,
    getGlobalRoundNumber,
    getRoundInSeason,
    getRoundDates,
    isFinaleRound,
    isLastDayOfRound
  };
}

// ============================================
// GÉNÉRATION DU PLANNING DES ROUNDS SPÉCIAUX
// ============================================
export function generateRoundsSchedule(config) {
  const schedule = [];
  const specialRules = Object.values(ROUND_RULES).filter(r => r.isSpecial && r.implemented !== false);
  const frequency = config.specialRuleFrequency || 4;
  const roundsPerSeason = Math.ceil((config.participantsCount - 1) / config.eliminationsPerRound);
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

// ============================================
// FONCTIONS D'AFFICHAGE DES BONUS/JOKERS
// ============================================

/**
 * Génère le HTML pour afficher les détails de dénivelé avec bonus
 * @param {Object} params - Paramètres d'affichage
 * @param {number} params.baseElevation - D+ de base
 * @param {number} params.totalElevation - D+ total après bonus
 * @param {Object} params.bonuses - Détails des bonus actifs
 * @returns {string} HTML formaté
 */
export function formatElevationWithBonuses(params) {
  const { baseElevation, totalElevation, bonuses = {} } = params;
  
  let html = `${Math.round(totalElevation).toLocaleString('fr-FR')} m`;
  const details = [];
  
  // Multiplicateur (x2)
  if (bonuses.multiplier) {
    const multipliedAmount = bonuses.multiplier.amount || 0;
    details.push(`<span class="bonus-detail multiplier" title="Bonus Multiplicateur">dont ${Math.round(multipliedAmount).toLocaleString('fr-FR')} ×2</span>`);
  }
  
  // Duel gagné (D+ volé)
  if (bonuses.duelWon) {
    const stolen = bonuses.duelWon.amount || 0;
    const from = bonuses.duelWon.from || 'adversaire';
    details.push(`<span class="bonus-detail duel-won" title="Duel gagné">dont ${Math.round(stolen).toLocaleString('fr-FR')} volés à ${from}</span>`);
  }
  
  // Duel perdu (D+ volé)
  if (bonuses.duelLost) {
    const stolen = bonuses.duelLost.amount || 0;
    const by = bonuses.duelLost.by || 'adversaire';
    details.push(`<span class="bonus-detail duel-lost" title="Duel perdu">dont ${Math.round(stolen).toLocaleString('fr-FR')} volés par ${by}</span>`);
  }
  
  // Sabotage subi
  if (bonuses.sabotaged) {
    const amount = bonuses.sabotaged.amount || 250;
    const by = bonuses.sabotaged.by || 'adversaire';
    details.push(`<span class="bonus-detail sabotage" title="Sabotage subi">dont ${Math.round(amount).toLocaleString('fr-FR')} sabotés par ${by}</span>`);
  }
  
  // Règle spéciale du round (double weekend, combinado, etc.)
  if (bonuses.roundRule) {
    const amount = bonuses.roundRule.amount || 0;
    const rule = bonuses.roundRule.name || 'Règle spéciale';
    details.push(`<span class="bonus-detail round-rule" title="${rule}">dont ${Math.round(amount).toLocaleString('fr-FR')} ×2 (${rule})</span>`);
  }
  
  if (details.length > 0) {
    html += `<div class="elevation-bonuses">(${details.join(' • ')})</div>`;
  }
  
  return html;
}

/**
 * Génère les icônes de duel pour le tableau de classement
 * @param {Object} duel - Information du duel
 * @returns {string} HTML des icônes
 */
export function renderDuelIcons(duel) {
  if (!duel) return '';
  
  const tooltip = `Duel: ${duel.challenger} vs ${duel.target}\nFormat: ${duel.criteriaName}`;
  
  return `
    <span class="duel-icon" title="${tooltip}">
      ⚔️
      <span class="duel-tooltip">
        <strong>Duel en cours</strong><br>
        ${duel.challenger} défie ${duel.target}<br>
        <em>${duel.criteriaName}</em>
      </span>
    </span>
  `;
}

// ============================================
// CALCULS D'ANALYSE GPS (PENTES, SURFACE)
// ============================================

/**
 * Calcule le dénivelé sur les segments avec pente > seuil
 * @param {Object} streams - Streams Strava (altitude, distance)
 * @param {number} minGradient - Pente minimale en %
 * @returns {Object} { totalSteepElevation, steepSegments }
 */
export function calculateSteepElevation(streams, minGradient = 15) {
  if (!streams?.altitude?.data || !streams?.distance?.data) {
    return { totalSteepElevation: 0, steepSegments: [] };
  }
  
  const altitude = streams.altitude.data;
  const distance = streams.distance.data;
  
  let totalSteepElevation = 0;
  const steepSegments = [];
  let currentSegment = null;
  
  for (let i = 1; i < altitude.length; i++) {
    const elevGain = altitude[i] - altitude[i - 1];
    const distDelta = distance[i] - distance[i - 1];
    
    if (distDelta <= 0) continue;
    
    const gradient = (elevGain / distDelta) * 100;
    
    if (gradient >= minGradient && elevGain > 0) {
      totalSteepElevation += elevGain;
      
      if (!currentSegment) {
        currentSegment = {
          startIndex: i - 1,
          startDistance: distance[i - 1],
          startAltitude: altitude[i - 1],
          elevation: 0
        };
      }
      currentSegment.elevation += elevGain;
      currentSegment.endIndex = i;
      currentSegment.endDistance = distance[i];
      currentSegment.endAltitude = altitude[i];
    } else if (currentSegment) {
      steepSegments.push(currentSegment);
      currentSegment = null;
    }
  }
  
  if (currentSegment) {
    steepSegments.push(currentSegment);
  }
  
  return { totalSteepElevation, steepSegments };
}

/**
 * Calcule le dénivelé hors bitume (nécessite polyline + API externe ou heuristique)
 * Version simplifiée basée sur le type de sport
 * @param {Object} activity - Activité Strava
 * @param {Object} streams - Streams GPS
 * @returns {Object} { offRoadElevation, offRoadSegments }
 */
export function calculateOffRoadElevation(activity, streams) {
  // Pour une implémentation complète, il faudrait croiser avec OpenStreetMap
  // Version simplifiée : Trail Run et Hike = 100% hors bitume, autres = heuristique
  
  const offRoadRatio = {
    'TrailRun': 1.0,
    'Hike': 1.0,
    'MountainBikeRide': 0.8,
    'GravelRide': 0.6,
    'Run': 0.2,
    'Ride': 0.1
  };
  
  const ratio = offRoadRatio[activity.sport_type] || 0.5;
  const offRoadElevation = (activity.total_elevation_gain || 0) * ratio;
  
  return { 
    offRoadElevation,
    offRoadRatio: ratio,
    isEstimated: true // Indique que c'est une estimation
  };
}

// ============================================
// CSS POUR LES BONUS (à ajouter au style.css)
// ============================================
export const BONUS_CSS = `
/* Styles pour l'affichage des bonus */
.elevation-bonuses {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 4px;
}

.bonus-detail {
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 4px;
  font-size: 0.7rem;
}

.bonus-detail.multiplier {
  background: rgba(168, 85, 247, 0.2);
  color: #a855f7;
}

.bonus-detail.duel-won {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.bonus-detail.duel-lost {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.bonus-detail.sabotage {
  background: rgba(239, 68, 68, 0.2);
  color: #f97316;
}

.bonus-detail.round-rule {
  background: rgba(34, 211, 238, 0.2);
  color: #22d3ee;
}

/* Icône de duel */
.duel-icon {
  position: relative;
  cursor: help;
  font-size: 1.2em;
}

.duel-tooltip {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 8px 12px;
  white-space: nowrap;
  font-size: 0.8rem;
  z-index: 100;
}

.duel-icon:hover .duel-tooltip {
  display: block;
}

/* Indicateur de duel entre deux lignes */
.duel-connector {
  position: absolute;
  left: -20px;
  width: 16px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.duel-connector::before {
  content: '⚔️';
  font-size: 12px;
}
`;
