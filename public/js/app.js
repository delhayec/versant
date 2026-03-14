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
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getGlobalRoundNumber, isFinaleRound, isValidSport,
  getRoundsPerSeason, getMainChallengePoints, getEliminatedChallengePoints,
  getAthleteColor, getAthleteInitials, loadParticipants,
  getEligibleParticipants, getLateRegistrations, wasRegisteredBeforeStart
} from './config.js';

import {
  initializeJokersState, saveJokersState, useJoker as jokerUse,
  addJoker, removeJoker, resetJokers, applyJokerEffects,
  getJokerStock, getActiveJokersForRound, getJokerStatusForRound
} from './jokers.js';

import {
  formatElevation, formatPosition,
  renderCombinedBanner, renderActiveJokersSection, renderRanking,
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

// ============================================
// CHARGEMENT DES RÉSULTATS FIGÉS
// ============================================
async function loadFrozenResults() {
  try {
    const response = await fetch('/api/frozen-results');
    if (response.ok) {
      frozenResultsCache = await response.json();
      console.log(`❄️ ${Object.keys(frozenResultsCache.rounds || {}).length} rounds figés chargés`);
    }
  } catch (error) {
    console.warn('⚠️ Impossible de charger les résultats figés:', error);
    frozenResultsCache = { rounds: {} };
  }
}

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
    console.log(`🎫 Rescapé du round ${previousRound}: ${rescapeEntry.name || rescapeEntry.id}`);
    return String(rescapeEntry.id);
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

  console.log(`⏳ Challenge en attente - début dans ${daysUntilStart} jours`);
}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================

async function loadActivities() {
  // Déterminer le mode (démo vs production)
  const isDemo = CHALLENGE_CONFIG.isDemo || window.location.pathname.includes('demo');
  const dataFile = '/data/all_activities_2025.json';
  const leagueId = CHALLENGE_CONFIG.leagueId;

  console.log(`📡 Chargement activités - Mode: ${isDemo ? 'DEMO' : 'PRODUCTION'}, League: ${leagueId}`);

  // En mode DEMO, charger directement le fichier local 2025
  if (isDemo) {
    console.log('🎮 Mode démo: chargement fichier local 2025...');
    try {
      const localResponse = await fetch(dataFile);
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);
        console.log(`📊 ${allActivities.length} activités chargées (démo: ${dataFile})`);

        if (allActivities.length > 0) {
          const dates = allActivities.map(a => a.start_date?.substring(0, 10)).filter(Boolean);
          const uniqueDates = [...new Set(dates)].sort().reverse();
          console.log(`📅 Dates: ${uniqueDates.slice(0, 5).join(', ')} ...`);
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
      console.log(`📊 ${allActivities.length} activités chargées (API: ${leagueId})`);
      console.log(`📅 Dates récentes: ${uniqueDates.slice(0, 5).join(', ')}`);

      // Vérifier les activités du round actuel
      const today = new Date();
      const roundStart = new Date(CHALLENGE_CONFIG.yearStartDate);
      console.log(`📆 Round commence: ${roundStart.toISOString().substring(0, 10)}`);
      console.log(`📆 Aujourd'hui: ${today.toISOString().substring(0, 10)}`);

      const recentActivities = allActivities.filter(a => {
        const d = new Date(a.start_date);
        return d >= roundStart;
      });
      console.log(`🎯 Activités depuis début challenge: ${recentActivities.length}`);
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
        console.log(`📊 ${allActivities.length} activités (fichier local)`);
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

// ============================================
// SIMULATION DES ÉLIMINATIONS
// ============================================

function simulateSeasonEliminations(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);

  // TOUS les participants (éligibles + tardifs) pour le calcul du nombre de rounds
  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Inscriptions tardives = éliminées d'office au Round 1 (comptent dans le quota)
  const lateRegistrations = getLateRegistrations();

  // Calculer le nombre MAXIMUM de rounds (basé sur TOUS les participants)
  const maxRoundsPerSeason = Math.ceil((PARTICIPANTS.length - 1) / CHALLENGE_CONFIG.eliminationsPerRound);

  for (let roundInSeason = 1; roundInSeason <= maxRoundsPerSeason; roundInSeason++) {
    // VÉRIFICATION: Si plus qu'un seul joueur actif, la saison est finie
    if (active.length <= 1) {
      break;
    }

    const globalRound = (seasonNumber - 1) * maxRoundsPerSeason + roundInSeason;
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
      console.log(`❄️ Round ${globalRound} - Utilisation des résultats figés`);

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
        console.log(`📋 Round ${globalRound}: ${zeroElevationPlayers.length} joueurs à 0 D+ → tous éliminés`);
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
              console.log(`⚠️ ${p.name} - Inscription tardive → éliminé d'office au R1`);
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

    // Calcul des points pour TOUS les participants
    PARTICIPANTS.forEach(p => {
      const elim = sData.eliminated.find(e => e.id === p.id);
      let mainPts = 0, elimPts = 0;

      if (elim) {
        // RÈGLE DE POINTS:
        // Position = nombre d'actifs au début du round - index dans les éliminés
        // Les éliminés sont triés du pire au meilleur (dernier du classement = index 0)
        // Donc: dernier → position la plus basse, avant-dernier → position légèrement meilleure
        const elimsBeforeThisRound = countEliminationsBeforeRound(sData.eliminated, elim.eliminatedRound);
        const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;

        // Trouver tous les éliminés du même round
        const sameRoundElims = sData.eliminated.filter(e => e.eliminatedRound === elim.eliminatedRound);
        const indexInRound = sameRoundElims.findIndex(e => e.id === elim.id);

        // Position = actifs au début - index (dernier = position la plus basse)
        const position = activeAtRoundStart - indexInRound;
        mainPts = getMainChallengePoints(Math.max(1, Math.min(position, PARTICIPANTS.length)));
        elimPts = elimPointsMap[p.id] || 0;
      } else if (sData.winner?.id === p.id) {
        mainPts = getMainChallengePoints(1);
        totals[p.id].wins++;
      } else if (sData.seasonComplete) {
        mainPts = getMainChallengePoints(2);
      }

      if (sData.seasonComplete || elim) {
        totals[p.id].totalMainPoints += mainPts;
        if (sData.seasonComplete) {
          totals[p.id].totalEliminatedPoints += elimPts;
          totals[p.id].totalPoints += mainPts + elimPts;
          totals[p.id].seasonsPlayed++;
        } else {
          totals[p.id].totalPoints += mainPts;
        }
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
    console.log('🎨 renderAll - début');
    const today = getCurrentDate();
    console.log('📅 Date:', today);

    // Vérifier si le challenge a commencé
    const challengeStart = new Date(CHALLENGE_CONFIG.yearStartDate);
    if (today < challengeStart) {
      renderWaitingScreen(challengeStart);
      return;
    }

    currentSeasonNumber = getSeasonNumber(today);
    console.log('🏆 Saison:', currentSeasonNumber);

    currentRoundNumber = getGlobalRoundNumber(today);
    console.log('🔢 Round:', currentRoundNumber);

    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);
    console.log('📊 seasonData:', seasonData);

    yearlyStandingsCache = calculateYearlyStandings(allActivities, today);
    console.log('📈 yearlyStandings calculés');

    // Banner
    const seasonBanner = document.getElementById('seasonBanner');
    console.log('🏷️ seasonBanner element:', seasonBanner ? 'trouvé' : 'non trouvé');
    if (seasonBanner) {
      renderCombinedBanner(seasonBanner, {
        currentSeasonNumber,
        currentRoundNumber,
        seasonData,
        currentDate: today
      });
      console.log('✅ Banner rendu');
    }

    // Jokers actifs
    console.log('🃏 Jokers actifs - début');
    let jokersSection = document.getElementById('activeJokersSection');
    if (!jokersSection) {
      const rankingContainer = document.getElementById('rankingContainer');
      if (rankingContainer?.parentElement) {
        jokersSection = document.createElement('div');
        jokersSection.id = 'activeJokersSection';
        jokersSection.className = 'active-jokers-section';
        rankingContainer.parentElement.insertBefore(jokersSection, rankingContainer);
      }
    }
    if (jokersSection) {
      // Calculer le classement actuel pour l'affichage des duels
      const roundDates = getRoundDates(currentRoundNumber);
      const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
      const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
      const ranking = calculateRanking(roundActivities, seasonData?.active || []);

      renderActiveJokersSection(jokersSection, {
        currentRoundNumber,
        ranking
      });
      console.log('✅ Jokers actifs rendus');
    }

    // Classement
    console.log('📋 Classement - début');
    const rankingContainer = document.getElementById('rankingContainer');
    console.log('📋 rankingContainer:', rankingContainer ? 'trouvé' : 'non trouvé');
    if (rankingContainer) {
      console.log('📋 Calcul du classement...');
      const roundDates = getRoundDates(currentRoundNumber);
      const endDate = today < new Date(roundDates.end) ? today : roundDates.end;

      // DEBUG: Afficher les dates exactes
      console.log(`📆 Round ${currentRoundNumber}: ${roundDates.start.toISOString().substring(0,10)} → ${roundDates.end.toISOString().substring(0,10)}`);
      console.log(`📆 Filtrage jusqu'à: ${endDate instanceof Date ? endDate.toISOString().substring(0,10) : endDate}`);
      console.log(`📊 Total activités disponibles: ${allActivities.length}`);

      const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
      console.log('📋 Activités du round:', roundActivities.length);

      // DEBUG: Si pas d'activités, montrer pourquoi
      if (roundActivities.length === 0 && allActivities.length > 0) {
        const sampleDates = allActivities.slice(0, 5).map(a => a.start_date?.substring(0,10));
        console.warn('⚠️ Aucune activité dans la période! Exemples de dates disponibles:', sampleDates);
      }

      let ranking = calculateRanking(roundActivities, seasonData?.active || []);
      console.log('📋 Ranking calculé:', ranking.length, 'participants');

      ranking = applyJokerEffects(ranking, currentRoundNumber);
      console.log('📋 Effets jokers appliqués');

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

      renderRanking(rankingContainer, {
        ranking,
        seasonData,
        currentSeasonNumber,
        seasonStats,
        eliminationsCount: elimCount,
        currentRoundNumber,
        rescapeId
      });
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
      console.log('✅ Guide jokers rendu');
    }

    // Ticker des activités récentes
    renderActivityTicker();
    console.log('✅ Ticker activités rendu');

    console.log('🎨 renderAll - fin, masquage du loader...');

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
      console.log('✅ Loader masqué');
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

  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ cumulé</div><div>Éliminé</div><div>Points</div></div>';
  ranking.forEach(e => {
    html += `<div class="ranking-row">
      <div class="ranking-position">${e.position}</div>
      <div class="ranking-athlete">
        <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <div class="athlete-info">
          <span class="athlete-name">${e.participant.name}</span>
          <span class="athlete-status eliminated">${e.daysSinceElimination}j depuis élim.</span>
        </div>
      </div>
      <div class="ranking-elevation">${formatElevation(e.totalElevation, false)} <span class="elevation-unit">m</span></div>
      <div class="ranking-round">R${e.eliminatedRound}</div>
      <div class="ranking-points"><span class="points-badge">${e.points} pts</span></div>
    </div>`;
  });
  container.innerHTML = html;
}

// ============================================
// RENDU: CLASSEMENT GÉNÉRAL
// ============================================

function renderFinalStandings(container) {
  const activeIds = new Set((seasonData?.active || []).map(p => p.id));
  const standings = yearlyStandingsCache || [];

  let html = '<div class="standings-header"><div>Rang</div><div>Athlète</div><div>Pts Principal</div><div>Pts Éliminés</div><div>Total</div></div>';
  standings.forEach(e => {
    const isActive = activeIds.has(e.participant.id);
    const wins = e.wins > 0 ? `<span class="wins-badge">🏆×${e.wins}</span>` : '';
    html += `<div class="standings-row ${isActive ? '' : 'eliminated'}">
      <div class="standings-rank">${e.rank}</div>
      <div class="standings-athlete">
        <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <span>${e.participant.name}</span>${wins}${isActive ? '<span class="active-badge">En course</span>' : ''}
      </div>
      <div class="standings-points main">${e.totalMainPoints || '-'}</div>
      <div class="standings-points elim">${e.totalEliminatedPoints || '-'}</div>
      <div class="standings-total">${e.totalPoints}</div>
    </div>`;
  });
  container.innerHTML = html;
}

// ============================================
// RENDU: PARTICIPANTS (GRILLE)
// ============================================

function renderParticipantsGrid(container, today) {
  const roundDates = getRoundDates(currentRoundNumber);
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const ranking = calculateRanking(roundActivities, seasonData?.active || []);
  const posMap = {};
  ranking.forEach(e => posMap[e.participant.id] = e);

  let html = '';
  PARTICIPANTS.forEach(p => {
    const isElim = seasonData?.eliminated?.some(e => e.id === p.id);
    const elimData = seasonData?.eliminated?.find(e => e.id === p.id);
    const entry = posMap[p.id] || { totalElevation: 0, position: '-' };
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, today), p.id));

    // Utiliser getJokerStatusForRound pour avoir le stock correct (comme le tableau)
    const status = getJokerStatusForRound(p.id, currentRoundNumber);
    const stock = status.stock;

    const jokersHtml = Object.entries(stock)
      .filter(([jId, c]) => c > 0 && JOKER_TYPES[jId])
      .map(([jId, c]) => {
        const isActive = status.active.some(j => j.jokerId === jId);
        const isPending = status.pending.some(j => j.jokerId === jId);
        let badgeClass = isActive ? 'active' : isPending ? 'pending' : '';
        return `<span class="joker-badge ${badgeClass}" title="${JOKER_TYPES[jId].name}: ${c} restant(s)">${JOKER_TYPES[jId].icon}<sub>${c}</sub></span>`;
      })
      .join('') || '<span class="no-jokers">Aucun</span>';

    html += `<div class="participant-card ${isElim ? 'eliminated' : ''}" data-participant-id="${p.id}" data-participant-name="${p.name}">
      <div class="participant-header">
        <div class="participant-avatar" style="background:linear-gradient(135deg,${getAthleteColor(p.id)},${getAthleteColor(p.id)}88)">${getAthleteInitials(p.id)}</div>
        <div>
          <div class="participant-name">${p.name}</div>
          <div class="athlete-status ${isElim ? 'eliminated' : 'active'}">${isElim ? 'Éliminé R'+elimData?.eliminatedRound : formatPosition(entry.position)}</div>
        </div>
      </div>
      <div class="participant-stats">
        <div class="stat-item"><div class="stat-value">${formatElevation(entry.totalElevation || 0, false)}</div><div class="stat-label">D+ round</div></div>
        <div class="stat-item"><div class="stat-value">${formatElevation(seasonStats.elevation || 0, false)}</div><div class="stat-label">D+ saison</div></div>
      </div>
      <div class="participant-jokers">${jokersHtml}</div>
    </div>`;
  });
  container.innerHTML = html;

  // Context menu pour les participants
  container.querySelectorAll('.participant-card').forEach(card => {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const participantId = card.dataset.participantId;
      const participant = getParticipantById(participantId);
      if (participant) {
        showContextMenu(e, participantId, participant.name, {
          isAdmin: isAdminMode,
          currentRoundNumber
        });
      }
    });
  });
}

// ============================================
// RENDU: SECTION ARSENAL (JOKERS & BONUS)
// ============================================

async function renderArsenalSection(container, roundNumber) {
  // Récupérer les jokers actifs ce round
  const activeJokers = getActiveJokersForRound(roundNumber);

  // Enrichir avec les noms des joueurs
  const enrichedJokers = activeJokers.map(joker => {
    const athlete = getParticipantById(joker.athleteId);
    const target = joker.targetId ? getParticipantById(joker.targetId) : null;
    return {
      ...joker,
      joker_id: joker.jokerId,
      athlete_name: athlete?.name || 'Joueur',
      target_athlete_name: target?.name || null
    };
  });

  // Récupérer les bonus éphémères depuis l'API
  let bonuses = [];
  try {
    const res = await fetch('/api/bonuses/all');
    if (res.ok) {
      const allBonuses = await res.json();
      bonuses = allBonuses.map(b => {
        const athlete = getParticipantById(b.athlete_id);
        const target = b.target_id ? getParticipantById(b.target_id) : null;
        const bonusType = BONUS_TYPES?.[b.bonus_id];
        return {
          ...b,
          athlete_name: athlete?.name || 'Joueur',
          target_athlete_name: target?.name || null,
          bonus_name: bonusType?.name || b.bonus_id,
          icon: bonusType?.icon || '🎁',
          status: b.used_at ? 'used' : b.activated_at ? 'active' : 'available'
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

  renderArsenal(container, {
    activeJokers: enrichedJokers,
    bonuses,
    currentRoundNumber: roundNumber
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

  // Générer le HTML du classement pour le dropdown
  const rankingHtml = rankingWithEffects.map((entry, idx) => {
    const isEliminated = roundEliminated.some(e => e.id === entry.participant.id);
    const position = idx + 1;
    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.participant.name}</span>
        <span class="history-elevation">${formatElevation(entry.totalElevation, false)}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
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

  console.log('📜 renderCompletedSeasonHistory - summary:', summary);
  console.log('📜 eliminatedRanking:', summary.eliminatedRanking);

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
function renderFrozenRoundHistory(roundInSeason, frozenRound) {
  const globalRound = frozenRound.roundNumber;

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

  // Générer le HTML du classement pour le dropdown
  const rankingHtml = ranking.map((entry, idx) => {
    const isEliminated = eliminatedIds.has(entry.id);
    const position = idx + 1;
    return `
      <div class="history-ranking-row ${isEliminated ? 'eliminated' : ''}">
        <span class="history-rank">${position}</span>
        <span class="history-name">${entry.name}</span>
        <span class="history-elevation">${formatElevation(entry.elevation || 0, false)}</span>
        ${isEliminated ? '<span class="history-elim-badge">Éliminé</span>' : ''}
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

function setupJokerEvents() {
  // DÉSACTIVÉ sur la page principale
  // Les jokers ne peuvent être utilisés que depuis le dashboard personnel (dashboard.html)
  console.log('ℹ️ Gestion des jokers désactivée sur la page principale. Utilisez votre dashboard personnel.');
}

function handleJokerMenuClick(item) {
  const jokerId = item.dataset.joker;
  const participantId = item.dataset.participant;
  const participantName = item.dataset.name;

  hideContextMenu();

  // Reset
  if (item.dataset.action === 'reset') {
    if (resetJokers(participantId)) {
      showNotification('Jokers réinitialisés !', 'success');
      renderAll();
    }
    return;
  }

  // Jokers avec cible
  if (['duel', 'sabotage'].includes(jokerId)) {
    showTargetSelectionModal({
      participantId,
      jokerId,
      participants: seasonData?.active || PARTICIPANTS,
      onSelect: ({ targetId, targetName }) => {
        const result = jokerUse(participantId, jokerId, currentRoundNumber, getCurrentDate(), {
          targetId,
          targetName
        });

        if (result.success) {
          showNotification(`${jokerId === 'duel' ? '⚔️ Duel' : '💣 Sabotage'} programmé contre ${targetName} !`, 'success');
          renderAll();
        } else {
          showNotification(result.error, 'error');
        }
      }
    });
    return;
  }

  // Jokers sans cible
  const result = jokerUse(participantId, jokerId, currentRoundNumber, getCurrentDate());

  if (result.success) {
    showNotification(`Joker programmé pour le round ${result.activationRound} !`, 'success');
    renderAll();
  } else {
    showNotification(result.error, 'error');
  }
}

// ============================================
// INITIALISATION
// ============================================

// État du polling
let lastActivitiesCount = 0;
let lastModified = null;
let pollingInterval = null;

async function init() {
  console.log('◭️ Versant - Initialisation...');

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

    console.log(`📋 ${PARTICIPANTS.length} participants actifs`);

    // Charger les résultats figés AVANT tout calcul
    await loadFrozenResults();

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

    // Events jokers
    setupJokerEvents();

    // Premier rendu
    renderAll();

    // Démarrer le polling automatique (sauf en mode démo)
    if (!CHALLENGE_CONFIG.isDemo) {
      startAutoRefresh();
    }

    console.log('✅ Versant initialisé');

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
  const POLLING_INTERVAL = 30000; // 30 secondes

  console.log('🔄 Auto-refresh activé (toutes les 30s)');

  pollingInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/activities-status/${CHALLENGE_CONFIG.leagueId}`);
      if (!response.ok) return;

      const status = await response.json();

      // Vérifier si les données ont changé
      if (status.count !== lastActivitiesCount || status.lastModified !== lastModified) {
        console.log(`🔔 Changement détecté! ${lastActivitiesCount} → ${status.count} activités`);

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

        console.log('✅ Affichage mis à jour');
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