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
  CHALLENGE_CONFIG, PARTICIPANTS, ROUND_RULES,
  getParticipantById, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getGlobalRoundNumber, isFinaleRound, isValidSport
} from './config.js';

import {
  initializeJokersState, saveJokersState, useJoker as jokerUse,
  addJoker, removeJoker, resetJokers, applyJokerEffects,
  getJokerStock, getActiveJokersForRound
} from './jokers.js';

import {
  renderCombinedBanner, renderActiveJokersSection, renderRanking,
  renderParticipants, renderJokersGuide, showNotification,
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
// CHARGEMENT DES DONNÉES
// ============================================

async function loadActivities() {
  try {
    const response = await fetch(`/api/activities?year=${CHALLENGE_CONFIG.dataYear}`);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const data = await response.json();
    allActivities = parseActivitiesData(data);
    console.log(`📊 ${allActivities.length} activités chargées`);
    return allActivities;
  } catch (error) {
    console.warn('⚠️ Erreur chargement API, tentative fichier local...');
    try {
      const localResponse = await fetch('/data/classement.json');
      if (localResponse.ok) {
        const localData = await localResponse.json();
        allActivities = parseActivitiesData(localData);
        console.log(`📊 ${allActivities.length} activités (fichier local)`);
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
  return activities.filter(a => String(a.athlete?.id) === String(participantId));
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
// CLASSEMENT ANNUEL
// ============================================

function calculateYearlyStandings(activities, currentDate) {
  const standings = {};
  const totalSeasons = Math.floor(365 / (Math.ceil((PARTICIPANTS.length - 1) / CHALLENGE_CONFIG.eliminationsPerRound) * CHALLENGE_CONFIG.roundDurationDays));
  
  PARTICIPANTS.forEach(p => {
    standings[p.id] = {
      participant: p,
      totalPoints: 0,
      seasonResults: [],
      totalElevation: 0
    };
  });
  
  // Calculer pour chaque saison passée
  for (let season = 1; season <= totalSeasons; season++) {
    const seasonDates = getSeasonDates(season);
    if (currentDate < seasonDates.start) break;
    
    const seasonActivities = filterByPeriod(activities, seasonDates.start, 
      currentDate < seasonDates.end ? currentDate : seasonDates.end);
    
    // TODO: Calculer les points de chaque participant pour cette saison
  }
  
  return Object.values(standings).sort((a, b) => b.totalPoints - a.totalPoints);
}

// ============================================
// RENDU PRINCIPAL
// ============================================

function renderAll() {
  try {
    console.log('🎨 renderAll - début');
    const today = getCurrentDate();
    console.log('📅 Date:', today);
    
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
      const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
      console.log('📋 Activités du round:', roundActivities.length);
      
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
    const participantsContainer = document.getElementById('participantsContainer');
    if (participantsContainer) {
      const seasonDates = getSeasonDates(currentSeasonNumber);
      const endDate = today < new Date(seasonDates.end) ? today : seasonDates.end;
      const stats = {};
      PARTICIPANTS.forEach(p => {
        stats[p.id] = calculateStats(
          filterByParticipant(filterByPeriod(allActivities, seasonDates.start, endDate), p.id)
        );
      });
      
      renderParticipants(participantsContainer, {
        participants: PARTICIPANTS,
        stats,
        currentRoundNumber
      });
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
// GESTION DES ÉVÉNEMENTS JOKERS
// ============================================

function setupJokerEvents() {
  // Clic droit sur les lignes de classement et cartes participants
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ranking-row, .participant-card');
    if (!row) return;
    
    const participantId = row.dataset.participantId;
    const participant = getParticipantById(participantId);
    if (!participant) return;
    
    const menu = showContextMenu(e, participantId, participant.name, {
      isAdmin: isAdminMode,
      currentRoundNumber
    });
    
    // Gestion des clics sur les items du menu
    menu.querySelectorAll('.context-menu-item:not(.disabled):not(.admin-joker)').forEach(item => {
      item.onclick = () => handleJokerMenuClick(item);
    });
    
    // Mode admin - boutons +/-
    menu.querySelectorAll('.joker-plus').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const item = btn.closest('.admin-joker');
        if (addJoker(item.dataset.participant, item.dataset.joker)) {
          const countEl = item.querySelector('.joker-count');
          countEl.textContent = parseInt(countEl.textContent) + 1;
          showNotification('Joker ajouté !', 'success');
          renderAll();
        }
      };
    });
    
    menu.querySelectorAll('.joker-minus').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const item = btn.closest('.admin-joker');
        if (removeJoker(item.dataset.participant, item.dataset.joker)) {
          const countEl = item.querySelector('.joker-count');
          countEl.textContent = Math.max(0, parseInt(countEl.textContent) - 1);
          showNotification('Joker retiré !', 'success');
          renderAll();
        }
      };
    });
  });
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

async function init() {
  console.log('🏔️ Versant - Initialisation...');
  
  // Initialiser les jokers
  initializeJokersState();
  
  // Charger les données
  await loadActivities();
  
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
  
  console.log('✅ Versant initialisé');
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
