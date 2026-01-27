/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE UNIFIÉE
 * ============================================
 * Version améliorée avec :
 * - Menu contextuel pour les jokers (clic droit)
 * - Affichage des bonus (x2, duels, sabotages)
 * - Gestion complète du stock de jokers
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

function formatElevationWithBonuses(baseElevation, bonuses = {}) {
  let html = `<span class="elevation-base">${Math.round(baseElevation).toLocaleString('fr-FR')}</span> <span class="elevation-unit">m</span>`;
  const details = [];
  if (bonuses.multiplier) details.push(`<span class="bonus-detail multiplier">dont ${Math.round(bonuses.multiplier.amount).toLocaleString('fr-FR')} ×2</span>`);
  if (bonuses.duelWon) details.push(`<span class="bonus-detail duel-won">+${Math.round(bonuses.duelWon.amount).toLocaleString('fr-FR')} volés à ${bonuses.duelWon.from}</span>`);
  if (bonuses.duelLost) details.push(`<span class="bonus-detail duel-lost">-${Math.round(bonuses.duelLost.amount).toLocaleString('fr-FR')} volés par ${bonuses.duelLost.by}</span>`);
  if (bonuses.sabotaged) details.push(`<span class="bonus-detail sabotage">-${Math.round(bonuses.sabotaged.amount).toLocaleString('fr-FR')} sabotés par ${bonuses.sabotaged.by}</span>`);
  if (details.length > 0) html += `<div class="elevation-bonuses">(${details.join(' • ')})</div>`;
  return html;
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
    jokersState[p.id] = {
      stock: p.jokerStock || p.jokers_stock || { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 },
      used: [], active: [], pending: []
    };
  });
  try { const saved = localStorage.getItem('versant_jokers_state'); if (saved) Object.assign(jokersState, JSON.parse(saved)); } catch (e) {}
}

function saveJokersState() { try { localStorage.setItem('versant_jokers_state', JSON.stringify(jokersState)); } catch (e) {} }
function getJokerStock(participantId) { return jokersState[participantId]?.stock || { duel: 0, multiplicateur: 0, bouclier: 0, sabotage: 0 }; }

function useJoker(participantId, jokerId, options = {}) {
  const state = jokersState[participantId];
  if (!state) return { success: false, error: 'Participant non trouvé' };
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) return { success: false, error: 'Joker inconnu' };
  if (!state.stock[jokerId] || state.stock[jokerId] <= 0) return { success: false, error: 'Plus de joker disponible' };
  
  state.stock[jokerId]--;
  const usage = { id: `${participantId}-${jokerId}-${currentRoundNumber}-${Date.now()}`, jokerId, jokerName: jokerType.name, round: currentRoundNumber, usedAt: getCurrentDate().toISOString(), ...options };
  state.active.push(usage);
  state.used.push(usage);
  saveJokersState();
  return { success: true, usage };
}

function applyJokerEffects(ranking) {
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
  return { stock: state.stock, active: (state.active || []).filter(j => j.round === roundNumber), pending: [], used: state.used || [] };
}

// ============================================
// MENU CONTEXTUEL JOKERS
// ============================================
let contextMenu = null;

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
  Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
    const count = stock[jokerId] || 0;
    const alreadyUsed = status.active.some(j => j.jokerId === jokerId);
    const disabled = count <= 0 || alreadyUsed;
    itemsHtml += `<div class="context-menu-item ${disabled ? 'disabled' : ''}" data-joker="${jokerId}" data-participant="${participantId}" data-name="${participantName}">
      <span class="joker-icon">${joker.icon}</span><span class="joker-name">${joker.name}</span><span class="joker-count">${count}</span>
      <span class="joker-disabled-reason">${alreadyUsed ? '(déjà utilisé)' : count <= 0 ? '(épuisé)' : ''}</span></div>`;
  });
  itemsHtml += '<div class="context-menu-divider"></div><div class="context-menu-item reset" data-action="reset" data-participant="'+participantId+'"><span class="joker-icon">🔄</span><span class="joker-name">Reset jokers (démo)</span></div>';
  
  contextMenu.querySelector('.context-menu-header').textContent = '🃏 Jokers de ' + participantName;
  contextMenu.querySelector('.context-menu-items').innerHTML = itemsHtml;
  contextMenu.style.left = e.pageX + 'px';
  contextMenu.style.top = e.pageY + 'px';
  contextMenu.classList.add('visible');
  contextMenu.querySelectorAll('.context-menu-item:not(.disabled)').forEach(item => { item.onclick = () => handleJokerMenuClick(item); });
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
  else { const r = useJoker(participantId, jokerId); if (r.success) { showNotification(JOKER_TYPES[jokerId].icon + ' ' + JOKER_TYPES[jokerId].name + ' activé !', 'success'); renderAll(); } else showNotification(r.error, 'error'); }
  hideContextMenu();
}

function showTargetSelector(participantId, participantName, jokerId) {
  const joker = JOKER_TYPES[jokerId], others = (seasonData?.active || []).filter(p => String(p.id) !== String(participantId));
  const modal = document.createElement('div');
  modal.className = 'joker-modal';
  modal.innerHTML = '<div class="joker-modal-content"><div class="joker-modal-header"><span>'+joker.icon+' '+joker.name+'</span><button class="joker-modal-close">✕</button></div><div class="joker-modal-body"><p>Choisir la cible :</p><div class="target-list">'+others.map(p => '<div class="target-option" data-id="'+p.id+'" data-name="'+p.name+'"><div class="target-avatar" style="background:linear-gradient(135deg,'+getAthleteColor(p.id)+','+getAthleteColor(p.id)+'88)">'+getAthleteInitials(p.id)+'</div><span>'+p.name+'</span></div>').join('')+'</div>'+(jokerId === 'duel' ? '<div class="duel-criteria"><p>Format :</p><select id="duelCriteria"><option value="total">D+ Total</option><option value="single">Plus grosse sortie</option></select></div>' : '')+'</div></div>';
  document.body.appendChild(modal);
  modal.querySelector('.joker-modal-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.querySelectorAll('.target-option').forEach(opt => {
    opt.onclick = () => {
      const r = useJoker(participantId, jokerId, { targetId: opt.dataset.id, targetName: opt.dataset.name });
      if (r.success) { showNotification(joker.icon + ' ' + joker.name + ' activé contre ' + opt.dataset.name + ' !', 'success'); renderAll(); }
      modal.remove();
    };
  });
}

function showDaySelector(participantId, participantName, jokerId) {
  const joker = JOKER_TYPES[jokerId], roundDates = getRoundDates(currentRoundNumber);
  const days = [];
  for (let i = 0; i < 5; i++) { const d = new Date(roundDates.start); d.setDate(d.getDate() + i); days.push({ index: i, label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) }); }
  const modal = document.createElement('div');
  modal.className = 'joker-modal';
  modal.innerHTML = '<div class="joker-modal-content"><div class="joker-modal-header"><span>'+joker.icon+' '+joker.name+'</span><button class="joker-modal-close">✕</button></div><div class="joker-modal-body"><p>Choisir le jour à doubler :</p><div class="day-list">'+days.map(d => '<div class="day-option" data-index="'+d.index+'"><span class="day-label">'+d.label+'</span><span class="day-bonus">×2</span></div>').join('')+'</div></div></div>';
  document.body.appendChild(modal);
  modal.querySelector('.joker-modal-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.querySelectorAll('.day-option').forEach(opt => {
    opt.onclick = () => {
      const r = useJoker(participantId, jokerId, { dayIndex: parseInt(opt.dataset.index) });
      if (r.success) { showNotification(joker.icon + ' Multiplicateur ×2 activé !', 'success'); renderAll(); }
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
  const rule = ROUND_RULES[ruleId] || ROUND_RULES.standard;
  const ranking = [];
  for (const p of participants) {
    const pActivities = filterByParticipant(activities, p.id);
    let elevation = pActivities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
    if (ruleId === 'handicap' && seasonNum > 1 && yearlyStandings) {
      const standing = yearlyStandings.find(s => s.participant.id === p.id);
      if (standing && standing.rank <= 5) elevation = Math.round(elevation * (100 - (rule.parameters?.malusPerPosition?.[standing.rank] || 0)) / 100);
    }
    ranking.push({ participant: p, totalElevation: elevation, activitiesCount: pActivities.length, activities: pActivities });
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
    const ranking = calculateRanking(roundActivities, active);
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
    const ranking = calculateRanking(roundActivities, activeAtRound);
    rounds.push({ roundInSeason: r, globalRound, dates: roundDates, rule: roundInfo?.rule || ROUND_RULES.standard, winner: ranking[0]?.participant, winnerElevation: ranking[0]?.totalElevation || 0, eliminated: sData.eliminated.filter(e => e.roundInSeason === r).map(e => e.name) });
  }
  return { seasonNumber, dates: seasonDates, isComplete: sData.seasonComplete, winner: sData.winner, rounds, eliminatedRanking: calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate) };
}

// ============================================
// RENDU UI
// ============================================
async function init() {
  console.log('🚀 Initialisation Versant...');
  allActivities = await loadActivities();
  console.log('📊 ' + allActivities.length + ' activités chargées');
  initializeJokersState();
  const today = getCurrentDate();
  currentSeasonNumber = getSeasonNumber(today);
  currentRoundNumber = getGlobalRoundNumber(today);
  yearlyStandingsCache = calculateYearlyStandings(allActivities, today);
  seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);
  renderAll();
  setupDateSlider();
  injectContextMenuStyles();
}

function renderAll() {
  const today = getCurrentDate();
  currentSeasonNumber = getSeasonNumber(today);
  currentRoundNumber = getGlobalRoundNumber(today);
  seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, today);
  yearlyStandingsCache = calculateYearlyStandings(allActivities, today);
  renderSeasonBanner();
  renderRoundBanner();
  renderRanking();
  renderEliminatedChallenge();
  renderFinalStandings();
  renderParticipants();
  renderHistorySection();
}

function renderSeasonBanner() {
  const banner = document.getElementById('seasonBanner'); if (!banner) return;
  const seasonDates = getSeasonDates(currentSeasonNumber), today = getCurrentDate();
  const progress = Math.min(100, Math.max(0, (today - seasonDates.start) / (seasonDates.end - seasonDates.start) * 100));
  banner.innerHTML = '<div class="season-info"><span class="season-label">Saison '+currentSeasonNumber+'</span><span class="season-dates">'+formatDateRange(seasonDates.start, seasonDates.end)+'</span></div><div class="season-progress"><div class="season-progress-bar" style="width: '+progress+'%"></div></div><div class="season-stats"><span class="stat"><strong>'+(seasonData?.active?.length || 0)+'</strong> en course</span><span class="stat"><strong>'+(seasonData?.eliminated?.length || 0)+'</strong> éliminés</span></div>';
}

function renderRoundBanner() {
  const banner = document.getElementById('roundBanner'); if (!banner) return;
  const roundDates = getRoundDates(currentRoundNumber), roundInfo = getRoundInfo(currentRoundNumber), roundInSeason = getRoundInSeason(getCurrentDate()), today = getCurrentDate();
  const isRoundActive = today >= roundDates.start && today <= roundDates.end, daysLeft = Math.max(0, Math.ceil((roundDates.end - today) / 86400000));
  const ruleInfo = roundInfo?.rule?.isSpecial ? '<div class="round-rule"><span class="rule-icon">'+roundInfo.rule.icon+'</span><span class="rule-name">'+roundInfo.rule.name+'</span></div>' : '';
  banner.innerHTML = '<div class="round-info"><span class="round-number">Round '+roundInSeason+'</span><span class="round-dates">'+formatDateRange(roundDates.start, roundDates.end)+'</span>'+(isRoundActive ? '<span class="round-countdown">'+daysLeft+'j restants</span>' : '')+'</div>'+ruleInfo;
}

function renderRanking() {
  const container = document.getElementById('rankingContainer'); if (!container) return;
  if (seasonData?.seasonComplete) { container.innerHTML = '<div class="empty-state"><p>🏆 Saison terminée ! Champion : '+(seasonData.winner?.name || 'N/A')+'</p></div>'; return; }
  
  const roundDates = getRoundDates(currentRoundNumber), today = getCurrentDate();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const roundInfo = getRoundInfo(currentRoundNumber);
  let ranking = calculateRanking(roundActivities, seasonData?.active || [], roundInfo?.rule?.id || 'standard', yearlyStandingsCache, currentSeasonNumber);
  ranking = applyJokerEffects(ranking);
  const seasonDates = getSeasonDates(currentSeasonNumber);
  
  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ Round</div><div>D+ Saison</div><div>Jokers</div></div>';
  ranking.forEach((e, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '', rowClass = e.isInDangerZone ? 'danger-zone' : '';
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, endDate), e.participant.id));
    const tooltip = generateActivitiesTooltip(e.activities);
    const elevationHtml = formatElevationWithBonuses(e.totalElevation, e.jokerEffects?.bonuses || {});
    const status = getJokerStatusForRound(e.participant.id, currentRoundNumber), stock = status.stock;
    
    let jokersHtml = '';
    status.active.forEach(j => { const joker = JOKER_TYPES[j.jokerId]; if (joker) jokersHtml += '<span class="joker-badge joker-active" title="ACTIF: '+joker.name+(j.targetName ? ' → '+j.targetName : '')+'">'+joker.icon+'</span>'; });
    Object.entries(stock).forEach(([jokerId, count]) => { if (count > 0 && JOKER_TYPES[jokerId] && !status.active.some(j => j.jokerId === jokerId)) jokersHtml += '<span class="joker-badge joker-available" title="'+JOKER_TYPES[jokerId].name+': '+count+'">'+JOKER_TYPES[jokerId].icon+'<sub>'+count+'</sub></span>'; });
    
    let duelIndicator = '';
    if (e.jokerEffects?.duel) { const d = e.jokerEffects.duel; duelIndicator = d.isChallenger ? '<span class="duel-indicator" title="Duel vs '+d.target+'">⚔️</span>' : '<span class="duel-indicator target" title="Défié par '+d.challenger+'">🎯</span>'; }
    
    html += '<div class="ranking-row '+rowClass+'" data-participant-id="'+e.participant.id+'" data-participant-name="'+e.participant.name+'"><div class="ranking-position '+posClass+'">'+e.position+'</div><div class="ranking-athlete tooltip-wrapper"><div class="athlete-avatar" style="background:linear-gradient(135deg,'+getAthleteColor(e.participant.id)+','+getAthleteColor(e.participant.id)+'88)">'+getAthleteInitials(e.participant.id)+'</div><div class="athlete-info"><span class="athlete-name">'+e.participant.name+duelIndicator+'</span><span class="athlete-status '+(e.isInDangerZone ? 'eliminated' : 'active')+'">'+(e.isInDangerZone ? '⚠️ Danger' : 'En course')+'</span></div><div class="tooltip-content">'+tooltip+'</div></div><div class="ranking-elevation">'+elevationHtml+'</div><div class="ranking-elevation season">'+formatElevation(seasonStats.totalElevation, false)+' <span>m</span></div><div class="ranking-jokers">'+(jokersHtml || '-')+'</div></div>';
  });
  container.innerHTML = html;
  container.querySelectorAll('.ranking-row').forEach(row => { row.addEventListener('contextmenu', (e) => showContextMenu(e, row.dataset.participantId, row.dataset.participantName)); });
}

function generateActivitiesTooltip(activities) {
  if (!activities || activities.length === 0) return '<div class="tooltip-empty">Aucune activité</div>';
  const sorted = [...activities].sort((a, b) => new Date(b.start_date) - new Date(a.start_date)).slice(0, 12);
  let html = '<div class="tooltip-activities">';
  sorted.forEach(a => { html += '<div class="tooltip-activity"><span class="tooltip-date">'+new Date(a.start_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })+'</span><span class="tooltip-name">'+(a.name || '').substring(0, 20)+'</span><span class="tooltip-elevation">+'+Math.round(a.total_elevation_gain || 0)+'m</span></div>'; });
  return html + '</div>';
}

function renderEliminatedChallenge() {
  const container = document.getElementById('eliminatedChallengeContainer'); if (!container) return;
  if (!seasonData?.eliminated?.length) { container.innerHTML = '<div class="empty-state"><p>Aucun éliminé cette saison</p></div>'; return; }
  const seasonDates = getSeasonDates(currentSeasonNumber), ranking = calculateEliminatedChallenge(allActivities, seasonData.eliminated, seasonDates, getCurrentDate());
  let html = '<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ cumulé</div><div>Éliminé</div><div>Points</div></div>';
  ranking.forEach(e => { html += '<div class="ranking-row"><div class="ranking-position">'+e.position+'</div><div class="ranking-athlete"><div class="athlete-avatar" style="background:linear-gradient(135deg,'+getAthleteColor(e.participant.id)+','+getAthleteColor(e.participant.id)+'88)">'+getAthleteInitials(e.participant.id)+'</div><div class="athlete-info"><span class="athlete-name">'+e.participant.name+'</span><span class="athlete-status eliminated">'+e.daysSinceElimination+'j</span></div></div><div class="ranking-elevation">'+formatElevation(e.totalElevation, false)+' <span>m</span></div><div class="ranking-round">R'+(e.eliminatedRound % getRoundsPerSeason() || getRoundsPerSeason())+'</div><div class="ranking-points"><span class="points-badge">'+e.points+' pts</span></div></div>'; });
  container.innerHTML = html;
}

function renderFinalStandings() {
  const container = document.getElementById('finalStandingsContainer'); if (!container) return;
  const activeIds = new Set((seasonData?.active || []).map(p => p.id)), standings = yearlyStandingsCache || [];
  let html = '<div class="standings-header"><div>Rang</div><div>Athlète</div><div>Pts Principal</div><div>Pts Éliminés</div><div>Total</div></div>';
  standings.forEach(e => { const isActive = activeIds.has(e.participant.id), wins = e.wins > 0 ? '<span class="wins-badge">🏆×'+e.wins+'</span>' : '';
    html += '<div class="standings-row '+(isActive ? '' : 'eliminated')+'"><div class="standings-rank">'+e.rank+'</div><div class="standings-athlete"><div class="athlete-avatar-small" style="background:linear-gradient(135deg,'+getAthleteColor(e.participant.id)+','+getAthleteColor(e.participant.id)+'88)">'+getAthleteInitials(e.participant.id)+'</div><span>'+e.participant.name+'</span>'+wins+(isActive ? '<span class="active-badge">En course</span>' : '')+'</div><div class="standings-points main">'+(e.totalMainPoints || '-')+'</div><div class="standings-points eliminated">'+(e.totalEliminatedPoints || '-')+'</div><div class="standings-total">'+e.totalPoints+'</div></div>';
  });
  container.innerHTML = html;
}

function renderParticipants() {
  const container = document.getElementById('participantsGrid'); if (!container) return;
  const roundDates = getRoundDates(currentRoundNumber), seasonDates = getSeasonDates(currentSeasonNumber), today = getCurrentDate();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const ranking = calculateRanking(roundActivities, seasonData?.active || []);
  const posMap = {}; ranking.forEach(e => posMap[e.participant.id] = e);
  
  let html = '';
  PARTICIPANTS.forEach(p => {
    const isElim = seasonData?.eliminated?.some(e => e.id === p.id), elimData = seasonData?.eliminated?.find(e => e.id === p.id);
    const entry = posMap[p.id] || { totalElevation: 0, position: '-' };
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, today), p.id));
    const stock = getJokerStock(p.id);
    const jokersHtml = Object.entries(stock).filter(([jId, c]) => c > 0 && JOKER_TYPES[jId]).map(([jId, c]) => '<span class="joker-badge" title="'+JOKER_TYPES[jId].name+': '+c+'">'+JOKER_TYPES[jId].icon+'<sub>'+c+'</sub></span>').join('') || '<span style="color:var(--text-muted);font-size:0.8rem">Aucun</span>';
    html += '<div class="participant-card '+(isElim ? 'eliminated' : '')+'" data-participant-id="'+p.id+'" data-participant-name="'+p.name+'"><div class="participant-header"><div class="participant-avatar" style="background:linear-gradient(135deg,'+getAthleteColor(p.id)+','+getAthleteColor(p.id)+'88)">'+getAthleteInitials(p.id)+'</div><div><div class="participant-name">'+p.name+'</div><div class="athlete-status '+(isElim ? 'eliminated' : 'active')+'">'+(isElim ? 'Éliminé R'+elimData?.roundInSeason : formatPosition(entry.position))+'</div></div></div><div class="participant-stats"><div class="stat-item"><div class="stat-value">'+formatElevation(entry.totalElevation || 0, false)+'</div><div class="stat-label">D+ round</div></div><div class="stat-item"><div class="stat-value">'+formatElevation(seasonStats.totalElevation, false)+'</div><div class="stat-label">D+ saison</div></div></div><div class="participant-jokers">'+jokersHtml+'</div></div>';
  });
  container.innerHTML = html;
  container.querySelectorAll('.participant-card:not(.eliminated)').forEach(card => { card.addEventListener('contextmenu', (e) => showContextMenu(e, card.dataset.participantId, card.dataset.participantName)); });
}

function renderHistorySection() {
  const container = document.getElementById('historyTimeline'); if (!container) return;
  const completedSeasons = [];
  for (let s = 1; s < currentSeasonNumber; s++) { const summary = getSeasonSummary(allActivities, s, getCurrentDate()); if (summary.isComplete) completedSeasons.push(summary); }
  container.innerHTML = '<div class="history-controls"><label>Saison : </label><select id="seasonSelect" class="season-select"><option value="current">Saison '+currentSeasonNumber+' (en cours)</option>'+completedSeasons.map(s => '<option value="'+s.seasonNumber+'">Saison '+s.seasonNumber+' - '+(s.winner?.name || 'N/A')+' 🏆</option>').join('')+'</select></div><div id="historyContent"></div>';
  const select = document.getElementById('seasonSelect'), content = document.getElementById('historyContent');
  const renderSeasonHistory = (seasonNum) => {
    if (seasonNum === 'current') {
      if (!seasonData?.eliminated?.length) { content.innerHTML = '<div class="history-item"><div class="history-round">Saison '+currentSeasonNumber+'</div><div class="history-title">Aucune élimination</div></div>'; return; }
      const byRound = {}; seasonData.eliminated.forEach(p => { if (!byRound[p.roundInSeason]) byRound[p.roundInSeason] = []; byRound[p.roundInSeason].push(p); });
      content.innerHTML = Object.keys(byRound).sort((a, b) => a - b).map(r => '<div class="history-item"><div class="history-round">Round '+r+'</div><div class="history-title">Éliminé(s) : '+byRound[r].map(p => p.name).join(', ')+'</div></div>').join('');
    } else {
      const summary = getSeasonSummary(allActivities, parseInt(seasonNum), getCurrentDate());
      let h = '<div class="history-season-summary"><h3>🏆 Champion : '+(summary.winner?.name || 'N/A')+'</h3></div>';
      summary.rounds.forEach(r => { h += '<div class="history-item '+(r.rule.isSpecial ? 'special-round' : '')+'"><div class="history-round">Round '+r.roundInSeason+(r.rule.isSpecial ? ' <span class="rule-badge">'+r.rule.icon+'</span>' : '')+'</div><div class="history-title">'+(r.eliminated.length ? 'Éliminé(s) : '+r.eliminated.join(', ') : 'Aucun éliminé')+'</div></div>'; });
      content.innerHTML = h;
    }
  };
  select.addEventListener('change', (e) => renderSeasonHistory(e.target.value));
  renderSeasonHistory('current');
}

// ============================================
// DATE SLIDER (DÉMO)
// ============================================
function setupDateSlider() {
  const container = document.getElementById('dateSliderContainer'); if (!container) return;
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate || '2025-02-01'), yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate || '2025-12-31'), today = getCurrentDate();
  const totalDays = Math.ceil((yearEnd - yearStart) / 86400000), currentDay = Math.ceil((today - yearStart) / 86400000);
  container.innerHTML = '<div class="date-slider-wrapper"><button class="slider-btn prev" id="prevDay">◀</button><div class="slider-container"><input type="range" id="dateSlider" min="0" max="'+totalDays+'" value="'+currentDay+'"><div class="slider-date" id="sliderDate">'+formatDate(today)+'</div></div><button class="slider-btn next" id="nextDay">▶</button></div>';
  const slider = document.getElementById('dateSlider'), dateLabel = document.getElementById('sliderDate');
  const updateDate = (dayOffset) => { const newDate = new Date(yearStart); newDate.setDate(newDate.getDate() + dayOffset); setSimulatedDate(newDate); dateLabel.textContent = formatDate(newDate); renderAll(); };
  slider.addEventListener('input', (e) => updateDate(parseInt(e.target.value)));
  document.getElementById('prevDay').addEventListener('click', () => { slider.value = Math.max(0, parseInt(slider.value) - 1); updateDate(parseInt(slider.value)); });
  document.getElementById('nextDay').addEventListener('click', () => { slider.value = Math.min(totalDays, parseInt(slider.value) + 1); updateDate(parseInt(slider.value)); });
}

// ============================================
// STYLES CSS POUR LE MENU CONTEXTUEL ET BONUS
// ============================================
function injectContextMenuStyles() {
  if (document.getElementById('joker-context-styles')) return;
  const styles = document.createElement('style');
  styles.id = 'joker-context-styles';
  styles.textContent = `
    .joker-context-menu{position:absolute;background:rgba(15,23,42,.98);border:1px solid rgba(249,115,22,.3);border-radius:12px;padding:8px 0;min-width:220px;box-shadow:0 10px 40px rgba(0,0,0,.5);z-index:9999;opacity:0;transform:scale(.95);pointer-events:none;transition:all .15s}
    .joker-context-menu.visible{opacity:1;transform:scale(1);pointer-events:auto}
    .context-menu-header{padding:12px 16px;font-weight:600;color:#f97316;border-bottom:1px solid rgba(255,255,255,.1);font-size:14px}
    .context-menu-items{padding:8px 0}.context-menu-item{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;transition:background .15s}
    .context-menu-item:hover:not(.disabled){background:rgba(249,115,22,.15)}.context-menu-item.disabled{opacity:.4;cursor:not-allowed}
    .context-menu-item .joker-icon{font-size:20px}.context-menu-item .joker-name{flex:1;color:rgba(255,255,255,.9)}
    .context-menu-item .joker-count{background:rgba(249,115,22,.2);color:#f97316;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
    .context-menu-item .joker-disabled-reason{font-size:11px;color:rgba(255,255,255,.4)}
    .context-menu-divider{height:1px;background:rgba(255,255,255,.1);margin:8px 0}
    .joker-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:10000}
    .joker-modal-content{background:rgba(15,23,42,.98);border:1px solid rgba(249,115,22,.3);border-radius:16px;width:90%;max-width:400px;overflow:hidden}
    .joker-modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:rgba(249,115,22,.1);font-weight:600;color:#f97316}
    .joker-modal-close{background:none;border:none;color:rgba(255,255,255,.5);font-size:20px;cursor:pointer}
    .joker-modal-body{padding:20px}.joker-modal-body p{margin-bottom:16px;color:rgba(255,255,255,.8)}
    .target-list,.day-list{display:flex;flex-direction:column;gap:8px}
    .target-option,.day-option{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;cursor:pointer;transition:all .15s}
    .target-option:hover,.day-option:hover{background:rgba(249,115,22,.15);border-color:rgba(249,115,22,.3)}
    .target-avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;color:#fff}
    .day-option{justify-content:space-between}.day-bonus{color:#22d3ee;font-weight:600}
    .duel-criteria{margin-top:20px}.duel-criteria select{width:100%;padding:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.2);border-radius:8px;color:#fff;margin-top:8px}
    .notification{position:fixed;bottom:100px;left:50%;transform:translateX(-50%) translateY(20px);padding:12px 24px;border-radius:8px;font-weight:500;opacity:0;transition:all .3s;z-index:10001}
    .notification.visible{opacity:1;transform:translateX(-50%) translateY(0)}
    .notification-success{background:rgba(16,185,129,.9);color:#fff}.notification-error{background:rgba(239,68,68,.9);color:#fff}
    .elevation-bonuses{font-size:11px;color:rgba(255,255,255,.6);margin-top:2px}
    .bonus-detail{display:inline-block;padding:1px 6px;border-radius:4px;margin-right:4px}
    .bonus-detail.multiplier{background:rgba(34,211,238,.2);color:#22d3ee}
    .bonus-detail.duel-won{background:rgba(16,185,129,.2);color:#10b981}
    .bonus-detail.duel-lost,.bonus-detail.sabotage{background:rgba(239,68,68,.2);color:#ef4444}
    .duel-indicator{margin-left:6px;font-size:14px}.duel-indicator.target{color:#ef4444}
    .joker-badge{display:inline-flex;align-items:center;padding:2px 6px;border-radius:6px;font-size:16px;margin:0 2px}
    .joker-badge sub{font-size:10px;margin-left:2px;color:rgba(255,255,255,.7)}
    .joker-badge.joker-active{background:rgba(16,185,129,.3);box-shadow:0 0 8px rgba(16,185,129,.4)}
    .joker-badge.joker-available{background:rgba(255,255,255,.1);opacity:.7}
    .ranking-row,.participant-card:not(.eliminated){cursor:context-menu}
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

window.versant = { getCurrentDate, setSimulatedDate, refresh: renderAll, useJoker, getJokerStock };