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
  getJokerStock, getActiveJokersForRound
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
  // Déterminer quel fichier charger selon la page
  const isDemo = window.location.pathname.includes('demo');
  const dataFile = isDemo ? '/data/all_activities_2025.json' : '/data/classement.json';
  const leagueId = CHALLENGE_CONFIG.leagueId;

  console.log(`📡 Chargement activités - League: ${leagueId}`);

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
    console.warn('⚠️ Tentative fichier local:', dataFile);
    try {
      const localResponse = await fetch(dataFile);
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);
        console.log(`📊 ${allActivities.length} activités (fichier local: ${dataFile})`);
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

  const roundsPerSeason = Math.ceil((PARTICIPANTS.length - 1) / CHALLENGE_CONFIG.eliminationsPerRound);

  for (let roundInSeason = 1; roundInSeason <= roundsPerSeason; roundInSeason++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + roundInSeason;
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

    // Round terminé - calculer les éliminations
    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    const ranking = calculateRanking(roundActivities, active);

    // Appliquer les effets des jokers
    const rankingWithEffects = applyJokerEffects(ranking, globalRound);

    // Éliminer les derniers (sauf bouclier)
    const elimCount = isFinaleRound(roundInSeason) ? active.length - 1 : CHALLENGE_CONFIG.eliminationsPerRound;
    const toEliminate = [];

    for (let i = rankingWithEffects.length - 1; i >= 0 && toEliminate.length < elimCount; i--) {
      const entry = rankingWithEffects[i];
      // Protégé par un bouclier ?
      if (entry.jokerEffects?.hasShield) continue;
      toEliminate.push(entry.participant);
    }

    toEliminate.forEach(p => {
      eliminated.push({ ...p, eliminatedRound: roundInSeason, eliminatedSeason: seasonNumber });
      active = active.filter(a => a.id !== p.id);
    });

    roundResults.push({
      round: roundInSeason,
      status: 'completed',
      ranking: rankingWithEffects,
      eliminated: toEliminate.map(p => p.id)
    });

    // Finale ?
    if (active.length <= 1) {
      return {
        seasonComplete: true,
        winner: active[0] || null,
        active,
        eliminated,
        roundResults
      };
    }
  }

  return {
    seasonComplete: false,
    active,
    eliminated,
    roundResults
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
        mainPts = getMainChallengePoints(PARTICIPANTS.length - sData.eliminated.findIndex(e => e.id === p.id));
        elimPts = elimPointsMap[p.id] || 0;
      } else if (sData.winner?.id === p.id) {
        mainPts = getMainChallengePoints(1);
        totals[p.id].wins++;
      } else if (sData.seasonComplete) {
        mainPts = getMainChallengePoints(2);
      }

      if (sData.seasonComplete || elim) {
        totals[p.id].totalMainPoints += mainPts;
        totals[p.id].totalEliminatedPoints += elimPts;
        totals[p.id].totalPoints += mainPts + elimPts;
        if (sData.seasonComplete) totals[p.id].seasonsPlayed++;
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

    // Masquer le loader avec transition
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      setTimeout(() => { loadingScreen.style.display = 'none'; }, 300);
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
    const stock = getJokerStock(p.id);
    const jokersHtml = Object.entries(stock)
      .filter(([jId, c]) => c > 0 && JOKER_TYPES[jId])
      .map(([jId, c]) => `<span class="joker-badge" title="${JOKER_TYPES[jId].name}: ${c}">${JOKER_TYPES[jId].icon}<sub>${c}</sub></span>`)
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
      if (!seasonData?.eliminated?.length) {
        content.innerHTML = '<div class="history-item"><div class="history-title">Aucune élimination encore</div></div>';
        return;
      }
      const byRound = {};
      seasonData.eliminated.forEach(p => {
        const round = p.eliminatedRound;
        if (!byRound[round]) byRound[round] = [];
        byRound[round].push(p);
      });
      content.innerHTML = Object.keys(byRound).sort((a, b) => a - b).map(r =>
        `<div class="history-item"><div class="history-round">Round ${r}</div><div class="history-title">Éliminé(s) : ${byRound[r].map(p => p.name).join(', ')}</div></div>`
      ).join('');
    } else {
      const summary = getSeasonSummary(allActivities, parseInt(seasonNum), getCurrentDate());
      let h = `<div class="history-season-summary"><h3>🏆 Champion : ${summary.winner?.name || 'N/A'}</h3></div>`;
      summary.rounds.forEach(r => {
        h += `<div class="history-item">
          <div class="history-round">Round ${r.roundInSeason}</div>
          <div class="history-title">${r.eliminated.length ? 'Éliminé(s) : '+r.eliminated.join(', ') : 'Aucun éliminé'}</div>
        </div>`;
      });
      content.innerHTML = h;
    }
  };

  select.addEventListener('change', (e) => renderSeasonHistory(e.target.value));
  renderSeasonHistory('current');
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

  // Charger les participants depuis l'API (mode 2026) ou utiliser la liste statique (mode démo)
  await loadParticipants();
  
  if (PARTICIPANTS.length === 0) {
    console.error('❌ Aucun participant chargé !');
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
      loadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="loading-icon">⚠️</div>
          <div class="loading-title">Erreur</div>
          <div class="loading-text">Aucun participant inscrit.<br>Inscrivez-vous sur la page d'inscription.</div>
          <a href="inscription.html" style="margin-top:20px;color:var(--accent-primary);">→ Page d'inscription</a>
        </div>
      `;
    }
    return;
  }
  
  console.log(`📋 ${PARTICIPANTS.length} participants actifs`);

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