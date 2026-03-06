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
  CHALLENGE_CONFIG, PARTICIPANTS, ROUND_RULES, JOKER_TYPES,
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getGlobalRoundNumber, isFinaleRound, isValidSport,
  getRoundsPerSeason, getMainChallengePoints, getEliminatedChallengePoints,
  getAthleteColor, getAthleteInitials, loadParticipants
} from './config.js';

import {
  initializeJokersState, saveJokersState, useJoker as jokerUse,
  addJoker, removeJoker, resetJokers, applyJokerEffects,
  getJokerStock, getActiveJokersForRound, getJokerStatusForRound
} from './jokers.js';

import {
  formatElevation, formatPosition,
  renderCombinedBanner, renderActiveJokersSection, renderRanking,
  renderJokersGuide, showNotification,
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
  let active = [...PARTICIPANTS];
  const eliminated = [];
  const roundResults = [];

  // Calculer le nombre MAXIMUM de rounds (basé sur élimination standard de 2 par round)
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
      // CALCULER LES RÉSULTATS (round non figé - nouvelles règles)
      const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
      const ranking = calculateRanking(roundActivities, active);

      // Appliquer les effets des jokers
      const rankingWithEffects = applyJokerEffects(ranking, globalRound);

      // NOUVELLES RÈGLES D'ÉLIMINATION:
      // - Cas normal: Éliminer les 2 derniers du classement
      // - Exception: Si ≥2 joueurs à 0 D+ → Éliminer SEULEMENT ces joueurs (pas 2 en plus)
      // - Finale: Éliminer tous sauf 1
      const toEliminate = [];

      // 1. Identifier tous les joueurs à 0 D+ (sauf bouclier)
      const zeroElevationPlayers = rankingWithEffects.filter(entry =>
        entry.totalElevation === 0 && !entry.jokerEffects?.hasShield
      );

      // 2. Déterminer si c'est une finale (dynamique selon les actifs restants)
      const isCurrentRoundFinale = active.length <= CHALLENGE_CONFIG.eliminationsPerRound + 1;

      if (isCurrentRoundFinale) {
        // FINALE: Éliminer tous sauf 1
        for (let i = rankingWithEffects.length - 1; i >= 0 && toEliminate.length < active.length - 1; i--) {
          const entry = rankingWithEffects[i];
          if (entry.jokerEffects?.hasShield) continue;
          toEliminate.push({
            ...entry.participant,
            zeroElimination: entry.totalElevation === 0
          });
        }
      } else if (zeroElevationPlayers.length >= 2) {
        // EXCEPTION: ≥2 joueurs à 0 D+ → Éliminer SEULEMENT ces joueurs
        zeroElevationPlayers.forEach(entry => {
          toEliminate.push({
            ...entry.participant,
            zeroElimination: true
          });
        });
      } else {
        // CAS NORMAL: Éliminer les 2 derniers
        for (let i = rankingWithEffects.length - 1; i >= 0 && toEliminate.length < CHALLENGE_CONFIG.eliminationsPerRound; i--) {
          const entry = rankingWithEffects[i];
          if (entry.jokerEffects?.hasShield) continue;
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
          zeroElimination: p.zeroElimination || false
        });
        active = active.filter(a => a.id !== p.id);
      });

      roundResults.push({
        round: roundInSeason,
        status: 'completed',
        ranking: rankingWithEffects,
        eliminated: toEliminate.map(p => p.id),
        zeroEliminations: zeroElevationPlayers.length
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

  PARTICIPANTS.forEach(p => {
    totals[p.id] = {
      participant: p,
      totalMainPoints: 0,
      totalEliminatedPoints: 0,
      totalPoints: 0,
      wins: 0,
      seasonsPlayed: 0
    };
  });

  for (let s = 1; s <= currentSeason; s++) {
    const seasonDates = getSeasonDates(s);
    if (currentDate < seasonDates.start) continue;

    const sData = simulateSeasonEliminations(activities, s, currentDate);
    const elimRanking = calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate);
    const elimPointsMap = {};
    elimRanking.forEach(e => elimPointsMap[e.participant.id] = e.points);

    PARTICIPANTS.forEach(p => {
      const elim = sData.eliminated.find(e => e.id === p.id);
      let mainPts = 0, elimPts = 0;

      if (elim) {
        // RÈGLE DE POINTS avec nouvelles règles:
        // Position = nombre d'actifs au début du round d'élimination
        // - Si éliminé pour 0 D+ (quand ≥2 à 0) → tous la même dernière position
        // - Sinon → positions N, N-1, etc.
        
        const elimsBeforeThisRound = countEliminationsBeforeRound(sData.eliminated, elim.eliminatedRound);
        const activeAtRoundStart = PARTICIPANTS.length - elimsBeforeThisRound;
        
        // Trouver tous les éliminés du même round
        const sameRoundElims = sData.eliminated.filter(e => e.eliminatedRound === elim.eliminatedRound);
        
        // Compter les 0 D+ de ce round
        const zeroElimsThisRound = sameRoundElims.filter(e => e.zeroElimination);
        
        if (elim.zeroElimination && zeroElimsThisRound.length >= 2) {
          // Tous les 0 D+ éliminés ensemble → dernière position
          mainPts = getMainChallengePoints(activeAtRoundStart);
        } else {
          // Élimination normale ou 0 D+ seul parmi les 2 derniers
          const normalElims = sameRoundElims.filter(e => !e.zeroElimination || zeroElimsThisRound.length < 2);
          const indexInRound = normalElims.findIndex(e => e.id === elim.id);
          
          // Position basée sur l'index dans les éliminés normaux
          const position = activeAtRoundStart - (normalElims.length - 1 - indexInRound);
          mainPts = getMainChallengePoints(Math.max(1, Math.min(position, PARTICIPANTS.length)));
        }
        elimPts = elimPointsMap[p.id] || 0;
      } else if (sData.winner?.id === p.id) {
        mainPts = getMainChallengePoints(1);
        totals[p.id].wins++;
      } else if (sData.seasonComplete) {
        mainPts = getMainChallengePoints(2);
      }

            if (sData.seasonComplete || elim) {
        totals[p.id].totalMainPoints += mainPts;
        // Points éliminés uniquement attribués en fin de saison
        if (sData.seasonComplete) {
          totals[p.id].totalEliminatedPoints += elimPts;
          totals[p.id].totalPoints += mainPts + elimPts;
          totals[p.id].seasonsPlayed++;
        } else {
          // Saison en cours : seulement les points du challenge principal
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

      renderRanking(rankingContainer, {
        ranking,
        seasonData,
        currentSeasonNumber,
        seasonStats,
        eliminationsCount: elimCount,
        currentRoundNumber
      });
    }

    // Participants (cards)
    const participantsGrid = document.getElementById('participantsGrid');
    if (participantsGrid) {
      renderParticipantsGrid(participantsGrid, today);
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

    // Récupérer les éliminés de ce round
    const roundEliminated = seasonData.eliminated.filter(e => e.eliminatedRound === r);
    if (roundEliminated.length === 0) continue;

    // Calculer le classement de ce round pour avoir les D+
    const roundActivities = filterByPeriod(allActivities, roundDates.start, roundDates.end);
    const activeAtRound = PARTICIPANTS.filter(p =>
      !seasonData.eliminated.some(e => e.eliminatedRound < r && e.id === p.id)
    );
    const ranking = calculateRanking(roundActivities, activeAtRound);
    const rankingWithEffects = applyJokerEffects(ranking, globalRound, roundActivities);

    // Trouver le DERNIER non-éliminé (celui qui s'est maintenu de justesse)
    // Le classement est trié par D+ décroissant, donc on cherche depuis la fin
    const nonEliminatedEntries = rankingWithEffects.filter(e =>
      !roundEliminated.some(elim => elim.id === e.participant.id)
    );
    // Le dernier de la liste des non-éliminés = celui qui s'est maintenu de justesse
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
    }).sort((a, b) => b.elevation - a.elevation); // Trier par D+ décroissant

    // Compter les éliminations à 0 D+
    const zeroElimCount = eliminatedDetails.filter(e => e.isZeroElim).length;

    // Récupérer les jokers actifs ce round
    const activeJokers = getActiveJokersForRound(globalRound);

    // Construire le HTML
    html += `<div class="history-item">
      <div class="history-round">Round ${r}</div>
      <div class="history-eliminated">
        <span class="history-label">Éliminé(s) :</span>
        ${eliminatedDetails.map(e => {
          if (e.isZeroElim) {
            return `<span class="eliminated-name eliminated-zero">${e.name}</span> <span class="eliminated-gap">(0 D+ - inactif)</span>`;
          } else {
            return `<span class="eliminated-name">${e.name}</span> <span class="eliminated-gap">(${formatElevation(e.elevation, false)} D+, à ${formatElevation(e.gap, false)} du maintien)</span>`;
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

    html += `</div>`;
  }

  if (!html) {
    html = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
  }

  container.innerHTML = html;
}

/**
 * Affiche l'historique d'une saison terminée
 */
function renderCompletedSeasonHistory(container, summary) {
  let html = `<div class="history-season-summary"><h3>🏆 Champion : ${summary.winner?.name || 'N/A'}</h3></div>`;

  summary.rounds.forEach(r => {
    if (!r.eliminated.length) {
      html += `<div class="history-item">
        <div class="history-round">Round ${r.roundInSeason}</div>
        <div class="history-title">Aucun éliminé</div>
      </div>`;
      return;
    }

    // Pour les saisons passées, on affiche une version simplifiée
    html += `<div class="history-item">
      <div class="history-round">Round ${r.roundInSeason}</div>
      <div class="history-eliminated">
        <span class="history-label">Éliminé(s) :</span> ${r.eliminated.join(', ')}
      </div>
    </div>`;
  });

  container.innerHTML = html;
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

    // Initialiser les jokers
    initializeJokersState();

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
          showNewActivityNotification(status.lastActivity);
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
 * Affiche une notification pour une nouvelle activité
 */
function showNewActivityNotification(activity) {
  const notification = document.createElement('div');
  notification.className = 'new-activity-notification';
  notification.innerHTML = `
    <div class="notification-icon">🏃</div>
    <div class="notification-content">
      <div class="notification-title">Nouvelle activité !</div>
      <div class="notification-text">${activity.athlete_name || 'Un participant'} vient d'ajouter "${activity.name}"</div>
    </div>
  `;
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: linear-gradient(135deg, rgba(34, 211, 238, 0.95), rgba(168, 85, 247, 0.95));
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    z-index: 10000;
    animation: slideIn 0.3s ease-out;
    max-width: 350px;
  `;

  // Ajouter les styles d'animation si pas déjà présents
  if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
      .new-activity-notification .notification-icon {
        font-size: 24px;
      }
      .new-activity-notification .notification-title {
        font-weight: 600;
        font-size: 14px;
      }
      .new-activity-notification .notification-text {
        font-size: 12px;
        opacity: 0.9;
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(notification);

  // Retirer après 5 secondes
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease-in forwards';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
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

window.versant = {
  getCurrentDate,
  setSimulatedDate,
  refresh: renderAll,
  useJoker: jokerUse,
  addJoker,
  removeJoker,
  getJokerStock,
  setAdminMode,
  getActiveJokersForRound
};