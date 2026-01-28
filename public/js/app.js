/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE UNIFIÉE
 * ============================================
 * Version améliorée avec :
 * - Menu contextuel pour les jokers (clic droit)
 * - Affichage des bonus (x2, duels, sabotages)
 * - Gestion complète du stock de jokers
 * - Section dédiée aux jokers actifs
 */

import {
  CHALLENGE_CONFIG, PARTICIPANTS, JOKER_TYPES, ROUND_RULES, AUTH_CONFIG,
  getParticipantById, getRoundInfo, getRoundDates, getSeasonNumber, getSeasonDates,
  getRoundInSeason, getRoundsPerSeason, getGlobalRoundNumber, isFinaleRound,
  getMainChallengePoints, getEliminatedChallengePoints, isValidSport, getTotalSeasons
} from './config.js';

// ============================================
// ÉTAT GLOBAL
// ============================================
let allActivities = [];
let currentRoundNumber = 1;
let currentSeasonNumber = 1;
let seasonData = null;
let yearlyStandingsCache = null;
let simulatedDate = null;
let jokersState = {};

// ============================================
// GESTION DE LA DATE SIMULÉE
// ============================================
export function setSimulatedDate(date) { simulatedDate = date ? new Date(date) : null; }
export function getCurrentDate() { return simulatedDate ? new Date(simulatedDate) : new Date(); }

// ============================================
// UTILITAIRES DE FORMATAGE
// ============================================
const formatDate = (date, opts = {}) => new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', ...opts });
const formatDateShort = (date) => formatDate(date, { month: 'short', year: undefined });
const formatElevation = (v, unit = true) => unit ? `${Math.round(v).toLocaleString('fr-FR')} m` : Math.round(v).toLocaleString('fr-FR');
const formatPosition = (p) => `${p}${p === 1 ? 'er' : 'e'}`;

function formatDateRange(start, end) {
  const s = new Date(start), e = new Date(end);
  if (s.getMonth() === e.getMonth()) return `${s.getDate()} - ${formatDate(e, { day: 'numeric', month: 'long', year: undefined })}`;
  return `${formatDateShort(s)} - ${formatDateShort(e)}`;
}

// ============================================
// COULEURS DES ATHLÈTES
// ============================================
const COLORS = ['#f97316', '#22d3ee', '#a855f7', '#10b981', '#f43f5e', '#eab308', '#3b82f6', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4', '#84cc16'];
const colorMap = {};
const getAthleteColor = (id) => colorMap[id] || (colorMap[id] = COLORS[Object.keys(colorMap).length % COLORS.length]);
const getAthleteInitials = (id) => {
  const p = getParticipantById(id);
  if (!p) return '?';
  const n = p.name.split(' ');
  return n.length >= 2 ? n[0][0] + n[1][0] : p.name.substring(0, 2).toUpperCase();
};

// ============================================
// GESTION DES JOKERS
// ============================================
function initializeJokersState() {
  jokersState = {};
  PARTICIPANTS.forEach(p => {
    let stock = { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };
    if (p.jokerStock) stock = p.jokerStock;
    else if (p.jokers_stock) stock = p.jokers_stock;
    else if (p.jokers && typeof p.jokers === 'object') stock = p.jokers;
    jokersState[p.id] = { stock: { ...stock }, used: [], active: [], pending: [] };
  });
  try { const saved = localStorage.getItem('versant_jokers_state'); if (saved) Object.assign(jokersState, JSON.parse(saved)); } catch (e) {}
  console.log('🃏 Jokers initialisés:', Object.keys(jokersState).length, 'participants');
}

function saveJokersState() { try { localStorage.setItem('versant_jokers_state', JSON.stringify(jokersState)); } catch (e) {} }
function getJokerStock(participantId) { return jokersState[participantId]?.stock || { duel: 0, multiplicateur: 0, bouclier: 0, sabotage: 0 }; }

// Utiliser un joker - activé pour le PROCHAIN round
function useJoker(participantId, jokerId, options = {}) {
  const state = jokersState[participantId];
  if (!state) return { success: false, error: 'Participant non trouvé' };
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) return { success: false, error: 'Joker inconnu' };
  if (!state.stock[jokerId] || state.stock[jokerId] <= 0) return { success: false, error: 'Plus de joker disponible' };

  state.stock[jokerId]--;
  const activationRound = currentRoundNumber + 1;
  const usage = {
    id: `${participantId}-${jokerId}-${activationRound}-${Date.now()}`,
    jokerId,
    jokerName: jokerType.name,
    round: activationRound,
    scheduledAt: currentRoundNumber,
    usedAt: getCurrentDate().toISOString(),
    ...options
  };
  state.pending.push(usage);
  state.used.push(usage);
  saveJokersState();
  return { success: true, usage, activationRound };
}

// Ajouter un joker (admin)
function addJoker(participantId, jokerId) {
  const state = jokersState[participantId];
  if (!state) return false;
  if (!JOKER_TYPES[jokerId]) return false;
  state.stock[jokerId] = (state.stock[jokerId] || 0) + 1;
  saveJokersState();
  return true;
}

// Retirer un joker (admin)
function removeJoker(participantId, jokerId) {
  const state = jokersState[participantId];
  if (!state) return false;
  if (!state.stock[jokerId] || state.stock[jokerId] <= 0) return false;
  state.stock[jokerId]--;
  saveJokersState();
  return true;
}

// Activer les jokers en attente pour ce round
function activatePendingJokers() {
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const toActivate = (state.pending || []).filter(j => j.round === currentRoundNumber);
    toActivate.forEach(j => {
      if (!state.active.some(a => a.id === j.id)) {
        state.active.push(j);
      }
      state.pending = state.pending.filter(p => p.id !== j.id);
    });
  });
  saveJokersState();
}

// Récupérer tous les jokers actifs pour ce round
function getActiveJokersForRound(roundNumber) {
  const activeJokers = [];
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const participant = getParticipantById(participantId);
    (state.active || []).filter(j => j.round === roundNumber).forEach(j => {
      activeJokers.push({
        ...j,
        participantId,
        participantName: participant?.name || 'Inconnu'
      });
    });
  });
  return activeJokers;
}

function applyJokerEffects(ranking) {
  // D'abord activer les jokers en attente
  activatePendingJokers();

  const effects = {};
  const activeJokers = getActiveJokersForRound(currentRoundNumber);

  activeJokers.forEach(joker => {
    const participant = ranking.find(r => String(r.participant.id) === String(joker.participantId));
    if (!participant) return;
    if (!effects[joker.participantId]) effects[joker.participantId] = { bonuses: {} };

    if (joker.jokerId === 'multiplicateur') {
      // x1.5 au lieu de x2
      const bonus = participant.totalElevation * 0.5;
      participant.totalElevation += bonus;
      effects[joker.participantId].bonuses.multiplier = { amount: bonus };
    } else if (joker.jokerId === 'duel') {
      const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (target) {
        // Duel : le gagnant vole 25% du D+ du perdant
        const challengerWins = participant.totalElevation > target.totalElevation;
        const winner = challengerWins ? participant : target;
        const loser = challengerWins ? target : participant;
        const stolen = Math.round(loser.totalElevation * 0.25);

        winner.totalElevation += stolen;
        loser.totalElevation -= stolen;

        if (challengerWins) {
          effects[joker.participantId].bonuses.duelWon = { amount: stolen, from: target.participant.name };
          if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
          effects[joker.targetId].bonuses.duelLost = { amount: stolen, by: participant.participant.name };
        } else {
          effects[joker.participantId].bonuses.duelLost = { amount: stolen, by: target.participant.name };
          if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
          effects[joker.targetId].bonuses.duelWon = { amount: stolen, from: participant.participant.name };
        }

        effects[joker.participantId].duel = {
          target: joker.targetName,
          targetId: joker.targetId,
          isChallenger: true,
          challengerElevation: participant.totalElevation,
          targetElevation: target.totalElevation,
          isWinning: challengerWins
        };
        if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
        effects[joker.targetId].duel = {
          challenger: participant.participant.name,
          challengerId: joker.participantId,
          isTarget: true,
          challengerElevation: participant.totalElevation,
          targetElevation: target.totalElevation,
          isWinning: !challengerWins
        };
      }
    } else if (joker.jokerId === 'sabotage') {
      // Sabotage : -25% du D+ de la cible
      const sabTarget = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (sabTarget) {
        const malus = Math.round(sabTarget.totalElevation * 0.25);
        sabTarget.totalElevation = Math.max(0, sabTarget.totalElevation - malus);
        if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
        effects[joker.targetId].bonuses.sabotaged = { amount: malus, by: participant.participant.name };
        effects[joker.participantId].bonuses.sabotageApplied = { amount: malus, to: sabTarget.participant.name };
      }
    } else if (joker.jokerId === 'bouclier') {
      // Bouclier : protection contre l'élimination
      effects[joker.participantId].hasShield = true;
    }
  });

  ranking.sort((a, b) => b.totalElevation - a.totalElevation);

  // Déterminer la zone de danger AVANT d'appliquer le bouclier
  const elimCount = CHALLENGE_CONFIG.eliminationsPerRound;
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.isInDangerZone = i >= ranking.length - elimCount;
    e.jokerEffects = effects[e.participant.id] || { bonuses: {} };

    // Si le joueur a un bouclier et est en zone de danger, il est protégé
    if (e.jokerEffects.hasShield && e.isInDangerZone) {
      e.isProtected = true;
      e.isInDangerZone = false;  // Plus en danger grâce au bouclier
    }
  });

  return ranking;
}

function getJokerStatusForRound(participantId, roundNumber) {
  const state = jokersState[participantId] || { stock: {}, active: [], used: [], pending: [] };
  return {
    stock: state.stock,
    active: (state.active || []).filter(j => j.round === roundNumber),
    pending: (state.pending || []).filter(j => j.round === roundNumber + 1),
    used: state.used || []
  };
}

// ============================================
// MENU CONTEXTUEL JOKERS
// ============================================
let contextMenu = null;
let isAdminMode = false;

function setAdminMode(enabled) { isAdminMode = enabled; }

function createContextMenu() {
  if (contextMenu) return;
  contextMenu = document.createElement('div');
  contextMenu.className = 'joker-context-menu';
  contextMenu.innerHTML = '<div class="context-menu-header">🃏 Utiliser un Joker</div><div class="context-menu-items"></div>';
  document.body.appendChild(contextMenu);
  document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) hideContextMenu(); });
}

function showContextMenu(e, participantId, participantName) {
  e.preventDefault();
  createContextMenu();
  const stock = getJokerStock(participantId);
  const status = getJokerStatusForRound(participantId, currentRoundNumber);

  let itemsHtml = '';

  if (isAdminMode) {
    itemsHtml += '<div class="context-menu-section">Modifier le stock :</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      itemsHtml += `<div class="context-menu-item admin-joker" data-joker="${jokerId}" data-participant="${participantId}">
        <span class="joker-icon">${joker.icon}</span>
        <span class="joker-name">${joker.name}</span>
        <span class="joker-controls">
          <button class="joker-minus" data-action="remove">−</button>
          <span class="joker-count">${count}</span>
          <button class="joker-plus" data-action="add">+</button>
        </span>
      </div>`;
    });
  } else {
    itemsHtml += '<div class="context-menu-info">⏰ Activé au prochain round</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      const alreadyPending = status.pending.some(j => j.jokerId === jokerId);
      const disabled = count <= 0 || alreadyPending;
      itemsHtml += `<div class="context-menu-item ${disabled ? 'disabled' : ''}" data-joker="${jokerId}" data-participant="${participantId}" data-name="${participantName}">
        <span class="joker-icon">${joker.icon}</span><span class="joker-name">${joker.name}</span><span class="joker-count">${count}</span>
        <span class="joker-disabled-reason">${alreadyPending ? '(programmé)' : count <= 0 ? '(épuisé)' : ''}</span></div>`;
    });
  }

  itemsHtml += '<div class="context-menu-divider"></div><div class="context-menu-item reset" data-action="reset" data-participant="'+participantId+'"><span class="joker-icon">🔄</span><span class="joker-name">Reset jokers (démo)</span></div>';

  contextMenu.querySelector('.context-menu-header').textContent = '🃏 ' + (isAdminMode ? 'Gérer' : 'Jokers de') + ' ' + participantName;
  contextMenu.querySelector('.context-menu-items').innerHTML = itemsHtml;
  contextMenu.style.left = Math.min(e.pageX, window.innerWidth - 280) + 'px';
  contextMenu.style.top = Math.min(e.pageY, window.innerHeight - 300) + 'px';
  contextMenu.classList.add('visible');

  contextMenu.querySelectorAll('.context-menu-item:not(.disabled):not(.admin-joker)').forEach(item => {
    item.onclick = () => handleJokerMenuClick(item);
  });

  contextMenu.querySelectorAll('.joker-plus').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const item = btn.closest('.admin-joker');
      if (addJoker(item.dataset.participant, item.dataset.joker)) {
        const countEl = item.querySelector('.joker-count');
        countEl.textContent = parseInt(countEl.textContent) + 1;
        showNotification('Joker ajouté !', 'success');
        renderAll();
      }
    };
  });
  contextMenu.querySelectorAll('.joker-minus').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const item = btn.closest('.admin-joker');
      if (removeJoker(item.dataset.participant, item.dataset.joker)) {
        const countEl = item.querySelector('.joker-count');
        countEl.textContent = Math.max(0, parseInt(countEl.textContent) - 1);
        showNotification('Joker retiré !', 'success');
        renderAll();
      }
    };
  });
}

function hideContextMenu() { if (contextMenu) contextMenu.classList.remove('visible'); }

function handleJokerMenuClick(item) {
  const action = item.dataset.action, participantId = item.dataset.participant;
  if (action === 'reset') {
    jokersState[participantId] = { stock: { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 }, used: [], active: [], pending: [] };
    saveJokersState(); renderAll(); showNotification('Jokers réinitialisés !', 'success'); hideContextMenu(); return;
  }
  const jokerId = item.dataset.joker, participantName = item.dataset.name;
  if (jokerId === 'duel' || jokerId === 'sabotage') showTargetSelector(participantId, participantName, jokerId);
  else {
    const r = useJoker(participantId, jokerId);
    if (r.success) {
      showNotification(`${JOKER_TYPES[jokerId].icon} ${JOKER_TYPES[jokerId].name} programmé pour le round ${r.activationRound} !`, 'success');
      renderAll();
    } else showNotification(r.error, 'error');
  }
  hideContextMenu();
}

function showTargetSelector(participantId, participantName, jokerId) {
  const joker = JOKER_TYPES[jokerId], others = (seasonData?.active || []).filter(p => String(p.id) !== String(participantId));
  const modal = document.createElement('div');
  modal.className = 'joker-modal';
  modal.innerHTML = `<div class="joker-modal-content"><div class="joker-modal-header"><span>${joker.icon} ${joker.name}</span><button class="joker-modal-close">✕</button></div>
    <div class="joker-modal-body"><p>Choisir la cible (actif au round ${currentRoundNumber + 1}) :</p><div class="target-list">${others.map(p => `<div class="target-option" data-id="${p.id}" data-name="${p.name}"><div class="target-avatar" style="background:linear-gradient(135deg,${getAthleteColor(p.id)},${getAthleteColor(p.id)}88)">${getAthleteInitials(p.id)}</div><span>${p.name}</span></div>`).join('')}</div></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.joker-modal-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.querySelectorAll('.target-option').forEach(opt => {
    opt.onclick = () => {
      const r = useJoker(participantId, jokerId, { targetId: opt.dataset.id, targetName: opt.dataset.name });
      if (r.success) { showNotification(`${joker.icon} ${joker.name} contre ${opt.dataset.name} programmé pour le round ${r.activationRound} !`, 'success'); renderAll(); }
      modal.remove();
    };
  });
}

function showNotification(message, type = 'info') {
  const notif = document.createElement('div');
  notif.className = 'notification notification-' + type;
  notif.textContent = message;
  document.body.appendChild(notif);
  setTimeout(() => notif.classList.add('visible'), 10);
  setTimeout(() => { notif.classList.remove('visible'); setTimeout(() => notif.remove(), 300); }, 3000);
}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================
async function loadActivities() {
  const cached = sessionStorage.getItem('versant_activities');
  if (cached) { try { return JSON.parse(cached); } catch (e) { sessionStorage.removeItem('versant_activities'); } }
  const paths = ['data/all_activities_2025.json', './data/all_activities_2025.json'];
  for (const path of paths) {
    try {
      const res = await fetch(path);
      if (res.ok) {
        const raw = await res.json();
        let data = Array.isArray(raw) ? raw : (raw.activities || []);
        data = data.filter(a => isValidSport(a.sport_type)).map(a => ({ ...a, athlete_id: String(a.athlete?.id || a.athlete_id), date: a.start_date?.split('T')[0] }));
        try { sessionStorage.setItem('versant_activities', JSON.stringify(data)); } catch (e) {}
        return data;
      }
    } catch (e) {}
  }
  return [];
}

// ============================================
// FILTRAGE ET CALCULS
// ============================================
function filterByParticipant(activities, id) { return activities.filter(a => a.athlete_id === String(id)); }
function filterByPeriod(activities, start, end) {
  const s = new Date(start), e = new Date(end); e.setHours(23, 59, 59);
  return activities.filter(a => { const d = new Date(a.start_date); return d >= s && d <= e; });
}

function calculateStats(activities) {
  return { totalElevation: activities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0), totalDistance: activities.reduce((s, a) => s + (a.distance || 0), 0), activitiesCount: activities.length };
}

function calculateRanking(activities, participants, ruleId = 'standard', yearlyStandings = null, seasonNum = 1) {
  const ranking = [];

  for (const p of participants) {
    const pActivities = filterByParticipant(activities, p.id);
    let totalElevation = pActivities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);

    ranking.push({
      participant: p,
      totalElevation: totalElevation,
      activitiesCount: pActivities.length,
      activities: pActivities
    });
  }

  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => { e.position = i + 1; e.isInDangerZone = i >= ranking.length - CHALLENGE_CONFIG.eliminationsPerRound; });
  return ranking;
}

function simulateSeasonEliminations(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber), roundsPerSeason = getRoundsPerSeason(), elimPerRound = CHALLENGE_CONFIG.eliminationsPerRound;
  let active = [...PARTICIPANTS]; const eliminated = []; let winner = null, seasonComplete = false;

  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r, roundDates = getRoundDates(globalRound);
    if (currentDate <= new Date(roundDates.end)) break;
    if (active.length <= 1) { seasonComplete = true; winner = active[0]; break; }

    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    let ranking = calculateRanking(roundActivities, active);

    // Appliquer les effets des jokers pour ce round historique
    // Note: pour la simulation, on vérifie les jokers actifs à ce round
    const protectedIds = [];
    Object.entries(jokersState).forEach(([participantId, state]) => {
      const shieldJoker = (state.active || []).find(j => j.round === globalRound && j.jokerId === 'bouclier');
      if (shieldJoker) protectedIds.push(participantId);
    });

    // Marquer les protégés
    ranking.forEach(e => {
      if (protectedIds.includes(String(e.participant.id))) {
        e.isProtected = true;
      }
    });

    // Éliminer les derniers NON protégés
    let toElimCount = Math.min(elimPerRound, active.length - 1);
    const toElim = [];
    for (let i = ranking.length - 1; i >= 0 && toElim.length < toElimCount; i--) {
      if (!ranking[i].isProtected) {
        toElim.push(ranking[i]);
      }
    }

    toElim.forEach(e => {
      eliminated.push({
        ...e.participant,
        eliminatedRound: globalRound,
        roundInSeason: r,
        seasonNumber,
        elevationAtElimination: e.totalElevation
      });
    });
    active = active.filter(p => !toElim.map(e => e.participant.id).includes(p.id));
    if (active.length <= 1) { seasonComplete = true; winner = active[0]; }
  }
  return { eliminated, active, seasonComplete, winner, seasonNumber };
}

function calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate) {
  const ranking = [], endDate = currentDate < seasonDates.end ? currentDate : seasonDates.end;
  for (const p of eliminatedList) {
    const roundDates = getRoundDates(p.eliminatedRound), startDate = new Date(roundDates.end);
    startDate.setDate(startDate.getDate() + 1);
    if (startDate > endDate) continue;
    const pActs = filterByParticipant(filterByPeriod(activities, startDate, endDate), p.id);
    ranking.push({ participant: p, ...calculateStats(pActs), eliminatedRound: p.eliminatedRound, daysSinceElimination: Math.max(0, Math.floor((endDate - startDate) / 86400000)) });
  }
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => { e.position = i + 1; e.points = getEliminatedChallengePoints(e.position); });
  return ranking;
}

function calculateYearlyStandings(activities, currentDate) {
  const currentSeason = getSeasonNumber(currentDate), totals = {};
  PARTICIPANTS.forEach(p => { totals[p.id] = { participant: p, totalMainPoints: 0, totalEliminatedPoints: 0, totalPoints: 0, wins: 0, seasonsPlayed: 0 }; });
  for (let s = 1; s <= currentSeason; s++) {
    const seasonDates = getSeasonDates(s); if (currentDate < seasonDates.start) continue;
    const sData = simulateSeasonEliminations(activities, s, currentDate);
    const elimRanking = calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate);
    const elimPointsMap = {}; elimRanking.forEach(e => elimPointsMap[e.participant.id] = e.points);
    PARTICIPANTS.forEach(p => {
      const elim = sData.eliminated.find(e => e.id === p.id);
      let mainPts = 0, elimPts = 0;
      if (elim) { mainPts = getMainChallengePoints(PARTICIPANTS.length - sData.eliminated.findIndex(e => e.id === p.id)); elimPts = elimPointsMap[p.id] || 0; }
      else if (sData.winner?.id === p.id) { mainPts = getMainChallengePoints(1); totals[p.id].wins++; }
      else if (sData.seasonComplete) mainPts = getMainChallengePoints(2);
      if (sData.seasonComplete || elim) { totals[p.id].totalMainPoints += mainPts; totals[p.id].totalEliminatedPoints += elimPts; totals[p.id].totalPoints += mainPts + elimPts; if (sData.seasonComplete) totals[p.id].seasonsPlayed++; }
    });
  }
  const standings = Object.values(totals);
  standings.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins);
  standings.forEach((e, i) => e.rank = i + 1);
  return standings;
}

function getSeasonSummary(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber), sData = simulateSeasonEliminations(activities, seasonNumber, currentDate);
  const rounds = [], roundsPerSeason = getRoundsPerSeason();
  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r, roundDates = getRoundDates(globalRound);
    if (currentDate < roundDates.start) break;
    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    const roundInfo = getRoundInfo(globalRound);
    const activeAtRound = PARTICIPANTS.filter(p => !sData.eliminated.some(e => e.eliminatedRound < globalRound && e.id === p.id));
    const ranking = calculateRanking(roundActivities, activeAtRound);
    rounds.push({ roundInSeason: r, globalRound, dates: roundDates, rule: roundInfo?.rule || ROUND_RULES.standard, winner: ranking[0]?.participant, winnerElevation: ranking[0]?.totalElevation || 0, eliminated: sData.eliminated.filter(e => e.roundInSeason === r).map(e => e.name) });
  }
  return { seasonNumber, dates: seasonDates, isComplete: sData.seasonComplete, winner: sData.winner, rounds, eliminatedRanking: calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate) };
}

// ============================================
// RENDU UI
// ============================================
async function init() {
  const loadingScreen = document.getElementById('loadingScreen');

  try {
    console.log('🚀 Initialisation Versant...');

    const realToday = new Date();
    const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate || '2025-12-31');
    if (realToday > yearEnd) {
      setSimulatedDate(yearEnd);
      console.log('📅 Mode démo: date simulée à', yearEnd.toISOString().split('T')[0]);
    }

    allActivities = await loadActivities();
    console.log('📊', allActivities.length, 'activités chargées');

    initializeJokersState();

    const today = getCurrentDate();
    currentSeasonNumber = getSeasonNumber(today);
    currentRoundNumber = getGlobalRoundNumber(today);
    console.log('🔢 Saison:', currentSeasonNumber, '| Round:', currentRoundNumber);

    yearlyStandingsCache = calculateYearlyStandings(allActivities, today);
    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);

    renderAll();
    setupDateSlider();
    injectStyles();
    renderJokersGuide();

    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      setTimeout(() => { loadingScreen.style.display = 'none'; }, 300);
    }

    console.log('🏁 Initialisation complète');
  } catch (error) {
    console.error('❌ Erreur initialisation:', error);
    if (loadingScreen) {
      loadingScreen.innerHTML = '<div class="loading-content"><div class="loading-icon" style="font-size:64px">⚠️</div><div class="loading-title">Erreur</div><div class="loading-text">'+error.message+'</div></div>';
    }
  }
}

function renderAll() {
  try {
    const today = getCurrentDate();
    currentSeasonNumber = getSeasonNumber(today);
    currentRoundNumber = getGlobalRoundNumber(today);
    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);
    yearlyStandingsCache = calculateYearlyStandings(allActivities, today);

    renderCombinedBanner();
    renderActiveJokersSection();
    renderRanking();
    renderEliminatedChallenge();
    renderFinalStandings();
    renderParticipants();
    renderHistorySection();
  } catch (error) {
    console.error('❌ Erreur renderAll:', error);
  }
}

function renderCombinedBanner() {
  const seasonBanner = document.getElementById('seasonBanner');
  const roundBanner = document.getElementById('roundBanner');

  if (roundBanner) roundBanner.style.display = 'none';
  if (!seasonBanner) return;

  const seasonDates = getSeasonDates(currentSeasonNumber);
  const roundDates = getRoundDates(currentRoundNumber);
  const roundInSeason = getRoundInSeason(getCurrentDate());
  const today = getCurrentDate();

  const seasonProgress = Math.min(100, Math.max(0, (today - seasonDates.start) / (seasonDates.end - seasonDates.start) * 100));
  const isRoundActive = today >= roundDates.start && today <= roundDates.end;
  const daysLeft = Math.max(0, Math.ceil((roundDates.end - today) / 86400000));

  seasonBanner.innerHTML = `
    <div class="banner-left">
      <div class="banner-season">
        <span class="banner-label">Saison ${currentSeasonNumber}</span>
        <span class="banner-dates">${formatDateRange(seasonDates.start, seasonDates.end)}</span>
      </div>
      <div class="banner-stats">
        <span class="stat-item"><strong>${seasonData?.active?.length || 0}</strong> en course</span>
        <span class="stat-item"><strong>${seasonData?.eliminated?.length || 0}</strong> éliminés</span>
      </div>
    </div>

    <div class="banner-center">
      <div class="banner-round">
        <span class="round-number">Round ${roundInSeason}</span>
      </div>
      <div class="round-dates">${formatDateRange(roundDates.start, roundDates.end)}</div>
      ${isRoundActive ? `<div class="round-countdown"><span class="countdown-value">${daysLeft}</span> jour${daysLeft > 1 ? 's' : ''} restant${daysLeft > 1 ? 's' : ''}</div>` : ''}
    </div>

    <div class="banner-right">
      <div class="season-progress-container">
        <div class="progress-label">Progression saison</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${seasonProgress}%"></div>
        </div>
        <div class="progress-percent">${Math.round(seasonProgress)}%</div>
      </div>
    </div>
  `;
}

// Section des jokers actifs ce round
function renderActiveJokersSection() {
  let container = document.getElementById('activeJokersSection');
  if (!container) {
    // Créer la section si elle n'existe pas
    const rankingSection = document.querySelector('.ranking-section') || document.getElementById('rankingContainer')?.parentElement;
    if (rankingSection) {
      container = document.createElement('div');
      container.id = 'activeJokersSection';
      container.className = 'active-jokers-section';
      rankingSection.insertBefore(container, rankingSection.firstChild);
    } else {
      return;
    }
  }

  const activeJokers = getActiveJokersForRound(currentRoundNumber);
  const pendingJokers = [];
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const participant = getParticipantById(participantId);
    (state.pending || []).filter(j => j.round === currentRoundNumber + 1).forEach(j => {
      pendingJokers.push({ ...j, participantId, participantName: participant?.name || 'Inconnu' });
    });
  });

  if (activeJokers.length === 0 && pendingJokers.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  // Calculer l'état actuel des duels
  const roundDates = getRoundDates(currentRoundNumber);
  const today = getCurrentDate();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const tempRanking = calculateRanking(roundActivities, seasonData?.active || []);

  let html = '<h3 class="section-title">🃏 Jokers en jeu ce round</h3><div class="jokers-grid">';

  activeJokers.forEach(joker => {
    const jokerType = JOKER_TYPES[joker.jokerId];
    if (!jokerType) return;

    let statusHtml = '';
    let statusClass = 'active';

    if (joker.jokerId === 'duel') {
      const challenger = tempRanking.find(r => String(r.participant.id) === String(joker.participantId));
      const target = tempRanking.find(r => String(r.participant.id) === String(joker.targetId));
      if (challenger && target) {
        const challengerWins = challenger.totalElevation > target.totalElevation;
        statusClass = challengerWins ? 'winning' : 'losing';
        statusHtml = `
          <div class="duel-status">
            <div class="duel-competitor ${challengerWins ? 'winning' : 'losing'}">
              <span class="competitor-name">${joker.participantName}</span>
              <span class="competitor-elevation">${formatElevation(challenger.totalElevation)}</span>
              ${challengerWins ? '<span class="duel-badge">⚔️ EN TÊTE</span>' : ''}
            </div>
            <div class="duel-vs">VS</div>
            <div class="duel-competitor ${!challengerWins ? 'winning' : 'losing'}">
              <span class="competitor-name">${joker.targetName}</span>
              <span class="competitor-elevation">${formatElevation(target.totalElevation)}</span>
              ${!challengerWins ? '<span class="duel-badge">🎯 EN TÊTE</span>' : ''}
            </div>
          </div>
          <div class="duel-stakes">Enjeu : 25% du D+ du perdant</div>
        `;
      }
    } else if (joker.jokerId === 'multiplicateur') {
      statusHtml = `<div class="joker-effect">×1.5 sur tout le D+ de ${joker.participantName}</div>`;
    } else if (joker.jokerId === 'sabotage') {
      statusHtml = `<div class="joker-effect">-25% du D+ de ${joker.targetName}</div>`;
    } else if (joker.jokerId === 'bouclier') {
      statusHtml = `<div class="joker-effect">${joker.participantName} est protégé contre l'élimination</div>`;
    }

    html += `
      <div class="joker-card ${statusClass}">
        <div class="joker-card-header">
          <span class="joker-card-icon">${jokerType.icon}</span>
          <span class="joker-card-name">${jokerType.name}</span>
          <span class="joker-card-user">par ${joker.participantName}</span>
        </div>
        <div class="joker-card-body">${statusHtml}</div>
      </div>
    `;
  });

  // Jokers programmés pour le prochain round
  if (pendingJokers.length > 0) {
    html += '<div class="pending-jokers"><h4>⏰ Programmés pour le Round ${getRoundInSeason(getCurrentDate()) + 1}</h4><div class="pending-list">';
    pendingJokers.forEach(joker => {
      const jokerType = JOKER_TYPES[joker.jokerId];
      if (!jokerType) return;
      html += `<span class="pending-item">${jokerType.icon} ${joker.participantName}${joker.targetName ? ' → ' + joker.targetName : ''}</span>`;
    });
    html += '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function renderRanking() {
  const container = document.getElementById('rankingContainer');
  if (!container) return;

  if (seasonData?.seasonComplete) {
    container.innerHTML = '<div class="empty-state"><p>🏆 Saison terminée ! Champion : '+(seasonData.winner?.name || 'N/A')+'</p></div>';
    return;
  }

  const roundDates = getRoundDates(currentRoundNumber);
  const today = getCurrentDate();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

  let ranking = calculateRanking(roundActivities, seasonData?.active || []);
  ranking = applyJokerEffects(ranking);
  const seasonDates = getSeasonDates(currentSeasonNumber);

  // IMPORTANT : Colonnes inversées - D+ Round en premier et en évidence
  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ Round</div><div>D+ Saison</div><div>Jokers</div></div>';

  ranking.forEach((e, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rowClass = e.isInDangerZone ? 'danger-zone' : (e.isProtected ? 'protected' : '');
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, endDate), e.participant.id));
    const tooltip = generateActivitiesTooltip(e.activities);

    // D+ Round - PRINCIPAL (bleu, gras)
    let roundElevationHtml = `<span class="elevation-primary">${formatElevation(e.totalElevation, false)}</span> <span class="elevation-unit">m</span>`;

    // Bonus jokers
    const bonuses = e.jokerEffects?.bonuses || {};
    const bonusDetails = [];
    if (bonuses.multiplier) bonusDetails.push(`<span class="bonus-tag multiplier">+${formatElevation(bonuses.multiplier.amount, false)} (×1.5)</span>`);
    if (bonuses.duelWon) bonusDetails.push(`<span class="bonus-tag duel-won">+${formatElevation(bonuses.duelWon.amount, false)} volés à ${bonuses.duelWon.from}</span>`);
    if (bonuses.duelLost) bonusDetails.push(`<span class="bonus-tag duel-lost">-${formatElevation(bonuses.duelLost.amount, false)} volés par ${bonuses.duelLost.by}</span>`);
    if (bonuses.sabotaged) bonusDetails.push(`<span class="bonus-tag sabotage">-${formatElevation(bonuses.sabotaged.amount, false)} (-25%)</span>`);
    if (bonuses.sabotageApplied) bonusDetails.push(`<span class="bonus-tag sabotage-done">💣 ${bonuses.sabotageApplied.to}</span>`);
    if (bonusDetails.length) roundElevationHtml += `<div class="elevation-bonuses">${bonusDetails.join(' ')}</div>`;

    // D+ Saison - SECONDAIRE (gris)
    const seasonElevationHtml = `<span class="elevation-secondary">${formatElevation(seasonStats.totalElevation, false)}</span> <span class="elevation-unit-small">m</span>`;

    // Jokers
    const status = getJokerStatusForRound(e.participant.id, currentRoundNumber);
    const stock = status.stock;
    let jokersHtml = '';

    // Bouclier actif
    if (e.jokerEffects?.hasShield) {
      jokersHtml += `<span class="joker-badge shield-active" title="BOUCLIER ACTIF">🛡️</span>`;
    }

    // Jokers actifs
    status.active.forEach(j => {
      if (j.jokerId !== 'bouclier') {
        const joker = JOKER_TYPES[j.jokerId];
        if (joker) jokersHtml += `<span class="joker-badge active" title="ACTIF: ${joker.name}${j.targetName ? ' → '+j.targetName : ''}">${joker.icon}</span>`;
      }
    });
    // Programmés
    status.pending.forEach(j => {
      const joker = JOKER_TYPES[j.jokerId];
      if (joker) jokersHtml += `<span class="joker-badge pending" title="Programmé R${getRoundInSeason(getCurrentDate())+1}: ${joker.name}">${joker.icon}⏰</span>`;
    });
    // Stock
    Object.entries(stock).forEach(([jokerId, count]) => {
      if (count > 0 && JOKER_TYPES[jokerId])
        jokersHtml += `<span class="joker-badge available" title="${JOKER_TYPES[jokerId].name}: ${count}">${JOKER_TYPES[jokerId].icon}<sub>${count}</sub></span>`;
    });

    // Indicateurs duel
    let duelIndicator = '';
    if (e.jokerEffects?.duel) {
      const d = e.jokerEffects.duel;
      if (d.isChallenger) {
        duelIndicator = `<span class="duel-indicator ${d.isWinning ? 'winning' : 'losing'}" title="Duel vs ${d.target}">⚔️</span>`;
      } else {
        duelIndicator = `<span class="duel-indicator ${d.isWinning ? 'winning' : 'losing'}" title="Défié par ${d.challenger}">🎯</span>`;
      }
    }

    // Status
    let statusText = 'En course';
    let statusClass = 'active';
    if (e.isProtected) { statusText = '🛡️ Protégé'; statusClass = 'protected'; }
    else if (e.isInDangerZone) { statusText = '⚠️ Danger'; statusClass = 'danger'; }

    html += `<div class="ranking-row ${rowClass}" data-participant-id="${e.participant.id}" data-participant-name="${e.participant.name}">
      <div class="ranking-position ${posClass}">${e.position}</div>
      <div class="ranking-athlete tooltip-wrapper">
        <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <div class="athlete-info">
          <span class="athlete-name">${e.participant.name}${duelIndicator}</span>
          <span class="athlete-status ${statusClass}">${statusText}</span>
        </div>
        <div class="tooltip-content">${tooltip}</div>
      </div>
      <div class="ranking-elevation round-elevation">${roundElevationHtml}</div>
      <div class="ranking-elevation season-elevation">${seasonElevationHtml}</div>
      <div class="ranking-jokers">${jokersHtml || '-'}</div>
    </div>`;
  });

  container.innerHTML = html;
  container.querySelectorAll('.ranking-row').forEach(row => {
    row.addEventListener('contextmenu', (e) => showContextMenu(e, row.dataset.participantId, row.dataset.participantName));
  });
}

function generateActivitiesTooltip(activities) {
  if (!activities || activities.length === 0) return '<div class="tooltip-empty">Aucune activité</div>';
  const sorted = [...activities].sort((a, b) => new Date(b.start_date) - new Date(a.start_date)).slice(0, 10);
  let html = '<div class="tooltip-activities">';
  sorted.forEach(a => {
    html += `<div class="tooltip-activity">
      <span class="tooltip-date">${new Date(a.start_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span>
      <span class="tooltip-name">${(a.name || '').substring(0, 25)}</span>
      <span class="tooltip-elevation">+${Math.round(a.total_elevation_gain || 0)}m</span>
    </div>`;
  });
  return html + '</div>';
}

function renderEliminatedChallenge() {
  const container = document.getElementById('eliminatedChallengeContainer');
  if (!container) return;
  if (!seasonData?.eliminated?.length) {
    container.innerHTML = '<div class="empty-state"><p>Aucun éliminé cette saison</p></div>';
    return;
  }
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const ranking = calculateEliminatedChallenge(allActivities, seasonData.eliminated, seasonDates, getCurrentDate());

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
      <div class="ranking-round">R${e.eliminatedRound % getRoundsPerSeason() || getRoundsPerSeason()}</div>
      <div class="ranking-points"><span class="points-badge">${e.points} pts</span></div>
    </div>`;
  });
  container.innerHTML = html;
}

function renderFinalStandings() {
  const container = document.getElementById('finalStandingsContainer');
  if (!container) return;
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

function renderParticipants() {
  const container = document.getElementById('participantsGrid');
  if (!container) return;

  const roundDates = getRoundDates(currentRoundNumber);
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const today = getCurrentDate();
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
          <div class="athlete-status ${isElim ? 'eliminated' : 'active'}">${isElim ? 'Éliminé R'+elimData?.roundInSeason : formatPosition(entry.position)}</div>
        </div>
      </div>
      <div class="participant-stats">
        <div class="stat-item"><div class="stat-value">${formatElevation(entry.totalElevation || 0, false)}</div><div class="stat-label">D+ round</div></div>
        <div class="stat-item"><div class="stat-value">${formatElevation(seasonStats.totalElevation, false)}</div><div class="stat-label">D+ saison</div></div>
      </div>
      <div class="participant-jokers">${jokersHtml}</div>
    </div>`;
  });
  container.innerHTML = html;

  const isAdmin = window.location.pathname.includes('admin');
  setAdminMode(isAdmin);

  container.querySelectorAll('.participant-card').forEach(card => {
    card.addEventListener('contextmenu', (e) => showContextMenu(e, card.dataset.participantId, card.dataset.participantName));
  });
}

function renderHistorySection() {
  const container = document.getElementById('historyTimeline');
  if (!container) return;

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
        if (!byRound[p.roundInSeason]) byRound[p.roundInSeason] = [];
        byRound[p.roundInSeason].push(p);
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

// Section guide des jokers (pour la démo)
function renderJokersGuide() {
  const existingGuide = document.getElementById('jokersGuideSection');
  if (existingGuide) existingGuide.remove();

  // Vérifier si on est sur la page démo
  if (!window.location.pathname.includes('demo')) return;

  const mainContent = document.querySelector('main') || document.body;
  const guideSection = document.createElement('section');
  guideSection.id = 'jokersGuideSection';
  guideSection.className = 'jokers-guide-section';

  guideSection.innerHTML = `
    <h2 class="section-title">🃏 Guide des Jokers</h2>
    <p class="guide-intro">Chaque participant dispose de <strong>2 exemplaires</strong> de chaque joker pour toute l'année. Les jokers sont activés au <strong>round suivant</strong> leur utilisation.</p>

    <div class="jokers-guide-grid">
      <div class="joker-guide-card multiplicateur">
        <div class="joker-guide-icon">⚡</div>
        <div class="joker-guide-content">
          <h3>Multiplicateur</h3>
          <p class="joker-effect-desc">×1.5 sur tout le D+ du round</p>
          <p class="joker-details">Bonus de 50% sur l'ensemble de votre dénivelé positif pour le round ciblé. Idéal quand vous prévoyez une grosse semaine !</p>
          <div class="joker-example">
            <strong>Exemple :</strong> 2000m de D+ → 3000m comptabilisés
          </div>
        </div>
      </div>

      <div class="joker-guide-card duel">
        <div class="joker-guide-icon">⚔️</div>
        <div class="joker-guide-content">
          <h3>Duel</h3>
          <p class="joker-effect-desc">Défi direct contre un adversaire</p>
          <p class="joker-details">Le gagnant du duel (celui avec le plus de D+ sur le round) <strong>vole 25%</strong> du D+ du perdant. Risqué mais potentiellement dévastateur !</p>
          <div class="joker-example">
            <strong>Exemple :</strong> Vous : 1500m vs Cible : 1000m → Vous gagnez +250m (25% de 1000)
          </div>
        </div>
      </div>

      <div class="joker-guide-card sabotage">
        <div class="joker-guide-icon">💣</div>
        <div class="joker-guide-content">
          <h3>Sabotage</h3>
          <p class="joker-effect-desc">-25% du D+ d'un adversaire</p>
          <p class="joker-details">Réduit le dénivelé comptabilisé d'un adversaire de 25%. Efficace pour freiner un concurrent en forme !</p>
          <div class="joker-example">
            <strong>Exemple :</strong> Cible avec 2000m → -500m = 1500m comptabilisés
          </div>
        </div>
      </div>

      <div class="joker-guide-card bouclier">
        <div class="joker-guide-icon">🛡️</div>
        <div class="joker-guide-content">
          <h3>Bouclier</h3>
          <p class="joker-effect-desc">Protection contre l'élimination</p>
          <p class="joker-details">Même si vous finissez dernier, vous ne serez <strong>pas éliminé</strong> ce round. Le joker de survie par excellence !</p>
          <div class="joker-example">
            <strong>Exemple :</strong> Dernier du round mais protégé → Vous restez en course
          </div>
        </div>
      </div>
    </div>

    <div class="joker-tips">
      <h4>💡 Conseils stratégiques</h4>
      <ul>
        <li>Le <strong>multiplicateur</strong> est plus efficace sur vos gros rounds</li>
        <li>Le <strong>duel</strong> est risqué : ne le lancez que si vous êtes confiant</li>
        <li>Le <strong>sabotage</strong> cible idéalement le leader du classement</li>
        <li>Gardez un <strong>bouclier</strong> pour les situations critiques en fin de saison</li>
      </ul>
    </div>
  `;

  mainContent.appendChild(guideSection);
}
95); color: #fff; }
    .notification-error { background: rgba(239,68,68,0.95); color: #fff; }
    .notification-info { background: rgba(59,130,246,0.95); color: #fff; }

    /* ===== GUIDE DES JOKERS ===== */
    .jokers-guide-section { margin: 40px auto; padding: 32px; max-width: 1200px; background: linear-gradient(135deg, rgba(15,23,42,0.9), rgba(30,41,59,0.9)); border: 1px solid rgba(249,115,22,0.2); border-radius: 16px; }
    .jokers-guide-section .section-title { font-family: 'Syne', sans-serif; font-size: 1.5rem; margin-bottom: 8px; }
    .guide-intro { color: rgba(255,255,255,0.7); margin-bottom: 24px; font-size: 0.95rem; }
    .jokers-guide-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .joker-guide-card { background: rgba(0,0,0,0.3); border-radius: 12px; padding: 20px; border-left: 4px solid #f97316; transition: transform 0.2s; }
    .joker-guide-card:hover { transform: translateY(-4px); }
    .joker-guide-card.multiplicateur { border-left-color: #22d3ee; }
    .joker-guide-card.duel { border-left-color: #ef4444; }
    .joker-guide-card.sabotage { border-left-color: #f97316; }
    .joker-guide-card.bouclier { border-left-color: #3b82f6; }
    .joker-guide-icon { font-size: 2.5rem; margin-bottom: 12px; }
    .joker-guide-content h3 { font-family: 'Syne', sans-serif; font-size: 1.2rem; margin-bottom: 8px; color: #fff; }
    .joker-effect-desc { font-weight: 600; color: #22d3ee; margin-bottom: 8px; }
    .joker-details { font-size: 0.9rem; color: rgba(255,255,255,0.7); line-height: 1.5; margin-bottom: 12px; }
    .joker-example { background: rgba(255,255,255,0.05); padding: 10px 12px; border-radius: 6px; font-size: 0.85rem; color: rgba(255,255,255,0.8); }
    .joker-tips { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); border-radius: 10px; padding: 16px 20px; }
    .joker-tips h4 { color: #10b981; margin-bottom: 12px; }
    .joker-tips ul { list-style: none; }
    .joker-tips li { padding: 6px 0; padding-left: 24px; position: relative; color: rgba(255,255,255,0.8); font-size: 0.9rem; }
    .joker-tips li::before { content: '→'; position: absolute; left: 0; color: #10b981; }

    /* ===== MISC ===== */
    .ranking-row, .participant-card { cursor: context-menu; }
    body { padding-bottom: 120px; }
  `;
  document.head.appendChild(styles);
}

// ============================================
// ÉVÉNEMENTS
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  init();
  document.getElementById('loginBtn')?.addEventListener('click', () => window.location.href = 'login.html');
});

window.versant = {
  getCurrentDate,
  setSimulatedDate,
  refresh: renderAll,
  useJoker,
  addJoker,
  removeJoker,
  getJokerStock,
  setAdminMode,
  getActiveJokersForRound
};