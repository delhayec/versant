/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE UNIFIÉE
 * ============================================
 * Version améliorée avec :
 * - Menu contextuel pour les jokers (clic droit)
 * - Affichage des bonus (x2, duels, sabotages)
 * - Gestion complète du stock de jokers
 * - Règles spéciales (hors-sentier, pente raide, etc.)
 * - Jokers activés pour le round suivant
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
  // Joker activé pour le PROCHAIN round
  const activationRound = currentRoundNumber + 1;
  const usage = {
    id: `${participantId}-${jokerId}-${activationRound}-${Date.now()}`,
    jokerId,
    jokerName: jokerType.name,
    round: activationRound,  // Activé au prochain round
    scheduledAt: currentRoundNumber,  // Programmé maintenant
    usedAt: getCurrentDate().toISOString(),
    ...options
  };
  state.pending.push(usage);  // En attente jusqu'au prochain round
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
      state.active.push(j);
      state.pending = state.pending.filter(p => p.id !== j.id);
    });
  });
  saveJokersState();
}

function applyJokerEffects(ranking) {
  // D'abord activer les jokers en attente
  activatePendingJokers();

  const effects = {};
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const activeForRound = (state.active || []).filter(j => j.round === currentRoundNumber);
    activeForRound.forEach(joker => {
      const participant = ranking.find(r => String(r.participant.id) === String(participantId));
      if (!participant) return;
      if (!effects[participantId]) effects[participantId] = { bonuses: {} };

      if (joker.jokerId === 'multiplicateur') {
        const amt = participant.totalElevation * 0.2;
        participant.totalElevation += amt;
        effects[participantId].bonuses.multiplier = { amount: amt * 2 };
      } else if (joker.jokerId === 'duel') {
        const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
        if (target && participant.totalElevation > target.totalElevation) {
          const stolen = Math.round(target.totalElevation * 0.25);
          participant.totalElevation += stolen;
          target.totalElevation -= stolen;
          effects[participantId].bonuses.duelWon = { amount: stolen, from: target.participant.name };
          if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
          effects[joker.targetId].bonuses.duelLost = { amount: stolen, by: participant.participant.name };
        }
        effects[participantId].duel = { target: joker.targetName, isChallenger: true };
        if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
        effects[joker.targetId].duel = { challenger: participant.participant.name, isTarget: true };
      } else if (joker.jokerId === 'sabotage') {
        const sabTarget = ranking.find(r => String(r.participant.id) === String(joker.targetId));
        if (sabTarget) {
          sabTarget.totalElevation = Math.max(0, sabTarget.totalElevation - 250);
          if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
          effects[joker.targetId].bonuses.sabotaged = { amount: 250, by: participant.participant.name };
        }
      }
    });
  });

  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.isInDangerZone = i >= ranking.length - CHALLENGE_CONFIG.eliminationsPerRound;
    e.jokerEffects = effects[e.participant.id] || { bonuses: {} };
  });
  return ranking;
}

function getJokerStatusForRound(participantId, roundNumber) {
  const state = jokersState[participantId] || { stock: {}, active: [], used: [], pending: [] };
  return {
    stock: state.stock,
    active: (state.active || []).filter(j => j.round === roundNumber),
    pending: (state.pending || []).filter(j => j.round === roundNumber + 1),  // Programmés pour le prochain
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
    // Mode admin : ajouter/retirer des jokers
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
    // Mode normal : utiliser un joker
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
  contextMenu.style.left = e.pageX + 'px';
  contextMenu.style.top = e.pageY + 'px';
  contextMenu.classList.add('visible');

  // Events pour mode normal
  contextMenu.querySelectorAll('.context-menu-item:not(.disabled):not(.admin-joker)').forEach(item => {
    item.onclick = () => handleJokerMenuClick(item);
  });

  // Events pour mode admin
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
  else if (jokerId === 'multiplicateur') showDaySelector(participantId, participantName, jokerId);
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

function showDaySelector(participantId, participantName, jokerId) {
  // Pour le multiplicateur, on programme simplement pour le prochain round
  const r = useJoker(participantId, jokerId, { allDay: true });
  if (r.success) {
    showNotification(`${JOKER_TYPES[jokerId].icon} Multiplicateur ×2 programmé pour le round ${r.activationRound} !`, 'success');
    renderAll();
  } else {
    showNotification(r.error, 'error');
  }
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

// Calcul avec règles spéciales
function calculateRanking(activities, participants, ruleId = 'standard', yearlyStandings = null, seasonNum = 1) {
  const rule = ROUND_RULES[ruleId] || ROUND_RULES.standard;
  const ranking = [];

  for (const p of participants) {
    const pActivities = filterByParticipant(activities, p.id);
    let totalElevation = 0;
    let countedElevation = 0;  // D+ comptabilisé selon les règles
    let rawElevation = 0;      // D+ brut

    pActivities.forEach(a => {
      const elev = a.total_elevation_gain || 0;
      rawElevation += elev;

      // Appliquer les règles spéciales
      if (ruleId === 'offroad' || ruleId === 'hors_sentiers') {
        // Hors sentiers : ratio basé sur le type de sport
        const offRoadRatio = { 'TrailRun': 1.0, 'Hike': 1.0, 'MountainBikeRide': 0.8, 'GravelRide': 0.6, 'Run': 0.2, 'Ride': 0.1 };
        countedElevation += elev * (offRoadRatio[a.sport_type] || 0.5);
      } else if (ruleId === 'steep' || ruleId === 'pente_raide') {
        // Pente raide : seulement D+ sur pentes > 15% (estimation : 60% du total pour trail/hike)
        const steepRatio = { 'TrailRun': 0.6, 'Hike': 0.7, 'MountainBikeRide': 0.4, 'Run': 0.3, 'Ride': 0.2 };
        countedElevation += elev * (steepRatio[a.sport_type] || 0.3);
      } else if (ruleId === 'combinado') {
        countedElevation += elev;  // Sera traité après par jour
      } else {
        countedElevation += elev;
      }
    });

    // Règle Combinado : x2 si plusieurs sports dans la même journée
    if (ruleId === 'combinado') {
      const byDay = {};
      pActivities.forEach(a => {
        const day = a.date || a.start_date?.split('T')[0];
        if (!byDay[day]) byDay[day] = { sports: new Set(), elevation: 0 };
        byDay[day].sports.add(a.sport_type);
        byDay[day].elevation += a.total_elevation_gain || 0;
      });
      countedElevation = 0;
      for (const day in byDay) {
        const mult = byDay[day].sports.size >= 2 ? 2 : 1;
        countedElevation += byDay[day].elevation * mult;
      }
    }

    // Handicap
    if (ruleId === 'handicap' && seasonNum > 1 && yearlyStandings) {
      const standing = yearlyStandings.find(s => s.participant.id === p.id);
      if (standing && standing.rank <= 5) {
        const malus = rule.parameters?.malusPerPosition?.[standing.rank] || 0;
        countedElevation = Math.round(countedElevation * (100 - malus) / 100);
      }
    }

    ranking.push({
      participant: p,
      totalElevation: countedElevation,
      rawElevation: rawElevation,
      activitiesCount: pActivities.length,
      activities: pActivities,
      ruleApplied: ruleId !== 'standard' ? rule : null
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
    const roundInfo = getRoundInfo(globalRound);
    const ranking = calculateRanking(roundActivities, active, roundInfo?.rule?.id || 'standard', yearlyStandingsCache, seasonNumber);
    const maxElim = Math.min(elimPerRound, active.length - 1), toElim = ranking.slice(-maxElim);
    toElim.forEach(e => { eliminated.push({ ...e.participant, eliminatedRound: globalRound, roundInSeason: r, seasonNumber, elevationAtElimination: e.totalElevation }); });
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
    const ranking = calculateRanking(roundActivities, activeAtRound, roundInfo?.rule?.id || 'standard');
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

    // Pour la démo : si on est après la fin de l'année de données, simuler une date dans l'année
    const realToday = new Date();
    const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate || '2025-12-31');
    if (realToday > yearEnd) {
      setSimulatedDate(yearEnd);
      console.log('📅 Mode démo: date simulée à', yearEnd.toISOString().split('T')[0]);
    }

    allActivities = await loadActivities();
    console.log('📊', allActivities.length, 'activités chargées');
    console.log('👥 Participants:', PARTICIPANTS.length);

    initializeJokersState();

    const today = getCurrentDate();
    console.log('📅 Date actuelle:', today.toISOString().split('T')[0]);

    currentSeasonNumber = getSeasonNumber(today);
    currentRoundNumber = getGlobalRoundNumber(today);
    console.log('🔢 Saison:', currentSeasonNumber, '| Round:', currentRoundNumber);

    yearlyStandingsCache = calculateYearlyStandings(allActivities, today);
    seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);
    console.log('🎯 Saison simulée - Actifs:', seasonData?.active?.length, '| Éliminés:', seasonData?.eliminated?.length);

    renderAll();
    setupDateSlider();
    injectStyles();

    // Masquer l'écran de chargement
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
    renderRanking();
    renderEliminatedChallenge();
    renderFinalStandings();
    renderParticipants();
    renderHistorySection();
  } catch (error) {
    console.error('❌ Erreur renderAll:', error);
  }
}

// Bandeau unique combinant saison et round
function renderCombinedBanner() {
  const seasonBanner = document.getElementById('seasonBanner');
  const roundBanner = document.getElementById('roundBanner');

  // Cacher le round banner séparé
  if (roundBanner) roundBanner.style.display = 'none';

  if (!seasonBanner) return;

  const seasonDates = getSeasonDates(currentSeasonNumber);
  const roundDates = getRoundDates(currentRoundNumber);
  const roundInfo = getRoundInfo(currentRoundNumber);
  const roundInSeason = getRoundInSeason(getCurrentDate());
  const today = getCurrentDate();

  const seasonProgress = Math.min(100, Math.max(0, (today - seasonDates.start) / (seasonDates.end - seasonDates.start) * 100));
  const isRoundActive = today >= roundDates.start && today <= roundDates.end;
  const daysLeft = Math.max(0, Math.ceil((roundDates.end - today) / 86400000));

  // Info règle spéciale
  const ruleInfo = roundInfo?.rule?.isSpecial ? `
    <div class="rule-badge">
      <span class="rule-icon">${roundInfo.rule.icon}</span>
      <span class="rule-name">${roundInfo.rule.name}</span>
    </div>
  ` : '';

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
        ${ruleInfo}
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
  const roundInfo = getRoundInfo(currentRoundNumber);
  const ruleId = roundInfo?.rule?.id || 'standard';

  let ranking = calculateRanking(roundActivities, seasonData?.active || [], ruleId, yearlyStandingsCache, currentSeasonNumber);
  ranking = applyJokerEffects(ranking);
  const seasonDates = getSeasonDates(currentSeasonNumber);

  // Header avec info règle
  let headerExtra = '';
  if (roundInfo?.rule?.isSpecial) {
    headerExtra = `<div class="ranking-rule-info">${roundInfo.rule.icon} ${roundInfo.rule.name} : ${roundInfo.rule.shortDescription || ''}</div>`;
  }

  let html = headerExtra + '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ Comptabilisé</div><div>D+ Saison</div><div>Jokers</div></div>';

  ranking.forEach((e, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rowClass = e.isInDangerZone ? 'danger-zone' : '';
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, endDate), e.participant.id));
    const tooltip = generateActivitiesTooltip(e.activities);

    // Affichage D+ avec règle appliquée
    let elevationHtml = '';
    if (e.ruleApplied && e.rawElevation !== e.totalElevation) {
      elevationHtml = `<span class="elevation-counted">${formatElevation(e.totalElevation, false)}</span> <span class="elevation-unit">m</span>
        <div class="elevation-detail">(sur ${formatElevation(e.rawElevation, false)} brut)</div>`;
    } else {
      elevationHtml = `<span class="elevation-base">${formatElevation(e.totalElevation, false)}</span> <span class="elevation-unit">m</span>`;
    }

    // Ajouter les bonus jokers
    const bonuses = e.jokerEffects?.bonuses || {};
    const bonusDetails = [];
    if (bonuses.multiplier) bonusDetails.push(`<span class="bonus-tag multiplier">+${formatElevation(bonuses.multiplier.amount, false)} ×2</span>`);
    if (bonuses.duelWon) bonusDetails.push(`<span class="bonus-tag duel-won">+${formatElevation(bonuses.duelWon.amount, false)} volés</span>`);
    if (bonuses.duelLost) bonusDetails.push(`<span class="bonus-tag duel-lost">-${formatElevation(bonuses.duelLost.amount, false)} volés</span>`);
    if (bonuses.sabotaged) bonusDetails.push(`<span class="bonus-tag sabotage">-250 sabotés</span>`);
    if (bonusDetails.length) elevationHtml += `<div class="elevation-bonuses">${bonusDetails.join(' ')}</div>`;

    // Jokers
    const status = getJokerStatusForRound(e.participant.id, currentRoundNumber);
    const stock = status.stock;
    let jokersHtml = '';

    // Jokers actifs ce round
    status.active.forEach(j => {
      const joker = JOKER_TYPES[j.jokerId];
      if (joker) jokersHtml += `<span class="joker-badge active" title="ACTIF: ${joker.name}${j.targetName ? ' → '+j.targetName : ''}">${joker.icon}</span>`;
    });
    // Jokers programmés pour le prochain round
    status.pending.forEach(j => {
      const joker = JOKER_TYPES[j.jokerId];
      if (joker) jokersHtml += `<span class="joker-badge pending" title="Programmé R${j.round}: ${joker.name}">${joker.icon}⏰</span>`;
    });
    // Stock disponible
    Object.entries(stock).forEach(([jokerId, count]) => {
      if (count > 0 && JOKER_TYPES[jokerId] && !status.active.some(j => j.jokerId === jokerId))
        jokersHtml += `<span class="joker-badge available" title="${JOKER_TYPES[jokerId].name}: ${count}">${JOKER_TYPES[jokerId].icon}<sub>${count}</sub></span>`;
    });

    // Indicateur duel
    let duelIndicator = '';
    if (e.jokerEffects?.duel) {
      const d = e.jokerEffects.duel;
      duelIndicator = d.isChallenger ? `<span class="duel-indicator challenger" title="Duel vs ${d.target}">⚔️</span>` : `<span class="duel-indicator target" title="Défié par ${d.challenger}">🎯</span>`;
    }

    html += `<div class="ranking-row ${rowClass}" data-participant-id="${e.participant.id}" data-participant-name="${e.participant.name}">
      <div class="ranking-position ${posClass}">${e.position}</div>
      <div class="ranking-athlete tooltip-wrapper">
        <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
        <div class="athlete-info">
          <span class="athlete-name">${e.participant.name}${duelIndicator}</span>
          <span class="athlete-status ${e.isInDangerZone ? 'danger' : 'active'}">${e.isInDangerZone ? '⚠️ Danger' : 'En course'}</span>
        </div>
        <div class="tooltip-content">${tooltip}</div>
      </div>
      <div class="ranking-elevation">${elevationHtml}</div>
      <div class="ranking-elevation season">${formatElevation(seasonStats.totalElevation, false)} <span class="elevation-unit">m</span></div>
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

  // Clic droit pour gérer les jokers (mode admin si page admin)
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
        content.innerHTML = '<div class="history-item"><div class="history-round">Saison '+currentSeasonNumber+'</div><div class="history-title">Aucune élimination encore</div></div>';
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
        h += `<div class="history-item ${r.rule.isSpecial ? 'special-round' : ''}">
          <div class="history-round">Round ${r.roundInSeason} ${r.rule.isSpecial ? '<span class="rule-badge">'+r.rule.icon+'</span>' : ''}</div>
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
// DATE SLIDER - VERSION AMÉLIORÉE
// ============================================
function setupDateSlider() {
  const container = document.getElementById('dateSliderContainer');
  if (!container) return;

  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate || '2025-01-01');
  const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate || '2025-12-31');
  const today = getCurrentDate();

  const totalDays = Math.ceil((yearEnd - yearStart) / 86400000);
  let currentDay = Math.ceil((today - yearStart) / 86400000);
  currentDay = Math.max(0, Math.min(totalDays, currentDay));

  container.innerHTML = `
    <div class="slider-wrapper">
      <div class="slider-header">
        <span class="slider-icon">📅</span>
        <span class="slider-title">Navigation temporelle</span>
        <span class="slider-current-date" id="sliderDate">${formatDate(today)}</span>
      </div>
      <div class="slider-controls">
        <button class="slider-btn" id="prevDay" title="Jour précédent">◀</button>
        <div class="slider-track">
          <input type="range" class="date-slider" id="dateSlider" min="0" max="${totalDays}" value="${currentDay}">
          <div class="slider-markers">
            <span class="marker-start">${formatDateShort(yearStart)}</span>
            <span class="marker-end">${formatDateShort(yearEnd)}</span>
          </div>
        </div>
        <button class="slider-btn" id="nextDay" title="Jour suivant">▶</button>
      </div>
      <div class="slider-info">
        <span class="info-season">Saison <strong id="sliderSeason">${currentSeasonNumber}</strong></span>
        <span class="info-round">Round <strong id="sliderRound">${getRoundInSeason(today)}</strong></span>
      </div>
    </div>
  `;

  const slider = document.getElementById('dateSlider');
  const dateLabel = document.getElementById('sliderDate');
  const seasonLabel = document.getElementById('sliderSeason');
  const roundLabel = document.getElementById('sliderRound');

  const updateDate = (dayOffset) => {
    const newDate = new Date(yearStart);
    newDate.setDate(newDate.getDate() + dayOffset);
    setSimulatedDate(newDate);
    dateLabel.textContent = formatDate(newDate);
    seasonLabel.textContent = getSeasonNumber(newDate);
    roundLabel.textContent = getRoundInSeason(newDate);
    renderAll();
  };

  slider.addEventListener('input', (e) => updateDate(parseInt(e.target.value)));
  document.getElementById('prevDay').addEventListener('click', () => {
    slider.value = Math.max(0, parseInt(slider.value) - 1);
    updateDate(parseInt(slider.value));
  });
  document.getElementById('nextDay').addEventListener('click', () => {
    slider.value = Math.min(totalDays, parseInt(slider.value) + 1);
    updateDate(parseInt(slider.value));
  });

  console.log('📆 Slider configuré: jour', currentDay, '/', totalDays);
}

// ============================================
// STYLES CSS INJECTÉS
// ============================================
function injectStyles() {
  if (document.getElementById('versant-injected-styles')) return;

  const styles = document.createElement('style');
  styles.id = 'versant-injected-styles';
  styles.textContent = `
    /* ===== BANDEAU COMBINÉ ===== */
    .season-banner {
      background: linear-gradient(135deg, rgba(34, 211, 238, 0.15) 0%, rgba(16, 185, 129, 0.15) 100%);
      border: 1px solid rgba(34, 211, 238, 0.3);
      border-radius: 16px;
      padding: 20px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 32px;
      flex-wrap: wrap;
      font-family: 'Inter', sans-serif;
    }
    .banner-left, .banner-right { flex: 1; min-width: 200px; }
    .banner-center { flex: 1.5; text-align: center; min-width: 250px; }
    .banner-label { font-family: 'Syne', sans-serif; font-size: 1.5rem; font-weight: 700; color: #22d3ee; display: block; }
    .banner-dates { font-size: 0.85rem; color: rgba(255,255,255,0.6); }
    .banner-stats { margin-top: 8px; display: flex; gap: 16px; }
    .stat-item { font-size: 0.9rem; color: rgba(255,255,255,0.8); }
    .stat-item strong { color: #22d3ee; }
    .banner-round { display: flex; align-items: center; justify-content: center; gap: 12px; }
    .round-number { font-family: 'Syne', sans-serif; font-size: 1.75rem; font-weight: 700; background: linear-gradient(135deg, #f97316, #22d3ee); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .round-dates { font-size: 0.9rem; color: rgba(255,255,255,0.7); margin-top: 4px; }
    .round-countdown { margin-top: 8px; }
    .countdown-value { background: rgba(239, 68, 68, 0.2); color: #ef4444; padding: 4px 12px; border-radius: 8px; font-weight: 700; font-size: 1.1rem; }
    .rule-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(249, 115, 22, 0.2); border: 1px solid rgba(249, 115, 22, 0.4); padding: 4px 12px; border-radius: 20px; font-size: 0.85rem; }
    .rule-icon { font-size: 1.1rem; }
    .rule-name { color: #f97316; font-weight: 600; }
    .season-progress-container { text-align: right; }
    .progress-label { font-size: 0.75rem; color: rgba(255,255,255,0.5); margin-bottom: 4px; }
    .progress-bar-bg { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
    .progress-bar-fill { height: 100%; background: linear-gradient(90deg, #22d3ee, #10b981); border-radius: 4px; transition: width 0.3s; }
    .progress-percent { font-size: 0.85rem; color: #22d3ee; margin-top: 4px; }

    /* ===== SLIDER AMÉLIORÉ ===== */
    .date-slider-container { position: fixed; bottom: 0; left: 0; right: 0; z-index: 200; background: linear-gradient(180deg, rgba(10,10,15,0.95) 0%, rgba(10,10,15,0.98) 100%); border-top: 1px solid rgba(249,115,22,0.3); padding: 16px 24px; backdrop-filter: blur(10px); }
    .slider-wrapper { max-width: 1000px; margin: 0 auto; }
    .slider-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .slider-icon { font-size: 1.25rem; }
    .slider-title { font-family: 'Space Mono', monospace; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(255,255,255,0.5); }
    .slider-current-date { margin-left: auto; font-family: 'Syne', sans-serif; font-size: 1.1rem; font-weight: 600; color: #f97316; }
    .slider-controls { display: flex; align-items: center; gap: 16px; }
    .slider-btn { background: rgba(249,115,22,0.1); border: 1px solid rgba(249,115,22,0.3); color: #f97316; width: 40px; height: 40px; border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s; display: flex; align-items: center; justify-content: center; }
    .slider-btn:hover { background: #f97316; color: #fff; }
    .slider-track { flex: 1; }
    .date-slider { width: 100%; height: 10px; border-radius: 5px; background: rgba(255,255,255,0.1); outline: none; -webkit-appearance: none; cursor: pointer; }
    .date-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #f97316, #22d3ee); cursor: pointer; box-shadow: 0 2px 10px rgba(249,115,22,0.5); transition: transform 0.2s; }
    .date-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
    .slider-markers { display: flex; justify-content: space-between; margin-top: 6px; font-size: 0.7rem; color: rgba(255,255,255,0.4); }
    .slider-info { display: flex; justify-content: center; gap: 24px; margin-top: 10px; font-size: 0.85rem; color: rgba(255,255,255,0.6); }
    .slider-info strong { color: #22d3ee; }

    /* ===== MENU CONTEXTUEL JOKERS ===== */
    .joker-context-menu { position: absolute; background: rgba(15,23,42,0.98); border: 1px solid rgba(249,115,22,0.3); border-radius: 12px; padding: 8px 0; min-width: 260px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); z-index: 9999; opacity: 0; transform: scale(0.95); pointer-events: none; transition: all 0.15s; }
    .joker-context-menu.visible { opacity: 1; transform: scale(1); pointer-events: auto; }
    .context-menu-header { padding: 12px 16px; font-weight: 600; color: #f97316; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 14px; }
    .context-menu-info { padding: 8px 16px; font-size: 0.75rem; color: rgba(255,255,255,0.5); background: rgba(34,211,238,0.1); }
    .context-menu-section { padding: 8px 16px; font-size: 0.75rem; color: rgba(255,255,255,0.5); text-transform: uppercase; }
    .context-menu-items { padding: 8px 0; }
    .context-menu-item { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; transition: background 0.15s; }
    .context-menu-item:hover:not(.disabled) { background: rgba(249,115,22,0.15); }
    .context-menu-item.disabled { opacity: 0.4; cursor: not-allowed; }
    .context-menu-item .joker-icon { font-size: 20px; }
    .context-menu-item .joker-name { flex: 1; color: rgba(255,255,255,0.9); }
    .context-menu-item .joker-count { background: rgba(249,115,22,0.2); color: #f97316; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; min-width: 24px; text-align: center; }
    .context-menu-item .joker-disabled-reason { font-size: 11px; color: rgba(255,255,255,0.4); }
    .context-menu-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 8px 0; }
    .joker-controls { display: flex; align-items: center; gap: 8px; }
    .joker-minus, .joker-plus { width: 24px; height: 24px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: transparent; color: #fff; cursor: pointer; font-size: 14px; transition: all 0.15s; }
    .joker-minus:hover { background: #ef4444; border-color: #ef4444; }
    .joker-plus:hover { background: #10b981; border-color: #10b981; }

    /* ===== MODAL JOKER ===== */
    .joker-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000; }
    .joker-modal-content { background: rgba(15,23,42,0.98); border: 1px solid rgba(249,115,22,0.3); border-radius: 16px; width: 90%; max-width: 400px; overflow: hidden; }
    .joker-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: rgba(249,115,22,0.1); font-weight: 600; color: #f97316; }
    .joker-modal-close { background: none; border: none; color: rgba(255,255,255,0.5); font-size: 20px; cursor: pointer; }
    .joker-modal-body { padding: 20px; }
    .joker-modal-body p { margin-bottom: 16px; color: rgba(255,255,255,0.8); }
    .target-list { display: flex; flex-direction: column; gap: 8px; }
    .target-option { display: flex; align-items: center; gap: 12px; padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer; transition: all 0.15s; }
    .target-option:hover { background: rgba(249,115,22,0.15); border-color: rgba(249,115,22,0.3); }
    .target-avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 14px; color: #fff; }

    /* ===== NOTIFICATIONS ===== */
    .notification { position: fixed; bottom: 120px; left: 50%; transform: translateX(-50%) translateY(20px); padding: 14px 28px; border-radius: 10px; font-weight: 500; opacity: 0; transition: all 0.3s; z-index: 10001; max-width: 90%; text-align: center; }
    .notification.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .notification-success { background: rgba(16,185,129,0.95); color: #fff; }
    .notification-error { background: rgba(239,68,68,0.95); color: #fff; }
    .notification-info { background: rgba(59,130,246,0.95); color: #fff; }

    /* ===== ELEVATION AVEC RÈGLES ===== */
    .elevation-counted { font-weight: 700; color: #22d3ee; }
    .elevation-detail { font-size: 0.75rem; color: rgba(255,255,255,0.5); margin-top: 2px; }
    .elevation-bonuses { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
    .bonus-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .bonus-tag.multiplier { background: rgba(34,211,238,0.2); color: #22d3ee; }
    .bonus-tag.duel-won { background: rgba(16,185,129,0.2); color: #10b981; }
    .bonus-tag.duel-lost, .bonus-tag.sabotage { background: rgba(239,68,68,0.2); color: #ef4444; }

    /* ===== JOKER BADGES ===== */
    .joker-badge { display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 6px; font-size: 16px; margin: 0 2px; }
    .joker-badge sub { font-size: 10px; margin-left: 2px; color: rgba(255,255,255,0.7); }
    .joker-badge.active { background: rgba(16,185,129,0.3); box-shadow: 0 0 8px rgba(16,185,129,0.4); }
    .joker-badge.pending { background: rgba(249,115,22,0.3); }
    .joker-badge.available { background: rgba(255,255,255,0.1); opacity: 0.7; }
    .duel-indicator { margin-left: 6px; font-size: 14px; }
    .duel-indicator.target { color: #ef4444; }
    .no-jokers { font-size: 0.8rem; color: rgba(255,255,255,0.4); }

    /* ===== RULE INFO ===== */
    .ranking-rule-info { background: linear-gradient(135deg, rgba(249,115,22,0.1), rgba(34,211,238,0.1)); border: 1px solid rgba(249,115,22,0.3); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 0.9rem; color: rgba(255,255,255,0.8); }

    /* ===== CONTEXT MENU TRIGGER ===== */
    .ranking-row, .participant-card { cursor: context-menu; }

    body { padding-bottom: 100px; }
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

// Export pour usage externe
window.versant = {
  getCurrentDate,
  setSimulatedDate,
  refresh: renderAll,
  useJoker,
  addJoker,
  removeJoker,
  getJokerStock,
  setAdminMode
};