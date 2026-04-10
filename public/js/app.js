/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE
 * ============================================
 * Logique métier uniquement :
 * - Chargement des données
 * - Calculs (classements, stats, éliminations)
 * - Orchestration des modules
 *
 * PAS DE HTML NI CSS ICI
 */

import {
  CHALLENGE_CONFIG, PARTICIPANTS, ROUND_RULES, JOKER_TYPES, BONUS_TYPES,
  SEASON_TYPES, SEASON_PLANNING, TEAM_COLORS,
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getGlobalRoundNumber, isFinaleRound, isValidSport,
  getRoundsPerSeason, getRoundsForSeason, getSeasonStartRound, getSeasonType,
  getMainChallengePoints, getEliminatedChallengePoints,
  getAthleteColor, getAthleteInitials, loadParticipants,
  getEligibleParticipants, getLateRegistrations, wasRegisteredBeforeStart,
  formBalancedTeams, loadSpecialRulesOverrides, getSpecialRuleForRound
} from './config.js';

import {
  initializeJokersState, useJoker as jokerUse,
  addJoker, removeJoker, applyJokerEffects,
  getJokerStock, getActiveJokersForRound, getPendingJokersForNextRound, getJokerStatusForRound
} from './jokers.js';

import {
  formatElevation, formatPosition,
  renderCombinedBanner, renderRanking,
  renderJokersGuide, renderArsenal, showNotification,
  showContextMenu, hideContextMenu, showTargetSelectionModal
} from './ui.js';

import { getCurrentDate, setSimulatedDate, initDemoMode } from './demo.js';

// ============================================
// ÉTAT GLOBAL
// ============================================
let allActivities = [];
let currentRoundNumber = 1;
let currentSeasonNumber = 1;
let seasonData = null;
let yearlyStandingsCache = null;
let isAdminMode = false;
let frozenResultsCache = null; // Cache des résultats figés
let bonusesCache = []; // Cache des bonus éphémères

// ============================================
// CHARGEMENT DES RÉSULTATS FIGÉS
// ============================================
async function loadFrozenResults() {
  try {
    const response = await fetch('/api/frozen-results');
    if (response.ok) {
      frozenResultsCache = await response.json();
    }
  } catch (error) {
    console.warn('⚠️ Impossible de charger les résultats figés:', error);
    frozenResultsCache = { rounds: {} };
  }
}

/**
 * Charge tous les bonus éphémères depuis l'API
 */
async function loadBonuses() {
  try {
    const response = await fetch('/api/bonuses/all');
    if (response.ok) {
      bonusesCache = await response.json();
    }
  } catch (error) {
    console.warn('⚠️ Impossible de charger les bonus:', error);
    bonusesCache = [];
  }
}

/**
 * Récupère les bonus utilisés pour un round donné
 */
function getBonusesUsedInRound(roundNumber) {
  return bonusesCache.filter(b => b.used_in_round === roundNumber && b.status === 'used');
}

/**
 * Génère la description d'un bonus pour l'historique
 */
function getBonusHistoryDescription(bonus) {
  const bonusType = BONUS_TYPES?.[bonus.bonus_id];
  const icon = bonusType?.icon || '🎁';
  const athleteName = bonus.athlete_name || 'Joueur';
  const targetName = bonus.target_athlete_name;
  const effectResult = bonus.effect_result;

  // Helper pour formater avec "m D+"
  const fmtElev = (val) => `${Math.round(val).toLocaleString('fr-FR')} m D+`;

  switch (bonus.bonus_id) {
    case 'embuscade':
      const stolenAmount = effectResult?.stolenElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a tendu une embuscade à ${targetName} (${stolenAmount > 0 ? '-' + fmtElev(stolenAmount) : 'aucune activité volée'})`;
    case 'ravitaillement':
      const bonusAmount = effectResult?.bonusElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a ravitaillé ${targetName || 'un joueur'} (+${fmtElev(bonusAmount)})`;
    case 'duel':
      const duelResult = effectResult?.won ? 'gagné' : 'perdu';
      const duelAmount = effectResult?.amount || 0;
      return `${icon} ${athleteName} a défié ${targetName} en duel (${duelResult}${duelAmount > 0 ? ', ' + fmtElev(duelAmount) + ' volés' : ''})`;
    case 'brouillard':
      return `${icon} ${athleteName} a activé le brouillard (D+ masqué)`;
    case 'marquage':
      const markPenalty = effectResult?.penaltyAmount || 0;
      return `${icon} ${athleteName} a marqué ${targetName} (${markPenalty > 0 ? '-' + fmtElev(markPenalty) : '-20% D+'})`;
    case 'trap':
      const trapAmount = effectResult?.stolenElevation || effectResult?.amount || 0;
      return `${icon} ${athleteName} a piégé ${targetName} (${trapAmount > 0 ? '-' + fmtElev(trapAmount) : 'piège déclenché'})`;
    case 'second_souffle':
      const savedFrom = effectResult?.savedFromElimination ? 'sauvé de l\'élimination' : 'protection active';
      return `${icon} ${athleteName} a utilisé son second souffle (${savedFrom})`;
    case 'kamikaze':
      const kamikazeAmount = effectResult?.targetPenalty || effectResult?.amount || 0;
      return `${icon} ${athleteName} a lancé une attaque kamikaze sur ${targetName} (-${fmtElev(kamikazeAmount)} chacun)`;
    case 'malediction':
      const curseAmount = effectResult?.stolenThisRound || 0;
      return `${icon} ${athleteName} a maudit ${targetName} (${curseAmount > 0 ? '-' + fmtElev(curseAmount) + ' ce round' : 'malédiction active'})`;
    default:
      return `${icon} ${athleteName} a utilisé ${bonusType?.name || bonus.bonus_id}${targetName ? ' sur ' + targetName : ''}`;
  }
}

/**
 * Calcule les effets des bonus éphémères pour un joueur ACTIF (challenge principal)
 * Ces effets s'appliquent sur le D+ du round en cours
 * @param {string} athleteId - ID du joueur actif
 * @param {number} roundNumber - Numéro du round
 * @returns {Object} Effets: { gained: number, lost: number, details: [] }
 */
function getEphemeralBonusEffectsForActiveAthlete(athleteId, roundNumber) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);

  const roundBonuses = getBonusesUsedInRound(roundNumber);

  for (const bonus of roundBonuses) {
    const result = bonus.effect_result;
    if (!result) continue;

    // Embuscade - le joueur actif (cible) PERD du D+ dans le challenge principal
    if (bonus.bonus_id === 'embuscade') {
      const amount = result.stolenElevation || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.lost += amount;
        effects.details.push({ type: 'embuscade_victim', amount, by: bonus.athlete_name, icon: '🏹' });
      }
    }

    // Ravitaillement - le joueur actif (cible) GAGNE du D+ dans le challenge principal
    if (bonus.bonus_id === 'ravitaillement') {
      const amount = result.bonusElevation || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.gained += amount;
        effects.details.push({ type: 'ravitaillement', amount, from: bonus.athlete_name, icon: '🍖' });
      }
    }

    // Note: marquage, malédiction, kamikaze sont des bonus entre éliminés ou ciblent des éliminés
    // Ils ne s'appliquent pas aux joueurs actifs dans le challenge principal
  }

  return effects;
}

/**
 * Calcule les effets des bonus éphémères pour un joueur ÉLIMINÉ (challenge des éliminés)
 * Ces effets s'appliquent sur le D+ cumulé depuis l'élimination
 * @param {string} athleteId - ID du joueur éliminé
 * @param {number} roundNumber - Numéro du round
 * @returns {Object} Effets: { gained: number, lost: number, details: [] }
 */
function getEphemeralBonusEffectsForEliminatedAthlete(athleteId, roundNumber) {
  const effects = { gained: 0, lost: 0, details: [] };
  const normalizedId = String(athleteId);

  const roundBonuses = getBonusesUsedInRound(roundNumber);

  for (const bonus of roundBonuses) {
    const result = bonus.effect_result;
    if (!result) continue;

    // Embuscade - l'éliminé (attaquant) GAGNE du D+ dans le challenge des éliminés
    if (bonus.bonus_id === 'embuscade') {
      const amount = result.stolenElevation || 0;
      if (amount > 0 && String(bonus.athlete_id) === normalizedId) {
        effects.gained += amount;
        effects.details.push({ type: 'embuscade_gain', amount, from: bonus.target_athlete_name, icon: '🏹' });
      }
    }

    // Ravitaillement - l'éliminé donne mais ne perd rien (c'est une copie)
    // Pas d'effet négatif pour l'éliminé

    // Marquage - pénalité 20% sur un autre éliminé
    if (bonus.bonus_id === 'marquage') {
      const amount = result.penaltyAmount || 0;
      if (amount > 0 && String(bonus.target_athlete_id) === normalizedId) {
        effects.lost += amount;
        effects.details.push({ type: 'marquage', amount, by: bonus.athlete_name, icon: '🎯' });
      }
    }

    // Malédiction - vol 10% par round entre éliminés
    if (bonus.bonus_id === 'malediction') {
      const amount = result.stolenThisRound || 0;
      if (amount > 0) {
        if (String(bonus.target_athlete_id) === normalizedId) {
          effects.lost += amount;
          effects.details.push({ type: 'malediction_victim', amount, by: bonus.athlete_name, icon: '🪬' });
        }
        if (String(bonus.athlete_id) === normalizedId) {
          effects.gained += amount;
          effects.details.push({ type: 'malediction_gain', amount, from: bonus.target_athlete_name, icon: '🪬' });
        }
      }
    }

    // Kamikaze - perte mutuelle entre éliminés
    if (bonus.bonus_id === 'kamikaze') {
      if (String(bonus.target_athlete_id) === normalizedId) {
        const amount = result.targetPenalty || 0;
        if (amount > 0) {
          effects.lost += amount;
          effects.details.push({ type: 'kamikaze_victim', amount, by: bonus.athlete_name, icon: '💣' });
        }
      }
      if (String(bonus.athlete_id) === normalizedId) {
        const amount = result.userPenalty || 0;
        if (amount > 0) {
          effects.lost += amount;
          effects.details.push({ type: 'kamikaze_self', amount, icon: '💣' });
        }
      }
    }
  }

  return effects;
}

/**
 * Récupère les bonus éphémères actifs pour un joueur (pas encore utilisés ou en cours)
 */
function getFrozenRound(globalRoundNumber) {
  if (!frozenResultsCache?.rounds) return null;
  return frozenResultsCache.rounds[String(globalRoundNumber)] || null;
}

/**
 * Récupère l'ID du rescapé du round précédent
 * Le rescapé est l'avant-avant-dernier du classement (juste au-dessus des 2 éliminés)
 */
function getRescapeFromPreviousRound(currentRoundNumber) {
  const previousRound = currentRoundNumber - 1;
  if (previousRound < 1) return null;

  const frozenRound = getFrozenRound(previousRound);
  if (!frozenRound || !frozenRound.ranking || frozenRound.ranking.length < 4) {
    return null;
  }

  // L'avant-avant-dernier = position ranking.length - 2 (0-indexed: length - 3)
  // Exemple: 10 joueurs -> positions 0-9, éliminés = 8,9, rescapé = 7
  const rescapeIndex = frozenRound.ranking.length - 3;
  const rescapeEntry = frozenRound.ranking[rescapeIndex];

  if (rescapeEntry) {
    return String(rescapeEntry.id);
  }

  return null;
}

/**
 * Calcule les points rescapé pour tous les joueurs d'une saison.
 * Règles :
 *   - Rescapé = avant-avant-dernier du classement (juste au-dessus des 2 éliminés)
 *   - 1ère fois consécutive : jeton (0 pts)
 *   - 2ème fois consécutive : +2 pts
 *   - 3ème+ consécutive : +2 pts chaque fois
 *   - Si le joueur quitte la position rescapé : compteur reset
 *
 * @param {number} seasonNumber
 * @returns {Object} { [athleteId]: { totalPoints, streaks: [{round, consecutive, points}] } }
 */
function calculateRescapePointsForSeason(seasonNumber) {
  const result = {};
  PARTICIPANTS.forEach(p => {
    result[p.id] = { totalPoints: 0, streaks: [] };
  });

  if (!frozenResultsCache?.rounds) return result;

  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  // Tracker le compteur consécutif par joueur
  const consecutiveCount = {};
  PARTICIPANTS.forEach(p => { consecutiveCount[p.id] = 0; });

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const round = frozenResultsCache.rounds[String(roundNum)];
    if (!round?.frozen || !round.ranking || round.ranking.length < 4) continue;

    const eliminations = round.eliminations || [];
    if (eliminations.length === 0) continue;

    // Trouver le rescapé de ce round
    const eliminatedIds = new Set(eliminations.map(e => String(e.id)));
    const roundInSeason = ((roundNum - 1) % roundsPerSeason) + 1;
    const isFinale = roundInSeason === roundsPerSeason;

    // Pas de rescapé en finale
    if (isFinale) {
      PARTICIPANTS.forEach(p => { consecutiveCount[p.id] = 0; });
      continue;
    }

    // Le rescapé = dernier survivant du classement (dernier non-éliminé)
    const survivors = round.ranking.filter(e => !eliminatedIds.has(String(e.id)));
    const rescapeEntry = survivors.length > 0 ? survivors[survivors.length - 1] : null;
    const rescapeId = rescapeEntry ? String(rescapeEntry.id) : null;

    // Mettre à jour les compteurs
    PARTICIPANTS.forEach(p => {
      const pid = p.id;
      if (eliminatedIds.has(pid)) {
        // Éliminé → reset
        consecutiveCount[pid] = 0;
        return;
      }

      if (pid === rescapeId) {
        consecutiveCount[pid]++;
        const streak = consecutiveCount[pid];
        let pts = 0;
        if (streak >= 2) {
          pts = 2;
        }
        result[pid].streaks.push({
          round: roundNum,
          roundInSeason,
          consecutive: streak,
          points: pts
        });
        result[pid].totalPoints += pts;
      } else {
        // Pas rescapé ce round → reset
        consecutiveCount[pid] = 0;
      }
    });
  }

  return result;
}

/**
 * Récupère les infos rescapé d'un round spécifique (pour l'affichage historique)
 */
function getRescapeInfoForRound(globalRoundNumber) {
  const roundsPerSeason = getRoundsPerSeason();
  const seasonNumber = Math.ceil(globalRoundNumber / roundsPerSeason);
  const rescapeData = calculateRescapePointsForSeason(seasonNumber);

  for (const [athleteId, data] of Object.entries(rescapeData)) {
    const streak = data.streaks.find(s => s.round === globalRoundNumber);
    if (streak) {
      return {
        athleteId,
        consecutive: streak.consecutive,
        points: streak.points
      };
    }
  }
  return null;
}

// ============================================
// ÉCRAN D'ATTENTE AVANT LE CHALLENGE
// ============================================

function renderWaitingScreen(startDate) {
  const now = getCurrentDate();
  const daysUntilStart = Math.ceil((startDate - now) / (1000 * 60 * 60 * 24));
  const formattedDate = startDate.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  // Masquer le loader
  const loadingScreen = document.getElementById('loadingScreen');
  if (loadingScreen) {
    loadingScreen.style.display = 'none';
  }

  // Générer la liste des participants
  const participantsListHtml = PARTICIPANTS.map(p => `
    <div class="waiting-participant">
      <div class="participant-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(p.id)},${getAthleteColor(p.id)}88)">
        ${getAthleteInitials(p.id)}
      </div>
      <span class="participant-name-small">${p.name}</span>
    </div>
  `).join('');

  // Afficher l'écran d'attente dans les conteneurs principaux
  const banner = document.getElementById('seasonBanner');
  const ranking = document.getElementById('rankingContainer');
  const eliminated = document.getElementById('eliminatedChallengeContainer');
  const standings = document.getElementById('finalStandingsContainer');
  const participantsContainer = document.getElementById('participantsContainer');

  const waitingHtml = `
    <div class="waiting-screen">
      <div class="waiting-icon">◭️</div>
      <h2 class="waiting-title">Challenge Versant ${CHALLENGE_CONFIG.dataYear}</h2>
      <div class="waiting-countdown">
        <span class="countdown-number">${daysUntilStart}</span>
        <span class="countdown-label">jour${daysUntilStart > 1 ? 's' : ''} avant le départ</span>
      </div>
      <p class="waiting-date">Début le <strong>${formattedDate}</strong></p>
      <p class="waiting-info">Préparez-vous ! Le 1ᵉʳ round débutera à cette date.</p>
      <div class="waiting-participants">
        <span class="participants-count">${PARTICIPANTS.length}</span> participants inscrits
      </div>
    </div>
  `;

  const participantsGridHtml = `
    <div class="waiting-participants-section">
      <h3 class="waiting-section-title"> Participants inscrits</h3>
      <div class="waiting-participants-grid">
        ${participantsListHtml}
      </div>
      <p class="waiting-inscription-cta">
        <a href="inscription.html" class="btn-inscription">Pas encore inscrit ? Rejoignez le challenge !</a>
      </p>
    </div>
  `;

  if (banner) {
    banner.innerHTML = `
      <div class="banner-waiting">
        <span class="banner-icon"></span>
        <span class="banner-text">Challenge ${CHALLENGE_CONFIG.dataYear} • Début le ${startDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span>
        <span class="banner-countdown">${daysUntilStart}j</span>
      </div>
    `;
  }

  if (ranking) {
    ranking.innerHTML = waitingHtml;
  }

  if (eliminated) {
    eliminated.innerHTML = participantsGridHtml;
  }

  if (standings) {
    standings.innerHTML = '<div class="empty-state"><p>Le classement sera disponible après le début du challenge</p></div>';
  }

  // Si la section participants existe, y afficher aussi la grille
  if (participantsContainer) {
    participantsContainer.innerHTML = participantsGridHtml;
  }

}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================

async function loadActivities() {
  // Déterminer le mode (démo vs production)
  const isDemo = CHALLENGE_CONFIG.isDemo || window.location.pathname.includes('demo');
  const dataFile = '/data/all_activities_2025.json';
  const leagueId = CHALLENGE_CONFIG.leagueId;


  // En mode DEMO, charger directement le fichier local 2025
  if (isDemo) {
    try {
      const localResponse = await fetch(dataFile);
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);

        if (allActivities.length > 0) {
          const dates = allActivities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
          const uniqueDates = [...new Set(dates)].sort().reverse();
        }
        return allActivities;
      } else {
        console.error(`❌ Fichier démo introuvable: ${dataFile}`);
      }
    } catch (e) {
      console.error('❌ Erreur chargement fichier démo:', e);
    }
    return allActivities;
  }

  // Mode PRODUCTION: charger depuis l'API
  try {
    const response = await fetch(`/api/activities/${leagueId}`);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    allActivities = parseActivitiesData(data);

    // Debug: afficher les dates des activités
    if (allActivities.length > 0) {
      const dates = allActivities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
      const uniqueDates = [...new Set(dates)].sort().reverse();

      // Vérifier les activités du round actuel
      const today = new Date();
      const roundStart = new Date(CHALLENGE_CONFIG.yearStartDate);

      const recentActivities = allActivities.filter(a => {
        const d = new Date(a.start_date);
        return d >= roundStart;
      });
    } else {
      console.warn('⚠️ Aucune activité dans la réponse API');
    }

    return allActivities;
  } catch (error) {
    console.warn('⚠️ Erreur chargement API:', error.message);
    console.warn('⚠️ Tentative fichier local: /data/classement.json');
    try {
      const localResponse = await fetch('/data/classement.json');
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);
        console.warn('⚠️ ATTENTION: Données locales utilisées, pas l\'API!');
      }
    } catch (e) {
      console.error('❌ Impossible de charger les données:', e);
    }
    return allActivities;
  }
}

/**
 * Parse différents formats de données d'activités
 * Supporte: tableau direct, {activities: []}, {ranking: [{activities: []}]}
 */
function parseActivitiesData(data) {
  // Si c'est déjà un tableau
  if (Array.isArray(data)) {
    return data.filter(a => !a.sport_type || isValidSport(a.sport_type));
  }

  // Si c'est {activities: [...]}
  if (data.activities && Array.isArray(data.activities)) {
    return data.activities.filter(a => !a.sport_type || isValidSport(a.sport_type));
  }

  // Si c'est {ranking: [{id, activities: [...]}]} (format classement.json)
  if (data.ranking && Array.isArray(data.ranking)) {
    const activities = [];
    for (const participant of data.ranking) {
      if (participant.activities && Array.isArray(participant.activities)) {
        for (const activity of participant.activities) {
          activities.push({
            ...activity,
            // Normaliser les champs pour compatibilité
            start_date: activity.date || activity.start_date,
            total_elevation_gain: activity.elevation || activity.total_elevation_gain,
            distance: activity.distance,
            // Si pas de sport_type, assumer que c'est valide (données pré-filtrées)
            sport_type: activity.sport_type || 'Run',
            // Ajouter les infos athlète pour le filtrage
            athlete: {
              id: participant.id,
              firstname: participant.name?.split(' ')[0] || '',
              lastname: participant.name?.split(' ').slice(1).join(' ') || ''
            }
          });
        }
      }
    }
    // Pour les données classement.json, pas besoin de re-filtrer par sport
    return activities;
  }

  console.warn('⚠️ Format de données non reconnu');
  return [];
}

// ============================================
// FILTRAGE DES ACTIVITÉS
// ============================================

function filterByPeriod(activities, startDate, endDate) {
  const start = new Date(startDate).setHours(0, 0, 0, 0);
  const end = new Date(endDate).setHours(23, 59, 59, 999);
  return activities.filter(a => {
    // Ignorer les activités exclues par l'admin
    if (a.excluded) return false;
    const date = new Date(a.start_date).getTime();
    return date >= start && date <= end;
  });
}

function filterByParticipant(activities, participantId) {
  const pid = String(participantId);
  return activities.filter(a => {
    // Supporter les deux formats: athlete.id (sync) et athlete_id (ancien webhook)
    const athleteId = a.athlete?.id || a.athlete_id;
    return String(athleteId) === pid;
  });
}

// ============================================
// CALCULS STATISTIQUES
// ============================================

function calculateStats(activities) {
  return {
    elevation: activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0),
    distance: activities.reduce((sum, a) => sum + (a.distance || 0), 0),
    activities: activities.length,
    movingTime: activities.reduce((sum, a) => sum + (a.moving_time || 0), 0)
  };
}

function calculateRanking(activities, activeParticipants) {
  const participantsList = activeParticipants.length > 0 ? activeParticipants : PARTICIPANTS;

  return participantsList
    .map(participant => {
      const pActivities = filterByParticipant(activities, participant.id);
      const stats = calculateStats(pActivities);
      return {
        participant,
        totalElevation: stats.elevation,
        totalDistance: stats.distance,
        activityCount: stats.activities,
        activities: pActivities
      };
    })
    .sort((a, b) => b.totalElevation - a.totalElevation)
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}

/**
 * Applique la règle Handicap sur le ranking du round
 * - Top 10 du classement général : malus dégressif sur le D+
 * - 5 derniers du classement général : bonus de +10%
 * Le ranking est re-trié après application
 */
function applyHandicapRule(ranking, yearlyStandings) {
  const rule = ROUND_RULES.handicap;
  if (!rule?.parameters) return ranking;

  const { malusPerPosition, bonusLastCount, bonusLastPercent } = rule.parameters;

  // Créer un map rang classement général → participant
  const generalRankMap = {};
  const totalParticipants = yearlyStandings.length;
  yearlyStandings.forEach(e => {
    generalRankMap[String(e.participant.id)] = e.rank;
  });

  const adjusted = ranking.map(entry => {
    const pid = String(entry.participant.id);
    const generalRank = generalRankMap[pid];
    const rawElevation = entry.totalElevation;
    let adjustmentPercent = 0;
    let adjustmentLabel = null;

    if (generalRank && malusPerPosition[generalRank]) {
      // Malus pour le top 10
      adjustmentPercent = -malusPerPosition[generalRank];
      adjustmentLabel = `${adjustmentPercent}% (${generalRank}${generalRank === 1 ? 'ᵉʳ' : 'ᵉ'} au général)`;
    } else if (generalRank && totalParticipants - generalRank < bonusLastCount) {
      // Bonus pour les 5 derniers
      adjustmentPercent = bonusLastPercent;
      adjustmentLabel = `+${adjustmentPercent}% (${generalRank}${generalRank === 1 ? 'ᵉʳ' : 'ᵉ'} au général)`;
    }

    const adjustedElevation = adjustmentPercent !== 0
      ? Math.round(rawElevation * (1 + adjustmentPercent / 100))
      : rawElevation;

    return {
      ...entry,
      rawElevation,
      adjustmentPercent,
      adjustmentLabel,
      totalElevation: adjustedElevation
    };
  });

  // Re-trier par D+ ajusté
  adjusted.sort((a, b) => b.totalElevation - a.totalElevation);
  adjusted.forEach((e, i) => { e.position = i + 1; });

  return adjusted;
}

// ============================================
// SIMULATION DES ÉLIMINATIONS
// ============================================

/**
 * Simulation pour les saisons en mode ÉQUIPE.
 * - Équipes de 3 (ou 2 si N non divisible par 3)
 * - L'équipe avec le moins de D+ cumulé est éliminée (tous les membres)
 * - Points attribués selon le classement interne de l'équipe éliminée
 * - Retirage des équipes à chaque round
 */
function simulateTeamSeasonEliminations(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);
  const seasonStartRound = getSeasonStartRound(seasonNumber);
  const maxRounds = getRoundsForSeason(seasonNumber);

  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Calculer les points du classement général pour l'équilibrage
  const yearlyStandings = yearlyStandingsCache || [];
  const pointsMap = {};
  yearlyStandings.forEach(e => { pointsMap[e.participant.id] = e.totalPoints || 0; });
  PARTICIPANTS.forEach(p => { if (!(p.id in pointsMap)) pointsMap[p.id] = 0; });

  for (let roundInSeason = 1; roundInSeason <= maxRounds; roundInSeason++) {
    if (active.length <= 1) break;

    const globalRound = seasonStartRound + roundInSeason - 1;
    const roundDates = getRoundDates(globalRound);

    // Round pas encore commencé
    if (currentDate < roundDates.start) break;

    // Round en cours (pas terminé)
    if (currentDate <= roundDates.end) {
      // Former les équipes pour l'affichage du round en cours
      const teams = formBalancedTeams(active, pointsMap, globalRound);

      // Calculer le D+ par athlète pour le round en cours
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
      const teamsWithElevation = teams.map(team => {
        const membersWithElev = team.members.map(m => {
          const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
          const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
          return { ...m, elevation: elev };
        }).sort((a, b) => b.elevation - a.elevation);

        return {
          ...team,
          members: membersWithElev,
          totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
        };
      }).sort((a, b) => b.totalElevation - a.totalElevation);

      roundResults.push({
        round: roundInSeason,
        status: 'active',
        active: [...active],
        teams: teamsWithElevation,
        eliminated: []
      });
      break;
    }

    // ============================================
    // ROUND TERMINÉ — vérifier si figé
    // ============================================
    const frozenRound = getFrozenRound(globalRound);

    if (frozenRound && frozenRound.frozen) {
      // Utiliser les résultats figés
      frozenRound.eliminations.forEach(elim => {
        const participant = PARTICIPANTS.find(p => String(p.id) === String(elim.id));
        if (participant) {
          eliminated.push({
            ...participant,
            eliminatedRound: roundInSeason,
            eliminatedSeason: seasonNumber,
            zeroElimination: elim.reason === 'zero_elevation'
          });
          active = active.filter(a => String(a.id) !== String(elim.id));
        }
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: frozenRound.ranking,
        teams: frozenRound.teams || null,
        eliminated: frozenRound.eliminations.map(e => e.id),
        frozen: true
      });
    } else {
      // CALCULER — round terminé mais pas encore figé
      const teams = formBalancedTeams(active, pointsMap, globalRound);
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);

      // Calculer D+ par athlète et par équipe
      const teamsWithElevation = teams.map(team => {
        const membersWithElev = team.members.map(m => {
          const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
          const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
          return { ...m, elevation: elev };
        }).sort((a, b) => b.elevation - a.elevation);

        return {
          ...team,
          members: membersWithElev,
          totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
        };
      }).sort((a, b) => b.totalElevation - a.totalElevation);

      // L'équipe dernière est éliminée (tous les membres)
      const lastTeam = teamsWithElevation[teamsWithElevation.length - 1];

      // Points : les membres de l'équipe éliminée sont classés par D+ individuel
      // Ils occupent les dernières positions (15ème, 14ème, 13ème pour la première élim)
      const teamMembersSorted = [...lastTeam.members].sort((a, b) => a.elevation - b.elevation);

      teamMembersSorted.forEach((member, idx) => {
        const position = active.length - idx; // 15, 14, 13...
        const mainPts = getMainChallengePoints(position);

        eliminated.push({
          ...PARTICIPANTS.find(p => p.id === member.id) || member,
          eliminatedRound: roundInSeason,
          eliminatedSeason: seasonNumber,
          zeroElimination: member.elevation === 0,
          teamElimination: true,
          mainPoints: mainPts
        });
        active = active.filter(a => a.id !== member.id);
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        teams: teamsWithElevation,
        eliminatedTeamIndex: teamsWithElevation.length - 1,
        eliminated: lastTeam.members.map(m => m.id)
      });
    }

    // Saison terminée ?
    if (active.length <= 3) {
      // Finale : les derniers joueurs restants s'affrontent individuellement
      // (ou la dernière équipe gagne)
      return {
        seasonComplete: active.length <= 1,
        winner: active.length === 1 ? active[0] : null,
        active,
        eliminated,
        roundResults,
        isTeamSeason: true,
        actualRoundsPlayed: roundInSeason
      };
    }
  }

  return {
    seasonComplete: false,
    active,
    eliminated,
    roundResults,
    isTeamSeason: true,
    actualRoundsPlayed: roundResults.length
  };
}

function simulateSeasonEliminations(activities, seasonNumber, currentDate) {
  const seasonType = getSeasonType(seasonNumber);

  // Branchement vers la logique Équipe si applicable
  if (seasonType?.isTeamBased) {
    return simulateTeamSeasonEliminations(activities, seasonNumber, currentDate);
  }

  const seasonDates = getSeasonDates(seasonNumber);

  // TOUS les participants (éligibles + tardifs) pour le calcul du nombre de rounds
  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Inscriptions tardives = éliminées d'office au Round 1 (comptent dans le quota)
  const lateRegistrations = getLateRegistrations();

  // Calculer le nombre de rounds pour cette saison
  const maxRoundsPerSeason = getRoundsForSeason(seasonNumber);
  const seasonStartRoundGlobal = getSeasonStartRound(seasonNumber);

  for (let roundInSeason = 1; roundInSeason <= maxRoundsPerSeason; roundInSeason++) {
    // VÉRIFICATION: Si plus qu'un seul joueur actif, la saison est finie
    if (active.length <= 1) {
      break;
    }

    const globalRound = seasonStartRoundGlobal + roundInSeason - 1;
    const roundDates = getRoundDates(globalRound);

    // Round pas encore commencé
    if (currentDate < roundDates.start) break;

    // Round en cours (pas encore terminé)
    if (currentDate <= roundDates.end) {
      roundResults.push({
        round: roundInSeason,
        status: 'active',
        active: [...active],
        eliminated: []
      });
      break;
    }

    // ============================================
    // VÉRIFIER SI LE ROUND EST FIGÉ
    // ============================================
    const frozenRound = getFrozenRound(globalRound);

    if (frozenRound && frozenRound.frozen) {
      // UTILISER LES RÉSULTATS FIGÉS

      // Appliquer les éliminations depuis les données figées
      frozenRound.eliminations.forEach(elim => {
        const participant = PARTICIPANTS.find(p => String(p.id) === String(elim.id));
        if (participant) {
          eliminated.push({
            ...participant,
            eliminatedRound: roundInSeason,
            eliminatedSeason: seasonNumber,
            zeroElimination: elim.reason === 'zero_elevation'
          });
          active = active.filter(a => String(a.id) !== String(elim.id));
        }
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: frozenRound.ranking,
        eliminated: frozenRound.eliminations.map(e => e.id),
        frozen: true
      });

    } else {
      // CALCULER LES RÉSULTATS (round non figé - RÈGLES SIMPLES)
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
      const ranking = calculateRanking(roundActivities, active);

      // Appliquer les effets des jokers
      const rankingWithEffects = applyJokerEffects(ranking, globalRound);

      // ============================================
      // RÈGLES D'ÉLIMINATION
      // ============================================
      // Anciennes règles (R1-R6): Éliminer les 2 derniers du classement
      // Nouvelles règles (R7+):
      // - Si ≥2 joueurs à 0 D+ → éliminer TOUS les 0 D+ (et seulement eux)
      // - Sinon → éliminer les 2 derniers
      // - Finale: Éliminer tous sauf 1
      // ============================================

      const toEliminate = [];

      // Déterminer si c'est une finale (3 joueurs ou moins restants)
      const isCurrentRoundFinale = active.length <= CHALLENGE_CONFIG.eliminationsPerRound + 1;

      // Joueurs éligibles (sans bouclier)
      const eligibleForElimination = rankingWithEffects.filter(e => !e.jokerEffects?.hasShield);

      // Joueurs à 0 D+ (éligibles uniquement)
      const zeroElevationPlayers = eligibleForElimination.filter(e => e.totalElevation === 0);

      // Appliquer les nouvelles règles seulement à partir du R7
      const useNewRules = globalRound >= 7;

      if (isCurrentRoundFinale) {
        // FINALE: éliminer tous sauf 1
        eligibleForElimination.slice(1).forEach(entry => {
          toEliminate.push({
            ...entry.participant,
            zeroElimination: entry.totalElevation === 0
          });
        });
      } else if (useNewRules && zeroElevationPlayers.length >= 2) {
        // NOUVELLE RÈGLE (R7+): Si ≥2 joueurs à 0 D+ → éliminer TOUS les 0 D+
        zeroElevationPlayers.forEach(entry => {
          toEliminate.push({
            ...entry.participant,
            zeroElimination: true
          });
        });
      } else {
        // RÈGLE NORMALE: éliminer les 2 derniers
        const eliminationsNeeded = CHALLENGE_CONFIG.eliminationsPerRound;

        // Round 1: Les inscriptions tardives sont éliminées en PREMIER (comptent dans le quota)
        if (roundInSeason === 1 && lateRegistrations.length > 0) {
          lateRegistrations.forEach(p => {
            if (toEliminate.length < eliminationsNeeded && active.find(a => a.id === p.id)) {
              toEliminate.push({
                ...p,
                zeroElimination: false,
                lateRegistration: true
              });
            }
          });
        }

        // Compléter avec les derniers du classement
        for (let i = eligibleForElimination.length - 1; i >= 0 && toEliminate.length < eliminationsNeeded; i--) {
          const entry = eligibleForElimination[i];
          // Skip si déjà dans toEliminate (inscription tardive)
          if (toEliminate.find(e => e.id === entry.participant.id)) continue;

          toEliminate.push({
            ...entry.participant,
            zeroElimination: entry.totalElevation === 0
          });
        }
      }

      toEliminate.forEach(p => {
        eliminated.push({
          ...p,
          eliminatedRound: roundInSeason,
          eliminatedSeason: seasonNumber,
          zeroElimination: p.zeroElimination || false,
          lateRegistration: p.lateRegistration || false
        });
        active = active.filter(a => a.id !== p.id);
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: rankingWithEffects,
        eliminated: toEliminate.map(p => p.id)
      });
    }

    // Vérifier si la saison est terminée (un seul joueur restant)
    if (active.length <= 1) {
      return {
        seasonComplete: true,
        winner: active[0] || null,
        active,
        eliminated,
        roundResults,
        actualRoundsPlayed: roundInSeason
      };
    }
  }

  return {
    seasonComplete: false,
    active,
    eliminated,
    roundResults,
    actualRoundsPlayed: roundResults.length
  };
}

// ============================================
// CHALLENGE DES ÉLIMINÉS
// ============================================

function calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate) {
  const ranking = [];
  const endDate = currentDate < seasonDates.end ? currentDate : seasonDates.end;
  const roundsPerSeason = getRoundsPerSeason();

  for (const p of eliminatedList) {
    // Calculer le round global à partir du round dans la saison et de la saison d'élimination
    const globalRound = (p.eliminatedSeason - 1) * roundsPerSeason + p.eliminatedRound;
    const roundDates = getRoundDates(globalRound);

    // L'éliminé peut participer dès la fin de son round d'élimination
    const eliminationDate = new Date(roundDates.end);

    // Vérifier que le round d'élimination est bien terminé
    if (currentDate < eliminationDate) continue;

    // Les activités comptent à partir du lendemain de l'élimination
    const startDate = new Date(eliminationDate);
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    // Même si pas encore d'activités, l'éliminé doit apparaître
    let pActs = [];
    let stats = { elevation: 0, distance: 0, activities: 0 };

    if (startDate <= endDate) {
      pActs = filterByParticipant(filterByPeriod(activities, startDate, endDate), p.id);
      stats = calculateStats(pActs);
    }

    ranking.push({
      participant: p,
      totalElevation: stats.elevation,
      totalDistance: stats.distance,
      activityCount: stats.activities,
      eliminatedRound: p.eliminatedRound,
      eliminatedSeason: p.eliminatedSeason,
      daysSinceElimination: Math.max(0, Math.floor((endDate - eliminationDate) / 86400000))
    });
  }

  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedChallengePoints(e.position);
  });
  return ranking;
}
// ============================================
// CLASSEMENT ANNUEL
// ============================================

/**
 * Compte le nombre total d'éliminés avant un round donné dans une saison
 */
function countEliminationsBeforeRound(eliminatedList, roundInSeason) {
  return eliminatedList.filter(e => e.eliminatedRound < roundInSeason).length;
}

function calculateYearlyStandings(activities, currentDate) {
  const currentSeason = getSeasonNumber(currentDate);
  const totals = {};

  // Initialiser pour TOUS les participants
  PARTICIPANTS.forEach(p => {
    totals[p.id] = {
      participant: p,
      totalMainPoints: 0,
      totalEliminatedPoints: 0,
      totalRescapePoints: 0,
      totalPoints: 0,
      wins: 0,
      seasonsPlayed: 0,
      isLateRegistration: !wasRegisteredBeforeStart(p)
    };
  });

  for (let s = 1; s <= currentSeason; s++) {
    const seasonDates = getSeasonDates(s);
    if (currentDate < seasonDates.start) continue;

    const sData = simulateSeasonEliminations(activities, s, currentDate);
    const elimRanking = calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate);
    const elimPointsMap = {};
    elimRanking.forEach(e => elimPointsMap[e.participant.id] = e.points);

    // Calculer les points rescapé de cette saison
    const rescapeData = calculateRescapePointsForSeason(s);

    // Calcul des points pour TOUS les participants
    PARTICIPANTS.forEach(p => {
      const elim = sData.eliminated.find(e => e.id === p.id);
      let mainPts = 0, elimPts = 0;

      if (elim) {
        const elimsBeforeThisRound = countEliminationsBeforeRound(sData.eliminated, elim.eliminatedRound);
        const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;
        const sameRoundElims = sData.eliminated.filter(e => e.eliminatedRound === elim.eliminatedRound);
        const indexInRound = sameRoundElims.findIndex(e => e.id === elim.id);
        const position = activeAtRoundStart - indexInRound;
        mainPts = getMainChallengePoints(Math.max(1, Math.min(position, PARTICIPANTS.length)));
        elimPts = elimPointsMap[p.id] || 0;
      } else if (sData.winner?.id === p.id) {
        mainPts = getMainChallengePoints(1);
        totals[p.id].wins++;
      } else if (sData.seasonComplete) {
        mainPts = getMainChallengePoints(2);
      }

      // Points rescapé
      const rescapePts = rescapeData[p.id]?.totalPoints || 0;

      if (sData.seasonComplete || elim) {
        totals[p.id].totalMainPoints += mainPts;
        totals[p.id].totalEliminatedPoints += elimPts;
        totals[p.id].totalRescapePoints += rescapePts;
        totals[p.id].totalPoints += mainPts + elimPts + rescapePts;
        if (sData.seasonComplete) {
          totals[p.id].seasonsPlayed++;
        }
      } else {
        // Saison en cours : ajouter les points rescapé même pour les joueurs encore actifs
        totals[p.id].totalRescapePoints += rescapePts;
        totals[p.id].totalPoints += rescapePts;
      }
    });
  }

  const standings = Object.values(totals);
  standings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins);
  standings.forEach((e, i) => e.rank = i + 1);
  return standings;
}

// ============================================
// RÉSUMÉ DE SAISON (pour l'historique)
// ============================================

function getSeasonSummary(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);
  const sData = simulateSeasonEliminations(activities, seasonNumber, currentDate);
  const rounds = [];
  const roundsPerSeason = getRoundsPerSeason();

  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    if (currentDate < roundDates.start) break;

    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    // Filtrer les participants actifs à ce round (ceux qui n'ont pas été éliminés AVANT ce round)
    const activeAtRound = PARTICIPANTS.filter(p =>
      !sData.eliminated.some(e => e.eliminatedRound < r && e.id === p.id)
    );
    const ranking = calculateRanking(roundActivities, activeAtRound);

    rounds.push({
      roundInSeason: r,
      globalRound,
      dates: roundDates,
      winner: ranking[0]?.participant,
      winnerElevation: ranking[0]?.totalElevation || 0,
      // Filtrer par eliminatedRound (round dans la saison)
      eliminated: sData.eliminated.filter(e => e.eliminatedRound === r).map(e => e.name)
    });
  }

  return {
    seasonNumber,
    dates: seasonDates,
    isComplete: sData.seasonComplete,
    winner: sData.winner,
    rounds,
    eliminatedRanking: calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate)
  };
}

// ============================================
// RENDU PRINCIPAL
// ============================================

function renderAll() {
  try {
    const today = getCurrentDate();

    // Vérifier si le challenge a commencé
    const challengeStart = new Date(CHALLENGE_CONFIG.yearStartDate);
    if (today < challengeStart) {
      renderWaitingScreen(challengeStart);
      return;
    }

    currentSeasonNumber = getSeasonNumber(today);

    currentRoundNumber = getGlobalRoundNumber(today);

    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);

    yearlyStandingsCache = calculateYearlyStandings(allActivities, today);

    // Detect special rule for current round
    const bannerSpecialRule = getSpecialRuleForRound(currentRoundNumber);
    const bannerRuleDetails = bannerSpecialRule ? (ROUND_RULES[bannerSpecialRule] || null) : null;

    // Banner
    const seasonBanner = document.getElementById('seasonBanner');
    if (seasonBanner) {
      renderCombinedBanner(seasonBanner, {
        currentSeasonNumber,
        currentRoundNumber,
        seasonData,
        currentDate: today,
        specialRule: bannerSpecialRule,
        specialRuleDetails: bannerRuleDetails
      });
    }

    // Classement
    const rankingContainer = document.getElementById('rankingContainer');
    if (rankingContainer) {
      const seasonType = getSeasonType(currentSeasonNumber);

      if (seasonType?.isTeamBased && seasonData?.roundResults) {
        // MODE ÉQUIPE : rendu par blocs d'équipe
        const currentRoundResult = seasonData.roundResults.find(r => r.status === 'active');
        if (currentRoundResult?.teams) {
          renderTeamRanking(rankingContainer, {
            teams: currentRoundResult.teams,
            seasonData,
            currentSeasonNumber,
            currentRoundNumber
          });
        } else {
          rankingContainer.innerHTML = '<div class="empty-state"><p>En attente des données d\'équipe...</p></div>';
        }
      } else {
        // MODE STANDARD : rendu classique
        const roundDates = getRoundDates(currentRoundNumber);
        const endDate = today < new Date(roundDates.end) ? today : roundDates.end;

      // DEBUG: Afficher les dates exactes

      const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

      // DEBUG: Si pas d'activités, montrer pourquoi
      if (roundActivities.length === 0 && allActivities.length > 0) {
        const sampleDates = allActivities.slice(0, 5).map(a => a.start_date?.substring(0,10));
        console.warn('⚠️ Aucune activité dans la période! Exemples de dates disponibles:', sampleDates);
      }

      let ranking = calculateRanking(roundActivities, seasonData?.active || []);

      ranking = applyJokerEffects(ranking, currentRoundNumber);

      // Détecter la règle spéciale du round courant
      const currentRule = getSpecialRuleForRound(currentRoundNumber);
      const currentRuleDetails = currentRule ? (ROUND_RULES[currentRule] || null) : null;

      // Appliquer le handicap si actif
      if (currentRule === 'handicap' && yearlyStandingsCache) {
        ranking = applyHandicapRule(ranking, yearlyStandingsCache);
      }

      // Stats saison pour chaque participant
      const seasonDates = getSeasonDates(currentSeasonNumber);
      const seasonStats = {};
      PARTICIPANTS.forEach(p => {
        const pActivities = filterByParticipant(
          filterByPeriod(allActivities, seasonDates.start, endDate),
          p.id
        );
        seasonStats[p.id] = calculateStats(pActivities);
      });

      // Marquer la zone de danger
      const elimCount = CHALLENGE_CONFIG.eliminationsPerRound;
      ranking.forEach((e, i) => {
        e.isInDangerZone = i >= ranking.length - elimCount;
        if (e.jokerEffects?.hasShield && e.isInDangerZone) {
          e.isProtected = true;
          e.isInDangerZone = false;
        }
      });

      // Calculer le rescapé du round précédent (depuis frozen results)
      const rescapeId = getRescapeFromPreviousRound(currentRoundNumber);

      // Calculer les effets des bonus éphémères pour chaque participant ACTIF
      const ephemeralEffects = {};
      ranking.forEach(e => {
        ephemeralEffects[e.participant.id] = getEphemeralBonusEffectsForActiveAthlete(e.participant.id, currentRoundNumber);
      });

      renderRanking(rankingContainer, {
        ranking,
        seasonData,
        currentSeasonNumber,
        seasonStats,
        eliminationsCount: elimCount,
        currentRoundNumber,
        rescapeId,
        ephemeralEffects,
        specialRule: currentRule,
        specialRuleDetails: currentRuleDetails
      });
      } // fin else mode standard
    }

    // Arsenal (Jokers & Bonus)
    const arsenalContainer = document.getElementById('arsenalContainer');
    if (arsenalContainer) {
      renderArsenalSection(arsenalContainer, currentRoundNumber);
    }

    // Challenge des Éliminés
    const eliminatedContainer = document.getElementById('eliminatedChallengeContainer');
    if (eliminatedContainer) {
      renderEliminatedChallenge(eliminatedContainer);
    }

    // Classement Général
    const finalStandingsContainer = document.getElementById('finalStandingsContainer');
    if (finalStandingsContainer) {
      renderFinalStandings(finalStandingsContainer);
    }

    // Historique
    const historyTimeline = document.getElementById('historyTimeline');
    if (historyTimeline) {
      renderHistorySection(historyTimeline);
    }

    // Guide des jokers
    const jokersGuide = document.getElementById('jokersGuide');
    if (jokersGuide) {
      renderJokersGuide(jokersGuide);
    }

    // Ticker des activités récentes
    renderActivityTicker();


    // Masquer le loader avec transition - méthode robuste pour mobile
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      // Utiliser la classe CSS pour la transition
      loadingScreen.classList.add('hidden');
      // Fallback: forcer le masquage après la transition
      setTimeout(() => {
        loadingScreen.style.display = 'none';
        loadingScreen.style.visibility = 'hidden';
        loadingScreen.style.pointerEvents = 'none';
      }, 600);
    } else {
      console.warn('⚠️ loadingScreen non trouvé');
    }

  } catch (error) {
    console.error('❌ Erreur renderAll:', error);

    // Afficher l'erreur dans le loader
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.innerHTML = '<div class="loading-content"><div class="loading-icon" style="font-size:64px">⚠️</div><div class="loading-title">Erreur</div><div class="loading-text">'+error.message+'</div></div>';
    }
  }
}

// ============================================
// RENDU: CHALLENGE DES ÉLIMINÉS
// ============================================
// RENDU: CLASSEMENT ÉQUIPES
// ============================================

function renderTeamRanking(container, data) {
  const { teams, seasonData, currentSeasonNumber, currentRoundNumber } = data;

  if (!teams || teams.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Aucune équipe formée</p></div>';
    return;
  }

  // Trier les équipes par D+ total décroissant
  const sortedTeams = [...teams].sort((a, b) => b.totalElevation - a.totalElevation);
  const lastTeamIdx = sortedTeams.length - 1;

  let html = `
    <div class="team-ranking">
      <div class="team-ranking-header">
        <span>🤝 Saison Équipes — Round ${getRoundInSeason(getCurrentDate())}/${getRoundsForSeason(currentSeasonNumber)}</span>
      </div>
  `;

  sortedTeams.forEach((team, teamPosition) => {
    const isLastTeam = teamPosition === lastTeamIdx;
    const teamColor = team.color || TEAM_COLORS[team.index % TEAM_COLORS.length];
    const position = teamPosition + 1;

    // Médaille pour le top 3
    const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : '';

    html += `
      <div class="team-block ${isLastTeam ? 'team-danger' : ''}" style="border-left: 4px solid ${teamColor.border}; background: ${teamColor.bg};">
        <div class="team-block-header">
          <span class="team-position">${medal || '#' + position}</span>
          <span class="team-name">Équipe ${teamColor.name}</span>
          <span class="team-total-elevation">${formatElevation(team.totalElevation)}</span>
          ${isLastTeam ? '<span class="team-danger-badge">⚠️ Zone d\'élimination</span>' : ''}
        </div>
        <div class="team-members">
    `;

    // Membres triés par D+ décroissant
    const membersSorted = [...team.members].sort((a, b) => b.elevation - a.elevation);
    membersSorted.forEach((member, memberIdx) => {
      const participant = getParticipantById(member.id);
      const name = participant?.name || member.name || '?';
      const color = getAthleteColor(member.id);
      const initials = getAthleteInitials(member.id);

      html += `
          <div class="team-member-row ${isLastTeam ? 'in-danger' : ''}">
            <div class="team-member-info">
              <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${color},${color}88)">${initials}</div>
              <span class="team-member-name">${name}</span>
            </div>
            <span class="team-member-elevation">${formatElevation(member.elevation)}</span>
          </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU: CHALLENGE DES ÉLIMINÉS
// ============================================

function renderEliminatedChallenge(container) {
  if (!seasonData?.eliminated?.length) {
    container.innerHTML = '<div class="empty-state"><p>Aucun éliminé cette saison</p></div>';
    return;
  }

  const seasonDates = getSeasonDates(currentSeasonNumber);
  const ranking = calculateEliminatedChallenge(allActivities, seasonData.eliminated, seasonDates, getCurrentDate());

  if (ranking.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Les éliminés n\'ont pas encore d\'activités depuis leur élimination</p></div>';
    return;
  }

  // Déterminer qui a reçu un bonus éphémère (meilleur des 2 éliminés de chaque round)
  const bonusRecipients = getBonusRecipientsForSeason(currentSeasonNumber);

  // Calculer les effets de bonus pour chaque éliminé (cumulés sur toute la saison)
  const bonusEffectsByAthlete = {};
  for (const eliminated of seasonData.eliminated) {
    const effects = { gained: 0, lost: 0, details: [] };
    // Parcourir tous les rounds de la saison pour cumuler les effets
    const roundsPerSeason = getRoundsPerSeason();
    const seasonStartRound = (currentSeasonNumber - 1) * roundsPerSeason + 1;
    const seasonEndRound = currentSeasonNumber * roundsPerSeason;
    for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
      const roundEffects = getEphemeralBonusEffectsForEliminatedAthlete(eliminated.id, roundNum);
      effects.gained += roundEffects.gained;
      effects.lost += roundEffects.lost;
      effects.details.push(...roundEffects.details);
    }
    bonusEffectsByAthlete[eliminated.id] = effects;
  }

  // Appliquer les bonus éphémères au D+ total des éliminés
  ranking.forEach(e => {
    const bonusEffects = bonusEffectsByAthlete[e.participant.id] || { gained: 0, lost: 0 };
    const netBonus = bonusEffects.gained - bonusEffects.lost;
    if (netBonus !== 0) {
      e.totalElevation = Math.max(0, e.totalElevation + netBonus);
    }
  });

  // Re-trier et re-assigner les positions après application des bonus
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedChallengePoints(e.position);
  });

  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ cumulé</div><div>Éliminé</div><div>Points</div></div>';
  ranking.forEach(e => {
    const hasBonus = bonusRecipients.has(String(e.participant.id));
    const bonusBadge = hasBonus ? '<span class="bonus-badge" title="Meilleur des 2 éliminés - A reçu un bonus éphémère">🎁</span>' : '';

    // Calculer les pilules de bonus éphémères
    const bonusEffects = bonusEffectsByAthlete[e.participant.id] || { gained: 0, lost: 0 };
    let bonusPills = '';
    if (bonusEffects.gained > 0) {
      bonusPills += `<span class="bonus-tag ephemeral-gained">+${formatElevation(bonusEffects.gained, false)} m</span>`;
    }
    if (bonusEffects.lost > 0) {
      bonusPills += `<span class="bonus-tag ephemeral-stolen">-${formatElevation(bonusEffects.lost, false)} m</span>`;
    }

    html += `<div class="ranking-row">
      <div class="ranking-position">${e.position}</div>
      <div class="ranking-athlete">
        <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <div class="athlete-info">
          <span class="athlete-name">${e.participant.name} ${bonusBadge}</span>
          <span class="athlete-status eliminated">${e.daysSinceElimination}j depuis élim.</span>
        </div>
      </div>
      <div class="ranking-elevation">
        ${formatElevation(e.totalElevation, false)} <span class="elevation-unit">m</span>
        ${bonusPills ? `<div class="elevation-bonuses">${bonusPills}</div>` : ''}
      </div>
      <div class="ranking-round">R${e.eliminatedRound}</div>
      <div class="ranking-points"><span class="points-badge">${e.points} pts</span></div>
    </div>`;
  });
  container.innerHTML = html;
}

/**
 * Détermine qui a reçu un bonus éphémère pour une saison donnée
 * Le meilleur des 2 éliminés (celui avec le plus de D+ pendant le round) reçoit un bonus
 * Sauf si les 2 ont le même D+ (y compris 0)
 * @returns {Set} IDs des joueurs ayant reçu un bonus
 */
function getBonusRecipientsForSeason(seasonNumber) {
  const recipients = new Set();
  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  if (!frozenResultsCache?.rounds) return recipients;

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const roundData = frozenResultsCache.rounds[String(roundNum)];
    if (!roundData?.frozen || !roundData.eliminations || roundData.eliminations.length < 2) continue;

    // Trier les éliminés par D+ décroissant
    const sortedElims = [...roundData.eliminations].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
    const best = sortedElims[0];
    const second = sortedElims[1];

    // Le meilleur reçoit un bonus seulement s'il a plus de D+ que le second et que son D+ > 0
    if ((best.elevation || 0) > 0 && (best.elevation || 0) > (second.elevation || 0)) {
      recipients.add(String(best.id));
    }
  }

  return recipients;
}

// ============================================
// RENDU: CLASSEMENT GÉNÉRAL
// ============================================

/**
 * Calcule les points depuis les résultats figés
 * Cette fonction utilise les données figées pour obtenir un calcul précis des points
 */
function calculatePointsFromFrozenResults() {
  const pointsMap = {};

  // Initialiser pour tous les participants
  PARTICIPANTS.forEach(p => {
    pointsMap[p.id] = {
      mainPoints: 0,        // Points du challenge principal (toutes saisons confondues)
      elimPoints: 0,        // Points du challenge éliminés
      bonusPoints: 0,       // Points bonus (jokers, etc.)
      currentRoundPoints: 0, // Points potentiels du round actuel
      wins: 0
    };
  });

  if (!frozenResultsCache?.rounds) return pointsMap;

  // Parcourir tous les rounds figés
  const frozenRounds = Object.entries(frozenResultsCache.rounds)
    .map(([key, value]) => ({ roundNum: parseInt(key), ...value }))
    .sort((a, b) => a.roundNum - b.roundNum);

  for (const round of frozenRounds) {
    if (!round.frozen || !round.ranking) continue;

    // Ajouter les mainPoints de chaque participant dans ce round
    for (const entry of round.ranking) {
      const id = String(entry.id);
      if (!pointsMap[id]) continue;

      // Les mainPoints sont attribués aux éliminés et au gagnant dans frozen_results
      if (entry.mainPoints > 0) {
        pointsMap[id].mainPoints += entry.mainPoints;
      }

      // Vérifier si c'est un gagnant de saison
      if (entry.isWinner) {
        pointsMap[id].wins++;
      }
    }
  }

  return pointsMap;
}

function renderFinalStandings(container) {
  const activeIds = new Set((seasonData?.active || []).map(p => p.id));

  // Calculer les points depuis les résultats figés pour plus de précision
  const frozenPoints = calculatePointsFromFrozenResults();

  // Calculer les points de la saison précédente
  const previousSeasonPoints = calculatePointsForSeason(currentSeasonNumber - 1);

  // Calculer les points de la saison actuelle (jusqu'au dernier round figé)
  const currentSeasonPoints = calculatePointsForSeason(currentSeasonNumber);

  // Utiliser yearlyStandingsCache mais l'enrichir avec les données figées
  const standings = yearlyStandingsCache || [];

  // Enrichir les standings avec les points figés et recalculer
  const enrichedStandings = standings.map(e => {
    const id = String(e.participant.id);
    const frozen = frozenPoints[id] || { mainPoints: 0, elimPoints: 0, bonusPoints: 0, wins: 0 };
    const prevSeason = previousSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };
    const currSeason = currentSeasonPoints[id] || { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };

    // Utiliser les points figés s'ils sont supérieurs (plus fiables)
    const mainPts = Math.max(e.totalMainPoints || 0, frozen.mainPoints);
    const elimPts = e.totalEliminatedPoints || 0;
    const rescapePts = e.totalRescapePoints || 0;
    const bonusPts = frozen.bonusPoints || 0;
    const wins = Math.max(e.wins || 0, frozen.wins);

    return {
      ...e,
      totalMainPoints: mainPts,
      totalEliminatedPoints: elimPts,
      totalRescapePoints: rescapePts,
      bonusPoints: bonusPts,
      totalPoints: mainPts + elimPts + rescapePts + bonusPts,
      wins: wins,
      previousSeasonTotal: prevSeason.total,
      currentSeasonMain: currSeason.mainPoints,
      currentSeasonElim: currSeason.elimPoints,
      currentSeasonRescape: currSeason.rescapePoints,
      currentSeasonTotal: currSeason.total
    };
  });

  // Re-trier par points totaux
  enrichedStandings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins || b.totalMainPoints - a.totalMainPoints);
  enrichedStandings.forEach((e, i) => e.rank = i + 1);

  // HTML avec colonnes améliorées
  let html = `
    <div class="standings-header">
      <div>Rang</div>
      <div>Athlète</div>
      <div class="hide-mobile" title="Points des saisons précédentes">Saisons préc.</div>
      <div class="hide-mobile" title="Points de la saison actuelle"><span class="header-main">Principal</span> · <span class="header-elim">Éliminé</span></div>
      <div>Total</div>
    </div>`;

  enrichedStandings.forEach(e => {
    const isActive = activeIds.has(e.participant.id);
    const wins = e.wins > 0 ? `<span class="wins-badge">🏆×${e.wins}</span>` : '';
    const isCurrentSeasonEliminated = seasonData?.eliminated?.some(el => el.id === e.participant.id);

    let statusBadge = '';
    if (isActive) {
      statusBadge = '<span class="active-badge">En course</span>';
    } else if (isCurrentSeasonEliminated) {
      const elimData = seasonData.eliminated.find(el => el.id === e.participant.id);
      statusBadge = `<span class="elim-badge">Élim. R${elimData?.eliminatedRound || '?'}</span>`;
    }

    // Colonne saison actuelle : valeurs colorées texte (pas de fond)
    const currentSeasonParts = [];
    if (e.currentSeasonMain > 0) {
      currentSeasonParts.push(`<span class="pts-text-main">${e.currentSeasonMain}</span>`);
    }
    if (e.currentSeasonRescape > 0) {
      currentSeasonParts.push(`<span class="pts-text-rescape">+${e.currentSeasonRescape}</span>`);
    }
    if (e.currentSeasonElim > 0) {
      currentSeasonParts.push(`<span class="pts-text-elim">+${e.currentSeasonElim}</span>`);
    }
    const currentSeasonHtml = currentSeasonParts.length > 0
      ? `<span class="season-pts-detail">${currentSeasonParts.join(' ')}</span>`
      : `<span class="pts-zero">-</span>`;

    // Détail du total en hover uniquement
    const hoverParts = [];
    if (e.totalMainPoints > 0) hoverParts.push(`Principal: ${e.totalMainPoints}`);
    if (e.totalRescapePoints > 0) hoverParts.push(`Rescapé: +${e.totalRescapePoints}`);
    if (e.totalEliminatedPoints > 0) hoverParts.push(`Éliminé: +${e.totalEliminatedPoints}`);
    if (e.bonusPoints > 0) hoverParts.push(`Bonus: +${e.bonusPoints}`);
    const hoverTitle = hoverParts.length > 1 ? hoverParts.join(' \u00B7 ') : '';

    html += `<div class="standings-row ${isActive ? '' : 'eliminated'}">
      <div class="standings-rank">${e.rank}</div>
      <div class="standings-athlete">
        <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <span>${e.participant.name}</span>${wins}${statusBadge}
      </div>
      <div class="standings-points prev hide-mobile">${e.previousSeasonTotal || '-'}</div>
      <div class="standings-points current hide-mobile">${currentSeasonHtml}</div>
      <div class="standings-total"${hoverTitle ? ` title="${hoverTitle}"` : ''}>${e.totalPoints}</div>
    </div>`;
  });

  container.innerHTML = html;
}

/**
 * Calcule les points pour une saison donnée depuis les résultats figés
 */
function calculatePointsForSeason(seasonNumber) {
  const pointsMap = {};

  PARTICIPANTS.forEach(p => {
    pointsMap[p.id] = { mainPoints: 0, elimPoints: 0, rescapePoints: 0, total: 0 };
  });

  if (!frozenResultsCache?.rounds || seasonNumber < 1) return pointsMap;

  const roundsPerSeason = getRoundsPerSeason();
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  const seasonEndRound = seasonNumber * roundsPerSeason;

  for (let roundNum = seasonStartRound; roundNum <= seasonEndRound; roundNum++) {
    const round = frozenResultsCache.rounds[String(roundNum)];
    if (!round?.frozen || !round.ranking) continue;

    for (const entry of round.ranking) {
      const id = String(entry.id);
      if (!pointsMap[id]) continue;

      if (entry.mainPoints > 0) {
        pointsMap[id].mainPoints += entry.mainPoints;
      }
    }
  }

  // Calculer les elimPoints via calculateEliminatedChallenge
  const seasonDates = getSeasonDates(seasonNumber);
  const sData = simulateSeasonEliminations(allActivities, seasonNumber, new Date());

  if (sData.eliminated.length > 0) {
    const endDate = sData.seasonComplete ? seasonDates.end : new Date();
    const elimRanking = calculateEliminatedChallenge(allActivities, sData.eliminated, seasonDates, endDate);
    for (const e of elimRanking) {
      const id = String(e.participant.id);
      if (pointsMap[id]) {
        pointsMap[id].elimPoints = e.points || 0;
      }
    }
  }

  // Calculer les points rescapé
  const rescapeData = calculateRescapePointsForSeason(seasonNumber);
  for (const id in pointsMap) {
    pointsMap[id].rescapePoints = rescapeData[id]?.totalPoints || 0;
  }

  // Calculer le total
  for (const id in pointsMap) {
    pointsMap[id].total = pointsMap[id].mainPoints + pointsMap[id].elimPoints + pointsMap[id].rescapePoints;
  }

  return pointsMap;
}

// ============================================
// RENDU: SECTION ARSENAL (JOKERS & BONUS)
// ============================================

async function renderArsenalSection(container, roundNumber) {
  const today = getCurrentDate();
  const currentRoundDates = getRoundDates(roundNumber);
  const previousRoundNumber = roundNumber - 1;

  // Calculer si on est dans la période "récap" (1 jour après fin du round précédent)
  let showPreviousRoundEffects = false;
  let previousRoundEffects = { jokers: [], bonuses: [] };

  if (previousRoundNumber >= 1) {
    const previousRoundDates = getRoundDates(previousRoundNumber);
    const daysSinceEnd = Math.floor((today - previousRoundDates.end) / (1000 * 60 * 60 * 24));

    // Afficher les effets du round précédent pendant 1 jour après sa fin
    if (daysSinceEnd >= 0 && daysSinceEnd <= 1) {
      showPreviousRoundEffects = true;

      // Récupérer les jokers du round précédent
      const prevJokers = getActiveJokersForRound(previousRoundNumber);
      previousRoundEffects.jokers = prevJokers.map(joker => {
        const athlete = getParticipantById(joker.athleteId);
        const target = joker.targetId ? getParticipantById(joker.targetId) : null;
        return {
          ...joker,
          joker_id: joker.jokerId,
          athlete_name: athlete?.name || 'Joueur',
          target_athlete_name: target?.name || null
        };
      });

      // Récupérer les bonus utilisés au round précédent
      previousRoundEffects.bonuses = getBonusesUsedInRound(previousRoundNumber).map(b => {
        const bonusType = BONUS_TYPES?.[b.bonus_id];
        return {
          ...b,
          bonus_name: bonusType?.name || b.bonus_id,
          icon: bonusType?.icon || '🎁',
          description: getBonusHistoryDescription(b)
        };
      });
    }
  }

  // Récupérer les jokers actifs ce round
  const activeJokers = getActiveJokersForRound(roundNumber);

  // Calculer le ranking avec effets pour avoir les montants (voleur, sabotage, etc.)
  const roundDates = getRoundDates(roundNumber);
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const ranking = calculateRanking(roundActivities, seasonData?.active || []);
  const rankingWithEffects = applyJokerEffects(ranking, roundNumber, roundActivities);

  // Enrichir avec les noms des joueurs et les montants d'effets
  const enrichedJokers = activeJokers.map(joker => {
    const athlete = getParticipantById(joker.athleteId);
    const target = joker.targetId ? getParticipantById(joker.targetId) : null;

    // Récupérer les montants d'effets depuis le ranking calculé
    let effectAmount = 0;
    if (joker.jokerId === 'voleur' && joker.targetId) {
      const targetEntry = rankingWithEffects.find(e => String(e.participant.id) === joker.targetId);
      effectAmount = targetEntry?.jokerEffects?.bonuses?.stolen?.amount || 0;
    } else if (joker.jokerId === 'sabotage' && joker.targetId) {
      const targetEntry = rankingWithEffects.find(e => String(e.participant.id) === joker.targetId);
      effectAmount = targetEntry?.jokerEffects?.bonuses?.sabotaged?.amount || 0;
    } else if (joker.jokerId === 'multiplicateur') {
      const participantEntry = rankingWithEffects.find(e => String(e.participant.id) === joker.participantId);
      effectAmount = participantEntry?.jokerEffects?.bonuses?.multiplier?.amount || 0;
    }

    return {
      ...joker,
      joker_id: joker.jokerId,
      athlete_name: athlete?.name || 'Joueur',
      target_athlete_name: target?.name || null,
      effectAmount
    };
  });

  // Récupérer les bonus éphémères ACTIFS (non utilisés ou utilisés ce round)
  let bonuses = [];
  try {
    const res = await fetch('/api/bonuses/all');
    if (res.ok) {
      const allBonuses = await res.json();
      // Filtrer: garder uniquement les bonus non utilisés OU utilisés ce round
      bonuses = allBonuses
        .filter(b => !b.used_in_round || b.used_in_round === roundNumber)
        .map(b => {
          const athlete = getParticipantById(b.athlete_id);
          const target = b.target_athlete_id ? getParticipantById(b.target_athlete_id) : null;
          const bonusType = BONUS_TYPES?.[b.bonus_id];

          // Calculer les infos supplémentaires pour le hover
          const hoverInfo = calculateBonusHoverInfo(b, athlete, target, currentRoundNumber);

          return {
            ...b,
            athlete_name: athlete?.name || 'Joueur',
            target_athlete_name: target?.name || null,
            bonus_name: bonusType?.name || b.bonus_id,
            icon: bonusType?.icon || '🎁',
            status: b.used_at ? 'used' : b.activated_at ? 'active' : 'available',
            hoverInfo
          };
        });
    }
  } catch (e) {
    console.warn('Impossible de charger les bonus:', e);
  }

  // Récupérer les choix en attente
  try {
    const res = await fetch('/api/bonuses/active');
    if (res.ok) {
      const pendingData = await res.json();
      // Ajouter les joueurs qui doivent encore choisir
      if (pendingData.pendingChoices) {
        Object.entries(pendingData.pendingChoices).forEach(([playerId, choices]) => {
          const athlete = getParticipantById(playerId);
          if (!bonuses.some(b => String(b.athlete_id) === String(playerId))) {
            bonuses.push({
              athlete_id: playerId,
              athlete_name: athlete?.name || 'Joueur',
              icon: '🎁',
              status: 'pending'
            });
          }
        });
      }
    }
  } catch (e) {
    // Ignorer
  }

  // Récupérer les jokers programmés pour le prochain round
  const pendingJokers = getPendingJokersForNextRound(roundNumber);
  const enrichedPendingJokers = pendingJokers.map(joker => {
    const athlete = getParticipantById(joker.athleteId);
    const target = joker.targetId ? getParticipantById(joker.targetId) : null;
    return {
      ...joker,
      joker_id: joker.jokerId,
      athlete_name: athlete?.name || 'Joueur',
      target_athlete_name: target?.name || null
    };
  });

  renderArsenal(container, {
    activeJokers: enrichedJokers,
    pendingJokers: enrichedPendingJokers,
    bonuses,
    currentRoundNumber: roundNumber,
    showPreviousRoundEffects,
    previousRoundEffects,
    previousRoundNumber
  });
}

/**
 * Calcule les informations supplémentaires pour le hover d'un bonus
 */
function calculateBonusHoverInfo(bonus, athlete, target, roundNumber) {
  const bonusId = bonus.bonus_id;
  if (!bonusId || bonus.status === 'pending') return null;

  const athleteId = bonus.athlete_id;
  const targetId = bonus.target_athlete_id;
  const effectRound = bonus.used_in_round || roundNumber;

  switch (bonusId) {
    case 'embuscade': {
      if (!targetId) return null;
      const targetActivities = getEligibleActivitiesForBonus(targetId, effectRound);
      if (targetActivities.length === 0) return "Aucune activité éligible";
      const elevations = targetActivities.map(a => a.total_elevation_gain || 0);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      return `Entre ${formatElevation(minElev, false)} et ${formatElevation(maxElev, false)} m D+ potentiellement volés`;
    }

    case 'ravitaillement': {
      // Calculer le D+ potentiel des activités de l'éliminé
      const athleteActivities = getEligibleActivitiesForBonus(athleteId, effectRound);
      if (athleteActivities.length === 0) return "Aucune activité éligible";
      const elevations = athleteActivities.map(a => a.total_elevation_gain || 0);
      const minElev = Math.min(...elevations);
      const maxElev = Math.max(...elevations);
      const targetName = target?.name || 'la cible';
      return `Entre ${formatElevation(minElev, false)} et ${formatElevation(maxElev, false)} m D+ donnés à ${targetName}`;
    }

    case 'duel': {
      // Calculer l'avance/retard sur le co-éliminé
      const coEliminatedId = findCoEliminated(athleteId, bonus.elimination_round);
      if (!coEliminatedId) return null;
      const coEliminated = getParticipantById(coEliminatedId);
      const athleteElev = getEliminatedElevationSince(athleteId, bonus.elimination_round);
      const coElimElev = getEliminatedElevationSince(coEliminatedId, bonus.elimination_round);
      const diff = athleteElev - coElimElev;
      if (diff > 0) {
        return `${formatElevation(diff, false)} m d'avance sur ${coEliminated?.name || 'son adversaire'}`;
      } else if (diff < 0) {
        return `${formatElevation(Math.abs(diff), false)} m de retard sur ${coEliminated?.name || 'son adversaire'}`;
      } else {
        return `Égalité avec ${coEliminated?.name || 'son adversaire'}`;
      }
    }

    case 'marquage': {
      // Pas d'info sur la cible pour ne pas influencer
      const athleteName = athlete?.name || 'Le joueur';
      return `${athleteName} a marqué un joueur actif. S'il est éliminé → +1 point`;
    }

    case 'trap': {
      // Si déjà déclenché, montrer le D+ gagné
      if (bonus.effect_result?.elevation_gained) {
        const victimName = bonus.effect_result.victim_name || 'un joueur';
        return `+${formatElevation(bonus.effect_result.elevation_gained, false)} m gagnés grâce à ${victimName}`;
      }
      return "Piège actif, en attente d'un éliminé...";
    }

    case 'second_souffle': {
      // Trouver le round d'élimination (depuis le bonus ou les données de saison)
      let elimRound = bonus.elimination_round;
      if (!elimRound && seasonData?.eliminated) {
        const elimEntry = seasonData.eliminated.find(e => String(e.id) === String(athleteId));
        if (elimEntry) {
          const roundsPerSeason2 = getRoundsPerSeason();
          elimRound = (elimEntry.eliminatedSeason - 1) * roundsPerSeason2 + elimEntry.eliminatedRound;
        }
      }
      if (!elimRound) return "Aucune donnée d'élimination";
      // Trouver l'activité la plus faible
      const activities = getEliminatedActivities(athleteId, elimRound);
      if (activities.length === 0) return "Aucune activité depuis l'élimination";
      const minActivity = activities.reduce((min, a) =>
        (a.total_elevation_gain || 0) < (min.total_elevation_gain || 0) ? a : min
      );
      const minElev = minActivity.total_elevation_gain || 0;
      const activityName = minActivity.name || 'Activité';
      return `x2 sur "${activityName}" = +${formatElevation(minElev, false)} m bonus`;
    }

    case 'kamikaze': {
      // Calculer le D+ du round actuel pour les deux joueurs
      if (!targetId) return "Cible non définie";
      const roundDates = getRoundDates(effectRound);

      // D+ du round de l'éliminé (celui qui utilise le bonus)
      const athleteRoundElev = getRoundElevation(athleteId, roundDates);
      const targetRoundElev = getRoundElevation(targetId, roundDates);

      const athleteLoss = Math.round(athleteRoundElev * 0.25);
      const targetLoss = Math.round(targetRoundElev * 0.25);
      const targetName = target?.name || 'la cible';

      return `💣 -${formatElevation(athleteLoss, false)} m pour toi, -${formatElevation(targetLoss, false)} m pour ${targetName}`;
    }

    case 'malediction': {
      // Calculer le D+ volé ce round et le cumul
      if (!targetId) return "Cible non définie";
      const roundDates = getRoundDates(effectRound);

      const targetRoundElev = getRoundElevation(targetId, roundDates);
      const stolenThisRound = Math.round(targetRoundElev * 0.10);
      const targetName = target?.name || 'la cible';

      // Cumul total volé (si disponible dans effect_result)
      const totalStolen = bonus.effect_result?.total_stolen || 0;

      if (totalStolen > 0) {
        return `🪬 ${formatElevation(stolenThisRound, false)} m volés ce round à ${targetName} (total: ${formatElevation(totalStolen, false)} m)`;
      }
      return `🪬 ${formatElevation(stolenThisRound, false)} m seront volés à ${targetName} ce round`;
    }

    default:
      return null;
  }
}

/**
 * Calcule le D+ d'un joueur pour un round donné
 */
function getRoundElevation(athleteId, roundDates) {
  if (!allActivities) return 0;
  const activities = allActivities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    const date = new Date(a.start_date);
    return date >= roundDates.start && date <= roundDates.end;
  });
  return activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
}

/**
 * Récupère les activités éligibles pour un bonus (>20min)
 */
function getEligibleActivitiesForBonus(athleteId, roundNumber) {
  if (!allActivities) return [];

  // Si un numéro de round est fourni, filtrer par les dates de ce round
  let activities = allActivities;
  if (roundNumber) {
    const roundDates = getRoundDates(roundNumber);
    activities = filterByPeriod(allActivities, roundDates.start, roundDates.end);
  }

  return activities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    const duration = a.moving_time || a.elapsed_time || 0;
    return duration >= 20 * 60; // 20 minutes en secondes
  });
}

/**
 * Trouve le co-éliminé d'un joueur
 */
function findCoEliminated(athleteId, eliminationRound) {
  if (!frozenResultsCache?.rounds) return null;
  const roundData = frozenResultsCache.rounds[String(eliminationRound)];
  if (!roundData?.eliminations) return null;

  const coElim = roundData.eliminations.find(e => String(e.id) !== String(athleteId));
  return coElim?.id || null;
}

/**
 * Calcule le D+ d'un éliminé depuis son élimination
 */
function getEliminatedElevationSince(athleteId, eliminationRound) {
  const roundDates = getRoundDates(eliminationRound);
  const startDate = new Date(roundDates.end);
  startDate.setDate(startDate.getDate() + 1);

  const activities = allActivities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    return new Date(a.start_date) >= startDate;
  });

  return activities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
}

/**
 * Récupère les activités d'un éliminé depuis son élimination
 */
function getEliminatedActivities(athleteId, eliminationRound) {
  const roundDates = getRoundDates(eliminationRound);
  const startDate = new Date(roundDates.end);
  startDate.setDate(startDate.getDate() + 1);

  return allActivities.filter(a => {
    if (String(a.athlete?.id || a.athlete_id) !== String(athleteId)) return false;
    return new Date(a.start_date) >= startDate;
  });
}

// ============================================
// RENDU: HISTORIQUE
// ============================================

function renderHistorySection(container) {
  const completedSeasons = [];
  for (let s = 1; s < currentSeasonNumber; s++) {
    const summary = getSeasonSummary(allActivities, s, getCurrentDate());
    if (summary.isComplete) completedSeasons.push(summary);
  }

  container.innerHTML = `<div class="history-controls">
    <label>Saison : </label>
    <select id="seasonSelect" class="season-select">
      <option value="current">Saison ${currentSeasonNumber} (en cours)</option>
      ${completedSeasons.map(s => `<option value="${s.seasonNumber}">Saison ${s.seasonNumber} - ${s.winner?.name || 'N/A'} 🏆</option>`).join('')}
    </select>
  </div>
  <div id="historyContent"></div>`;

  const select = document.getElementById('seasonSelect');
  const content = document.getElementById('historyContent');

  const renderSeasonHistory = (seasonNum) => {
    if (seasonNum === 'current') {
      renderCurrentSeasonHistory(content);
    } else {
      const summary = getSeasonSummary(allActivities, parseInt(seasonNum), getCurrentDate());
      renderCompletedSeasonHistory(content, summary);
    }
  };

  select.addEventListener('change', (e) => renderSeasonHistory(e.target.value));
  renderSeasonHistory('current');
}

/**
 * Affiche l'historique de la saison en cours avec détails
 * Utilise les résultats figés (frozen_results) comme source de vérité
 */
function renderCurrentSeasonHistory(container) {
  if (!seasonData?.eliminated?.length && !seasonData?.roundResults?.length) {
    container.innerHTML = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
    return;
  }

  const roundsPerSeason = getRoundsPerSeason();
  let html = '';

  // Parcourir les rounds terminés
  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (currentSeasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    const today = getCurrentDate();

    // Round pas encore terminé ?
    if (today <= roundDates.end) continue;

    // Récupérer les éliminés de ce round (pour savoir s'il y en a)
    const roundEliminated = seasonData.eliminated.filter(e => e.eliminatedRound === r);
    if (roundEliminated.length === 0) continue;

    // Essayer d'utiliser les données figées (source de vérité)
    const frozenRound = getFrozenRound(globalRound);

    if (frozenRound && frozenRound.frozen) {
      // Utiliser les données figées
      html += renderFrozenRoundHistory(r, frozenRound);
    } else {
      // Fallback: recalculer (uniquement si pas de frozen results)
      html += renderCalculatedRoundHistory(r, globalRound, roundDates, roundEliminated);
    }
  }

  if (!html) {
    html = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
  }

  container.innerHTML = html;
}

/**
 * Fallback: génère le HTML en recalculant (utilisé uniquement si frozen results non disponible)
 */
function renderCalculatedRoundHistory(roundInSeason, globalRound, roundDates, roundEliminated) {
  // Calculer le classement de ce round pour avoir les D+
  const roundActivities = filterByPeriod(allActivities, roundDates.start, roundDates.end);
  const activeAtRound = PARTICIPANTS.filter(p =>
    !seasonData.eliminated.some(e => e.eliminatedRound < roundInSeason && e.id === p.id)
  );
  const ranking = calculateRanking(roundActivities, activeAtRound);
  const rankingWithEffects = applyJokerEffects(ranking, globalRound, roundActivities);

  // Trouver le DERNIER non-éliminé (celui qui s'est maintenu de justesse)
  const nonEliminatedEntries = rankingWithEffects.filter(e =>
    !roundEliminated.some(elim => elim.id === e.participant.id)
  );
  const lastSurvivor = nonEliminatedEntries[nonEliminatedEntries.length - 1];
  const lastSurvivorElevation = lastSurvivor?.totalElevation || 0;

  // Construire la liste des éliminés avec leur écart par rapport au maintien
  const eliminatedDetails = roundEliminated.map(elim => {
    const elimEntry = rankingWithEffects.find(e => e.participant.id === elim.id);
    const elimElevation = elimEntry?.totalElevation || 0;
    const gap = lastSurvivorElevation - elimElevation;
    const isZeroElim = elimElevation === 0;
    return {
      name: elim.name,
      elevation: elimElevation,
      gap: gap,
      isZeroElim: isZeroElim
    };
  }).sort((a, b) => b.elevation - a.elevation);

  // Compter les éliminations à 0 D+
  const zeroElimCount = eliminatedDetails.filter(e => e.isZeroElim).length;

  // Récupérer les jokers actifs ce round
  const activeJokers = getActiveJokersForRound(globalRound);

  // Identifier le rescapé
  const rescapeIdx = rankingWithEffects.length - roundEliminated.length - 1;
  const isFinale = roundInSeason === getRoundsPerSeason();

  // Calculer les mainPoints pour les éliminés de ce round
  const elimsBeforeThisRound = seasonData.eliminated.filter(e => e.eliminatedRound < roundInSeason).length;
  const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;

  // Générer le HTML du classement pour le dropdown
  const rankingHtml = rankingWithEffects.map((entry, idx) => {
    const isEliminated = roundEliminated.some(e => e.id === entry.participant.id);
    const position = idx + 1;
    const isRescape = (idx === rescapeIdx) && !isFinale && roundEliminated.length > 0;

    // Calculer les points pour les éliminés
    let mainPts = 0;
    if (isEliminated) {
      const sameRoundElims = roundEliminated;
      const elimIdx = sameRoundElims.findIndex(e => e.id === entry.participant.id);
      const elimPosition = activeAtRoundStart - elimIdx;
      mainPts = getMainChallengePoints(Math.max(1, Math.min(elimPosition, PARTICIPANTS.length)));
    } else if (isFinale && position <= 3) {
      mainPts = getMainChallengePoints(position);
    }

    let pointsBadges = '';
    if (mainPts > 0) {
      pointsBadges += `<span class="history-pts-badge" title="Points challenge principal">${mainPts} pts</span>`;
    }
    if (isRescape) {
      const rescapeInfo = getRescapeInfoForRound(globalRound);
      if (rescapeInfo) {
        const streak = rescapeInfo.consecutive;
        const rescPts = rescapeInfo.points;
        if (streak === 1) {
          pointsBadges += `<span class="history-rescape-badge" title="1er jeton rescapé (pas de points encore)">🎫 rescapé</span>`;
        } else {
          pointsBadges += `<span class="history-rescape-badge has-points" title="Rescapé ×${streak} consécutif : +${rescPts} pts">🎫 rescapé ×${streak} (+${rescPts})</span>`;
        }
      } else {
        pointsBadges += `<span class="history-rescape-badge">🎫 rescapé</span>`;
      }
    }

    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''} ${isRescape ? 'rescape' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.participant.name}</span>
        <span class="history-elevation">${formatElevation(entry.totalElevation, false)}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
        ${pointsBadges}
      </div>
    `;
  }).join('');

  // Construire le HTML
  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Éliminé(s) :</span>
      ${eliminatedDetails.map(e => {
        if (e.isZeroElim) {
          return `<span class="eliminated-name eliminated-zero">${e.name}</span> <span class="eliminated-gap">(0 D+ - inactif)</span>`;
        } else {
          return `<span class="eliminated-name">${e.name}</span> <span class="eliminated-gap">(à ${formatElevation(e.gap, false)} du maintien)</span>`;
        }
      }).join(', ')}
    </div>
    ${zeroElimCount > 0 ? `<div class="history-zero-warning">⚠️ ${zeroElimCount} joueur${zeroElimCount > 1 ? 's' : ''} éliminé${zeroElimCount > 1 ? 's' : ''} pour inactivité (0 D+)</div>` : ''}`;

  // Afficher les jokers utilisés
  if (activeJokers.length > 0) {
    const jokerDescriptions = activeJokers.map(joker => {
      const targetEntry = joker.targetId ? rankingWithEffects.find(e => e.participant.id === joker.targetId) : null;

      switch(joker.jokerId) {
        case 'sabotage':
          const sabotageAmount = targetEntry?.jokerEffects?.bonuses?.sabotaged?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a saboté ${joker.targetName} (-${formatElevation(sabotageAmount, false)})`;
        case 'voleur':
          const stolenAmount = targetEntry?.jokerEffects?.bonuses?.stolen?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a volé ${joker.targetName} (-${formatElevation(stolenAmount, false)})`;
        case 'multiplicateur':
          const bonusAmount = rankingWithEffects.find(e => e.participant.id === joker.participantId)?.jokerEffects?.bonuses?.multiplier?.amount || 0;
          return `${joker.jokerIcon} ${joker.participantName} a utilisé le multiplicateur (+${formatElevation(bonusAmount, false)})`;
        case 'bouclier':
          return `${joker.jokerIcon} ${joker.participantName} a utilisé le bouclier (protection)`;
        default:
          return `${joker.jokerIcon} ${joker.participantName} a utilisé ${joker.jokerName}`;
      }
    });

    html += `<div class="history-jokers">
      <span class="history-label">Jokers :</span> ${jokerDescriptions.join(' • ')}
    </div>`;
  }

  // Afficher les bonus éphémères utilisés ce round
  const bonusesUsed = getBonusesUsedInRound(globalRound);
  if (bonusesUsed.length > 0) {
    const bonusDescriptions = bonusesUsed.map(bonus => getBonusHistoryDescription(bonus));

    html += `<div class="history-bonuses">
      <span class="history-label">Bonus éphémères :</span> ${bonusDescriptions.join(' • ')}
    </div>`;
  }

  // Note indiquant que ce sont des données recalculées
  html += `<div class="history-note" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 8px; font-style: italic;">
    ⚡ Données recalculées (round non figé)
  </div>`;

  // Ajouter le dropdown du classement (caché par défaut)
  html += `
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement du round</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

/**
 * Génère le HTML pour le classement final du Challenge des Éliminés (saisons terminées)
 */
function renderCompletedEliminatedChallenge(summary) {
  // Utiliser eliminatedRanking qui est déjà calculé par getSeasonSummary
  if (!summary.eliminatedRanking?.length) return '';

  const seasonNumber = summary.seasonNumber;

  // Générer le HTML
  let html = `
    <div class="history-item history-eliminated-challenge">
      <div class="history-round-header" onclick="toggleRoundDetails('eliminated-s${seasonNumber}')">
        <div class="history-round">👻 Challenge des Éliminés - Classement Final</div>
        <span class="history-toggle-icon">▼</span>
      </div>
      <div class="history-ranking-dropdown" id="ranking-eliminated-s${seasonNumber}" style="display: block;">
        <div class="history-ranking-list eliminated-challenge-list">
  `;

  summary.eliminatedRanking.forEach((entry, idx) => {
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';
    const rankClass = idx < 3 ? 'top-three' : '';
    const name = entry.participant?.name || 'Inconnu';
    const elimRound = entry.eliminatedRound || '?';
    const elevation = entry.totalElevation || 0;
    const points = entry.points || 0;

    html += `
      <div class="history-ranking-row eliminated-row ${rankClass}">
        <span class="history-rank">${medal || (idx + 1)}</span>
        <div class="history-name-block">
          <span class="history-name">${name}</span>
          <span class="history-elim-round">Éliminé R${elimRound}</span>
        </div>
        <span class="history-elevation">${formatElevation(elevation, false)}</span>
        <span class="history-points ${points > 0 ? 'has-points' : ''}">${points > 0 ? `+${points} pts` : '-'}</span>
      </div>
    `;
  });

  html += `
        </div>
      </div>
    </div>
  `;

  return html;
}

/**
 * Affiche l'historique d'une saison terminée (avec tous les détails)
 * Utilise les résultats figés (frozen_results) comme source de vérité
 */
function renderCompletedSeasonHistory(container, summary) {
  const roundsPerSeason = getRoundsPerSeason();


  let html = `<div class="history-season-summary"><h3>🏆 Champion : ${summary.winner?.name || 'N/A'}</h3></div>`;

  summary.rounds.forEach(r => {
    const globalRound = r.globalRound;

    // Essayer de récupérer les données figées
    const frozenRound = getFrozenRound(globalRound);

    if (frozenRound && frozenRound.frozen) {
      // Utiliser les données figées (source de vérité)
      html += renderFrozenRoundHistory(r.roundInSeason, frozenRound);
    } else {
      // Fallback: pas de données figées, affichage minimal
      if (!r.eliminated.length) {
        html += `<div class="history-item">
          <div class="history-round">Round ${r.roundInSeason}</div>
          <div class="history-title">Aucun éliminé</div>
        </div>`;
      } else {
        html += `<div class="history-item">
          <div class="history-round">Round ${r.roundInSeason}</div>
          <div class="history-eliminated">
            <span class="history-label">Éliminé(s) :</span> ${r.eliminated.join(', ')}
          </div>
          <div class="history-note" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 8px;">
            ⚠️ Détails non disponibles (round non figé)
          </div>
        </div>`;
      }
    }
  });

  // Ajouter le classement final du Challenge des Éliminés
  if (summary.eliminatedRanking?.length > 0) {
    html += renderCompletedEliminatedChallenge(summary);
  }

  container.innerHTML = html;
}

/**
 * Génère le HTML pour un round à partir des données figées
 */
/**
 * Rendu de l'historique d'un round ÉQUIPE figé
 */
function renderFrozenTeamRoundHistory(roundInSeason, frozenRound) {
  const globalRound = frozenRound.roundNumber;
  const teams = frozenRound.teams || [];
  const eliminations = frozenRound.eliminations || [];
  const eliminatedIds = new Set(eliminations.map(e => e.id));

  // Trouver l'équipe éliminée
  const eliminatedTeam = teams.find(t => t.members.some(m => eliminatedIds.has(m.id)));
  const eliminatedTeamName = eliminatedTeam?.color?.name || 'Dernière';

  // Construire le HTML du classement par équipe
  const sortedTeams = [...teams].sort((a, b) => b.totalElevation - a.totalElevation);

  const rankingHtml = sortedTeams.map((team, idx) => {
    const isElimTeam = team === eliminatedTeam || (eliminatedTeam && team.index === eliminatedTeam.index);
    const teamColor = team.color || TEAM_COLORS[idx % TEAM_COLORS.length];
    const position = idx + 1;

    const membersHtml = team.members
      .sort((a, b) => (b.elevation || 0) - (a.elevation || 0))
      .map(m => {
        const isElim = eliminatedIds.has(m.id);
        const pts = m.mainPoints || 0;
        const ptsHtml = pts > 0 ? ` <span class="history-pts-badge">${pts} pts</span>` : '';
        return `<div class="history-ranking-row ${isElim ? 'eliminated' : ''}" style="padding-left: 24px;">
          <span class="history-name">${m.name || '?'}</span>
          <span class="history-elevation">${formatElevation(m.elevation || 0, false)}</span>
          ${isElim ? '<span class="history-elim-badge">Éliminé</span>' : ''}${ptsHtml}
        </div>`;
      }).join('');

    return `<div class="history-team-block ${isElimTeam ? 'eliminated' : ''}" style="border-left: 3px solid ${teamColor.border};">
      <div class="history-team-header">
        <span class="history-rank">#${position}</span>
        <span style="color: ${teamColor.border}; font-weight: 600;">Équipe ${teamColor.name}</span>
        <span class="history-elevation">${formatElevation(team.totalElevation || 0, false)}</span>
        ${isElimTeam ? '<span class="history-elim-badge">Éliminée</span>' : ''}
      </div>
      ${membersHtml}
    </div>`;
  }).join('');

  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">🤝 Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Équipe éliminée :</span>
      <span class="eliminated-name">${eliminatedTeamName}</span>
      <span class="eliminated-gap">(${eliminations.map(e => e.name).join(', ')})</span>
    </div>
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement des équipes</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

function renderFrozenRoundHistory(roundInSeason, frozenRound) {
  const globalRound = frozenRound.roundNumber;

  // Si c'est un round de saison équipe avec des données teams, afficher en mode équipe
  if (frozenRound.teams && frozenRound.teams.length > 0) {
    return renderFrozenTeamRoundHistory(roundInSeason, frozenRound);
  }

  // Extraire les données du frozen round
  const ranking = frozenRound.ranking || [];
  const eliminations = frozenRound.eliminations || [];
  const jokersUsed = frozenRound.jokersUsed || [];

  if (eliminations.length === 0) {
    return `<div class="history-item">
      <div class="history-round">Round ${roundInSeason}</div>
      <div class="history-title">Aucun éliminé</div>
    </div>`;
  }

  // Trouver le dernier survivant (pour calculer l'écart)
  const eliminatedIds = new Set(eliminations.map(e => e.id));
  const survivors = ranking.filter(r => !eliminatedIds.has(r.id));
  const lastSurvivor = survivors[survivors.length - 1];
  const lastSurvivorElevation = lastSurvivor?.elevation || 0;

  // Construire les détails des éliminés
  const eliminatedDetails = eliminations.map(elim => {
    const gap = lastSurvivorElevation - (elim.elevation || 0);
    const isZeroElim = elim.zeroElimination || elim.elevation === 0;
    return {
      name: elim.name,
      elevation: elim.elevation || 0,
      gap: gap,
      isZeroElim: isZeroElim
    };
  }).sort((a, b) => b.elevation - a.elevation);

  // Compter les éliminations à 0 D+
  const zeroElimCount = eliminatedDetails.filter(e => e.isZeroElim).length;

  // Récupérer les bonus utilisés ce round pour calculer les effets
  const roundBonuses = getBonusesUsedInRound(globalRound);

  // Identifier le rescapé = dernier survivant (dernier non-éliminé du classement)
  const survivorEntries = ranking.filter(e => !eliminatedIds.has(e.id));
  const rescapeEntry = survivorEntries.length > 0 ? survivorEntries[survivorEntries.length - 1] : null;
  const rescapeId = rescapeEntry ? String(rescapeEntry.id) : null;
  const isFinaleRound = frozenRound.roundInSeason === getRoundsPerSeason();
  const rescapeInfo = getRescapeInfoForRound(globalRound);

  // Générer le HTML du classement pour le dropdown avec pilules bonus
  const rankingHtml = ranking.map((entry, idx) => {
    const isEliminated = eliminatedIds.has(entry.id);
    const position = idx + 1;
    const isRescape = (String(entry.id) === rescapeId) && !isFinaleRound && eliminations.length > 0;

    // Points gagnés par cet athlète dans ce round
    const mainPts = entry.mainPoints || 0;

    // Construire les badges de points
    let pointsBadges = '';
    if (mainPts > 0) {
      pointsBadges += `<span class="history-pts-badge" title="Points challenge principal">${mainPts} pts</span>`;
    }
    if (isRescape && rescapeInfo) {
      const streak = rescapeInfo.consecutive;
      const rescPts = rescapeInfo.points;
      if (streak === 1) {
        pointsBadges += `<span class="history-rescape-badge" title="1er jeton rescapé (pas de points encore)">🎫 rescapé</span>`;
      } else {
        pointsBadges += `<span class="history-rescape-badge has-points" title="Rescapé ×${streak} consécutif : +${rescPts} pts">🎫 rescapé ×${streak} (+${rescPts})</span>`;
      }
    } else if (isRescape) {
      pointsBadges += `<span class="history-rescape-badge">🎫 rescapé</span>`;
    }

    // Calculer les pilules de bonus éphémères pour ce joueur
    let bonusPills = '';
    for (const bonus of roundBonuses) {
      const result = bonus.effect_result;
      if (!result) continue;

      const entryId = String(entry.id);

      // Dans l'historique du challenge principal, on affiche les effets sur les ACTIFS

      // Embuscade - la victime (joueur actif) perd du D+
      if (bonus.bonus_id === 'embuscade' && String(bonus.target_athlete_id) === entryId) {
        const amount = result.stolenElevation || 0;
        if (amount > 0) {
          bonusPills += `<span class="bonus-tag ephemeral-stolen" title="Embuscade par ${bonus.athlete_name}">🏹 -${formatElevation(amount, false)} m</span>`;
        }
      }

      // Ravitaillement - la cible (joueur actif) gagne du D+
      if (bonus.bonus_id === 'ravitaillement' && String(bonus.target_athlete_id) === entryId) {
        const amount = result.bonusElevation || 0;
        if (amount > 0) {
          bonusPills += `<span class="bonus-tag ephemeral-gained" title="Ravitaillement de ${bonus.athlete_name}">🍖 +${formatElevation(amount, false)} m</span>`;
        }
      }

      // Note: marquage, malédiction, kamikaze sont entre éliminés, pas dans le challenge principal
    }

    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''} ${isRescape ? 'rescape' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.name}</span>
        <span class="history-elevation">${formatElevation(entry.elevation || 0, false)}${bonusPills ? ` ${bonusPills}` : ''}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
        ${pointsBadges}
      </div>
    `;
  }).join('');

  // Construire le HTML complet
  let html = `<div class="history-item" data-round="${globalRound}">
    <div class="history-round-header" onclick="toggleRoundDetails(${globalRound})">
      <div class="history-round">Round ${roundInSeason}</div>
      <span class="history-toggle-icon">▼</span>
    </div>
    <div class="history-eliminated">
      <span class="history-label">Éliminé(s) :</span>
      ${eliminatedDetails.map(e => {
        if (e.isZeroElim) {
          return `<span class="eliminated-name eliminated-zero">${e.name}</span> <span class="eliminated-gap">(0 D+ - inactif)</span>`;
        } else {
          return `<span class="eliminated-name">${e.name}</span> <span class="eliminated-gap">(à ${formatElevation(e.gap, false)} du maintien)</span>`;
        }
      }).join(', ')}
    </div>
    ${zeroElimCount > 0 ? `<div class="history-zero-warning">⚠️ ${zeroElimCount} joueur${zeroElimCount > 1 ? 's' : ''} éliminé${zeroElimCount > 1 ? 's' : ''} pour inactivité</div>` : ''}`;

  // Afficher les jokers utilisés
  if (jokersUsed.length > 0) {
    const jokerDescriptions = jokersUsed.map(joker => {
      const jokerType = JOKER_TYPES[joker.jokerId];
      const jokerIcon = jokerType?.icon || '🃏';
      const participantName = joker.athleteName || joker.participantName || 'Inconnu';
      const targetName = joker.targetName || 'Inconnu';

      // Chercher les effets dans le ranking
      const targetEntry = ranking.find(e => e.id === joker.targetId);
      const participantEntry = ranking.find(e => e.id === joker.athleteId);

      switch(joker.jokerId) {
        case 'sabotage':
          const sabotageAmount = targetEntry?.sabotageReceived?.amount || 0;
          return `${jokerIcon} ${participantName} a saboté ${targetName} (-${formatElevation(sabotageAmount, false)})`;
        case 'voleur':
          const stolenAmount = targetEntry?.theftReceived?.amount || 0;
          return `${jokerIcon} ${participantName} a volé ${targetName} (-${formatElevation(stolenAmount, false)})`;
        case 'multiplicateur':
          const bonusAmount = participantEntry?.multiplierBonus || 0;
          return `${jokerIcon} ${participantName} a utilisé le multiplicateur (+${formatElevation(bonusAmount, false)})`;
        case 'bouclier':
          return `${jokerIcon} ${participantName} a utilisé le bouclier (protection)`;
        default:
          return `${jokerIcon} ${participantName} a utilisé un joker`;
      }
    });

    html += `<div class="history-jokers">
      <span class="history-label">Jokers :</span> ${jokerDescriptions.join(' • ')}
    </div>`;
  }

  // Afficher les bonus éphémères utilisés ce round
  const bonusesUsed = getBonusesUsedInRound(globalRound);
  if (bonusesUsed.length > 0) {
    const bonusDescriptions = bonusesUsed.map(bonus => getBonusHistoryDescription(bonus));

    html += `<div class="history-bonuses">
      <span class="history-label">Bonus éphémères :</span> ${bonusDescriptions.join(' • ')}
    </div>`;
  }

  // Ajouter le dropdown du classement (caché par défaut)
  html += `
    <div class="history-ranking-dropdown" id="ranking-${globalRound}" style="display: none;">
      <div class="history-ranking-title">📊 Classement du round</div>
      <div class="history-ranking-list">
        ${rankingHtml}
      </div>
    </div>
  </div>`;

  return html;
}

// ============================================
// GESTION DES ÉVÉNEMENTS JOKERS
// ============================================

// ============================================
// INITIALISATION
// ============================================

// État du polling
let lastActivitiesCount = 0;
let lastModified = null;
let pollingInterval = null;

async function init() {

  const loadingScreen = document.getElementById('loadingScreen');

  try {
    // Charger les participants depuis l'API (mode 2026) ou utiliser la liste statique (mode démo)
    await loadParticipants();

    if (PARTICIPANTS.length === 0) {
      console.error('❌ Aucun participant chargé !');
      if (loadingScreen) {
        loadingScreen.innerHTML = `
          <div class="loading-content">
            <div class="loading-icon">⚠️</div>
            <div class="loading-title">Aucun participant</div>
            <div class="loading-text">Aucun participant inscrit pour le moment.<br>Inscrivez-vous sur la page d'inscription.</div>
            <a href="inscription.html" style="margin-top:20px;color:var(--accent-primary);text-decoration:none;padding:10px 20px;border:1px solid var(--accent-primary);border-radius:8px;">→ S'inscrire</a>
            <button onclick="location.reload()" style="margin-top:12px;background:transparent;border:1px solid rgba(255,255,255,0.3);color:white;padding:8px 16px;border-radius:6px;cursor:pointer;">↻ Réessayer</button>
          </div>
        `;
      }
      return;
    }


    // Charger les résultats figés AVANT tout calcul
    await loadFrozenResults();

    // Charger les règles spéciales manuelles
    await loadSpecialRulesOverrides();

    // Charger les bonus éphémères
    await loadBonuses();

    // Initialiser les jokers (AWAIT AJOUTÉ - important pour charger avant le calcul)
    await initializeJokersState();

    // Charger les données
    await loadActivities();

    // Initialiser le compteur pour le polling
    lastActivitiesCount = allActivities.length;

    // Initialiser le mode démo si slider présent
    if (document.getElementById('dateSliderContainer')) {
      initDemoMode({
        onDateChange: () => renderAll(),
        showSlider: true,
        enableRightClick: false // Géré séparément pour les jokers
      });
    }

    // Premier rendu
    renderAll();

    // Démarrer le polling automatique (sauf en mode démo)
    if (!CHALLENGE_CONFIG.isDemo) {
      startAutoRefresh();
    }


  } catch (error) {
    console.error('❌ Erreur d\'initialisation:', error);
    if (loadingScreen) {
      loadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="loading-icon">❌</div>
          <div class="loading-title">Erreur de connexion</div>
          <div class="loading-text">Impossible de charger les données.<br>Vérifiez votre connexion internet.</div>
          <button onclick="location.reload()" style="margin-top:20px;background:var(--accent-primary);border:none;color:white;padding:12px 24px;border-radius:8px;cursor:pointer;font-weight:600;">↻ Réessayer</button>
        </div>
      `;
    }
  }
}

/**
 * Polling automatique pour détecter les nouvelles activités
 */
function startAutoRefresh() {
  const POLLING_INTERVAL = 180000; //3 min


  pollingInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/activities-status/${CHALLENGE_CONFIG.leagueId}`);
      if (!response.ok) return;

      const status = await response.json();

      // Vérifier si les données ont changé
      if (status.count !== lastActivitiesCount || status.lastModified !== lastModified) {

        // Afficher une notification si nouvelle activité
        if (status.count > lastActivitiesCount && status.lastActivity) {
          updateTickerWithNewActivity(status.lastActivity);
        }

        // Mettre à jour les compteurs
        lastActivitiesCount = status.count;
        lastModified = status.lastModified;

        // Recharger les données et rafraîchir
        await loadActivities();
        renderAll();

      }
    } catch (error) {
      // Silencieux - on ne veut pas spammer la console
    }
  }, POLLING_INTERVAL);
}

/**
 * Affiche le bandeau ticker des activités récentes (aujourd'hui + hier)
 * Desktop: en bas de page (fixed)
 * Mobile: dans la nav sticky
 */
function renderActivityTicker() {
  // Récupérer les activités des dernières 48h
  const now = getCurrentDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const recentActivities = allActivities
    .filter(a => {
      const actDate = new Date(a.start_date_local || a.start_date);
      return actDate >= yesterday;
    })
    .sort((a, b) => new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date));

  // Ajouter les styles du ticker
  injectTickerStyles();

  // Générer le contenu du ticker
  let tickerContent = '';

  if (recentActivities.length === 0) {
    tickerContent = `
      <div class="ticker-track">
        <span class="ticker-item ticker-no-activity">Aucune activité dans les dernières 48h • En attente de nouvelles sorties...</span>
      </div>
    `;
  } else {
    // Générer les items du ticker
    const tickerItems = recentActivities.map(activity => {
      const date = new Date(activity.start_date_local || activity.start_date);
      const isToday = date.toDateString() === now.toDateString();
      const dateStr = isToday ? "Auj." : "Hier";
      const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const athleteName = activity.athlete_name || getParticipantById(activity.athlete_id)?.name || 'Inconnu';
      const sportIcon = getSportIcon(activity.sport_type || activity.type);
      const elevation = Math.round(activity.total_elevation_gain || 0);

      return `<span class="ticker-item">
        <span class="ticker-date">${dateStr} ${timeStr}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-athlete">${athleteName}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-activity">${truncateText(activity.name, 20)}</span>
        <span class="ticker-sep">•</span>
        <span class="ticker-sport">${sportIcon}</span>
        <span class="ticker-elev">+${elevation}m</span>
        <span class="ticker-div">│</span>
      </span>`;
    }).join('');

    // Tripler le contenu pour boucle infinie seamless
    const fullContent = tickerItems + tickerItems + tickerItems;
    tickerContent = `<div class="ticker-track">${fullContent}</div>`;
  }

  // Appliquer aux deux tickers (mobile et desktop)
  const tickerMobile = document.getElementById('activityTickerMobile');
  const tickerDesktop = document.getElementById('activityTickerDesktop');

  if (tickerMobile) tickerMobile.innerHTML = tickerContent;
  if (tickerDesktop) tickerDesktop.innerHTML = tickerContent;

  // Calculer la durée d'animation
  const itemCount = recentActivities.length;
  const duration = Math.max(30, itemCount * 8);

  // Appliquer la durée aux deux tracks
  [tickerMobile, tickerDesktop].forEach(ticker => {
    if (ticker) {
      const track = ticker.querySelector('.ticker-track');
      if (track) track.style.animationDuration = `${duration}s`;
    }
  });
}

/**
 * Tronque un texte à une longueur maximale
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '…' : text;
}

/**
 * Retourne l'icône correspondant au type de sport
 * Modifie cette fonction pour changer les emojis
 */
function getSportIcon(sportType) {
  const icons = {
    'Run': '👟',
    'TrailRun': '⛰️',
    'Hike': '🥾',
    'Walk': '🚶',
    'Ride': '🚴',
    'MountainBikeRide': '🚵',
    'GravelRide': '🚴',
    'BackcountrySki': '⛷️',
    'NordicSki': '🎿',
    'Snowshoe': '❄️'
  };
  return icons[sportType] || '👟';
}

/**
 * Injecte les styles CSS du ticker
 */
function injectTickerStyles() {
  if (document.getElementById('ticker-styles')) return;

  const style = document.createElement('style');
  style.id = 'ticker-styles';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');

    /* Base commune */
    .activity-ticker {
      width: 100%;
      height: 22px;
      background: #0a0a0a;
      overflow: hidden;
      font-family: 'VT323', 'Courier New', monospace;
      display: flex;
      align-items: center;
    }

    /* Desktop: fixed en bas de page */
    .activity-ticker-desktop {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 9999;
      border-top: 1px solid #f97316;
    }

    /* Mobile: dans la nav, caché par défaut sur desktop */
    .activity-ticker-mobile {
      border-bottom: 1px solid #f97316;
      display: none;
    }

    /* Responsive: inverser l'affichage sur mobile */
    @media (max-width: 768px) {
      .activity-ticker-desktop {
        display: none;
      }

      .activity-ticker-mobile {
        display: flex;
        height: 20px;
      }
    }

    /* Padding body pour ne pas cacher le contenu par le ticker desktop */
    @media (min-width: 769px) {
      body {
        padding-bottom: 24px;
      }
    }

    .ticker-track {
      display: inline-flex;
      align-items: center;
      height: 100%;
      white-space: nowrap;
      animation: ticker-scroll 60s linear infinite;
      transform: translateX(-25%);
      line-height: 22px;
    }

    @keyframes ticker-scroll {
      0% {
        transform: translateX(-25%);
      }
      100% {
        transform: translateX(-58.33%);
      }
    }

    .ticker-track:hover {
      animation-play-state: paused;
    }

    .ticker-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 14px;
      letter-spacing: 0.3px;
      line-height: 1;
    }

    .ticker-date {
      color: #f97316;
      font-weight: bold;
    }

    .ticker-sep {
      color: #555;
      margin: 0 2px;
    }

    .ticker-athlete {
      color: #22d3ee;
      font-weight: bold;
    }

    .ticker-activity {
      color: #d4d4d4;
    }

    .ticker-sport {
      font-size: 11px;
      line-height: 1;
    }

    .ticker-elev {
      color: #10b981;
      font-weight: bold;
    }

    .ticker-div {
      color: #333;
      margin: 0 10px;
      font-size: 14px;
    }

    .ticker-no-activity {
      color: #666;
      padding: 0 20px;
      font-size: 13px;
    }

    /* Mobile adjustments */
    @media (max-width: 768px) {
      .ticker-track {
        line-height: 20px;
      }

      .ticker-item {
        font-size: 12px;
        gap: 3px;
      }

      .ticker-div {
        margin: 0 6px;
      }

      .ticker-sport {
        font-size: 10px;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Met à jour le ticker quand de nouvelles activités arrivent
 */
function updateTickerWithNewActivity(activity) {
  // Simplement re-render le ticker complet
  renderActivityTicker();
}

// ============================================
// ÉVÉNEMENTS DOM
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('loginBtn')?.addEventListener('click', () => {
    window.location.href = 'login.html';
  });
});

// ============================================
// API PUBLIQUE
// ============================================

export function setAdminMode(enabled) {
  isAdminMode = enabled;
}

// Fonction pour toggle le dropdown du classement d'un round
function toggleRoundDetails(globalRound) {
  const dropdown = document.getElementById(`ranking-${globalRound}`);
  const historyItem = dropdown?.closest('.history-item');
  const toggleIcon = historyItem?.querySelector('.history-toggle-icon');

  if (dropdown) {
    const isVisible = dropdown.style.display !== 'none';
    dropdown.style.display = isVisible ? 'none' : 'block';

    if (toggleIcon) {
      toggleIcon.textContent = isVisible ? '▼' : '▲';
      toggleIcon.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  }
}

// Exposer globalement pour les onclick dans le HTML
window.toggleRoundDetails = toggleRoundDetails;

window.versant = {
  getCurrentDate,
  setSimulatedDate,
  refresh: renderAll,
  useJoker: jokerUse,
  addJoker,
  removeJoker,
  getJokerStock,
  setAdminMode,
  getActiveJokersForRound,
  toggleRoundDetails
};