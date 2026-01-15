/**
 * ============================================
 * VERSANT - APPLICATION PRINCIPALE UNIFIÉE
 * ============================================
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
let countdownInterval = null;

// ============================================
// GESTION DE LA DATE SIMULÉE
// ============================================
export function setSimulatedDate(date) {
  simulatedDate = date ? new Date(date) : null;
}

export function getCurrentDate() {
  return simulatedDate ? new Date(simulatedDate) : new Date();
}

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
// CHARGEMENT DES DONNÉES
// ============================================
async function loadActivities() {
  const cached = sessionStorage.getItem('versant_activities');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { sessionStorage.removeItem('versant_activities'); }
  }
  
  const paths = ['data/all_activities_2025.json', './data/all_activities_2025.json'];
  for (const path of paths) {
    try {
      const res = await fetch(path);
      if (res.ok) {
        const raw = await res.json();
        let data = Array.isArray(raw) ? raw : (raw.activities || []);
        data = data.filter(a => isValidSport(a.sport_type)).map(a => ({
          ...a,
          athlete_id: String(a.athlete?.id || a.athlete_id),
          date: a.start_date?.split('T')[0]
        }));
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
function filterByParticipant(activities, id) {
  return activities.filter(a => a.athlete_id === String(id));
}

function filterByPeriod(activities, start, end) {
  const s = new Date(start), e = new Date(end);
  e.setHours(23, 59, 59);
  return activities.filter(a => {
    const d = new Date(a.start_date);
    return d >= s && d <= e;
  });
}

function calculateStats(activities) {
  return {
    totalElevation: activities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
    totalDistance: activities.reduce((s, a) => s + (a.distance || 0), 0),
    totalTime: activities.reduce((s, a) => s + (a.moving_time || 0), 0),
    activitiesCount: activities.length
  };
}

function calculateRanking(activities, participants, ruleId = 'standard', yearlyStandings = null, seasonNum = 1) {
  const rule = ROUND_RULES[ruleId] || ROUND_RULES.standard;
  const ranking = [];
  
  for (const p of participants) {
    const pActivities = filterByParticipant(activities, p.id);
    let elevation = 0;
    
    if (ruleId === 'combinado') {
      // Combiné : D+ x2 si 2 sports différents le même jour
      const byDay = {};
      pActivities.forEach(a => {
        if (!byDay[a.date]) byDay[a.date] = { sports: new Set(), elevation: 0 };
        byDay[a.date].sports.add(a.sport_type);
        byDay[a.date].elevation += a.total_elevation_gain || 0;
      });
      for (const day in byDay) {
        const mult = byDay[day].sports.size >= 2 ? 2 : 1;
        elevation += byDay[day].elevation * mult;
      }
    } else {
      elevation = pActivities.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
    }
    
    // Appliquer le handicap si applicable
    if (ruleId === 'handicap' && seasonNum > 1 && yearlyStandings) {
      const standing = yearlyStandings.find(s => s.participant.id === p.id);
      if (standing && standing.rank <= 5) {
        const malus = rule.parameters?.malusPerPosition?.[standing.rank] || 0;
        elevation = Math.round(elevation * (100 - malus) / 100);
      }
    }
    
    ranking.push({ participant: p, totalElevation: elevation, activitiesCount: pActivities.length, activities: pActivities });
  }
  
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.isInDangerZone = i >= ranking.length - CHALLENGE_CONFIG.eliminationsPerRound;
  });
  
  return ranking;
}

// ============================================
// SIMULATION DES SAISONS
// ============================================
function simulateSeasonEliminations(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);
  const roundsPerSeason = getRoundsPerSeason();
  const elimPerRound = CHALLENGE_CONFIG.eliminationsPerRound;
  
  let active = [...PARTICIPANTS];
  const eliminated = [];
  let winner = null;
  let seasonComplete = false;
  
  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    
    if (currentDate <= new Date(roundDates.end)) break;
    if (active.length <= 1) { seasonComplete = true; winner = active[0]; break; }
    
    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end);
    const roundInfo = getRoundInfo(globalRound);
    const ranking = calculateRanking(roundActivities, active, roundInfo?.rule?.id || 'standard', yearlyStandingsCache, seasonNumber);
    
    const maxElim = Math.min(elimPerRound, active.length - 1);
    const toElim = ranking.slice(-maxElim);
    
    toElim.forEach((e, idx) => {
      eliminated.push({
        ...e.participant,
        eliminatedRound: globalRound,
        roundInSeason: r,
        seasonNumber,
        elevationAtElimination: e.totalElevation
      });
    });
    
    const elimIds = toElim.map(e => e.participant.id);
    active = active.filter(p => !elimIds.includes(p.id));
    
    if (active.length <= 1) { seasonComplete = true; winner = active[0]; }
  }
  
  return { eliminated, active, seasonComplete, winner, seasonNumber };
}

function calculateEliminatedChallenge(activities, eliminatedList, seasonDates, currentDate) {
  const ranking = [];
  const endDate = currentDate < seasonDates.end ? currentDate : seasonDates.end;
  
  for (const p of eliminatedList) {
    const roundDates = getRoundDates(p.eliminatedRound);
    const startDate = new Date(roundDates.end);
    startDate.setDate(startDate.getDate() + 1);
    if (startDate > endDate) continue;
    
    const acts = filterByPeriod(activities, startDate, endDate);
    const pActs = filterByParticipant(acts, p.id);
    const stats = calculateStats(pActs);
    
    ranking.push({
      participant: p,
      ...stats,
      eliminatedRound: p.eliminatedRound,
      daysSinceElimination: Math.max(0, Math.floor((endDate - startDate) / 86400000))
    });
  }
  
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.points = getEliminatedChallengePoints(e.position);
  });
  
  return ranking;
}

function calculateYearlyStandings(activities, currentDate) {
  const currentSeason = getSeasonNumber(currentDate);
  const totals = {};
  PARTICIPANTS.forEach(p => {
    totals[p.id] = { participant: p, totalMainPoints: 0, totalEliminatedPoints: 0, totalPoints: 0, wins: 0, seasonsPlayed: 0 };
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
        const elimIdx = sData.eliminated.findIndex(e => e.id === p.id);
        mainPts = getMainChallengePoints(PARTICIPANTS.length - elimIdx);
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
// HISTORIQUE DES SAISONS
// ============================================
function getSeasonSummary(activities, seasonNumber, currentDate) {
  const seasonDates = getSeasonDates(seasonNumber);
  const sData = simulateSeasonEliminations(activities, seasonNumber, currentDate);
  const elimRanking = calculateEliminatedChallenge(activities, sData.eliminated, seasonDates, sData.seasonComplete ? seasonDates.end : currentDate);
  
  // Détails par round
  const roundsPerSeason = getRoundsPerSeason();
  const rounds = [];
  
  for (let r = 1; r <= roundsPerSeason; r++) {
    const globalRound = (seasonNumber - 1) * roundsPerSeason + r;
    const roundDates = getRoundDates(globalRound);
    if (currentDate < new Date(roundDates.start)) break;
    
    const roundInfo = getRoundInfo(globalRound);
    const roundActivities = filterByPeriod(activities, roundDates.start, roundDates.end > currentDate ? currentDate : roundDates.end);
    
    // Participants actifs à ce round
    const activeAtRound = PARTICIPANTS.filter(p => {
      const elimBefore = sData.eliminated.find(e => e.id === p.id && e.roundInSeason < r);
      return !elimBefore;
    });
    
    const ranking = calculateRanking(roundActivities, activeAtRound, roundInfo?.rule?.id || 'standard');
    const winner = ranking[0];
    const eliminated = sData.eliminated.filter(e => e.roundInSeason === r);
    
    rounds.push({
      roundInSeason: r,
      globalRound,
      rule: roundInfo?.rule || ROUND_RULES.standard,
      dates: roundDates,
      winner: winner?.participant,
      winnerElevation: winner?.totalElevation || 0,
      eliminated: eliminated.map(e => e.name),
      isComplete: currentDate > new Date(roundDates.end)
    });
  }
  
  return {
    seasonNumber,
    dates: seasonDates,
    isComplete: sData.seasonComplete,
    winner: sData.winner,
    rounds,
    eliminatedRanking: elimRanking
  };
}

// ============================================
// INITIALISATION
// ============================================
async function init() {
  const loading = document.getElementById('loadingScreen');
  const loadingText = document.querySelector('.loading-text');
  
  try {
    if (loadingText) loadingText.textContent = 'Chargement des données...';
    allActivities = await loadActivities();
    
    initDateSlider();
    updateContext();
    
    renderAll();
    startCountdown();
    
    if (loading) loading.classList.add('hidden');
  } catch (error) {
    console.error('Erreur:', error);
    if (loadingText) loadingText.textContent = 'Erreur de chargement';
  }
}

function updateContext() {
  const date = getCurrentDate();
  currentRoundNumber = getGlobalRoundNumber(date);
  currentSeasonNumber = getSeasonNumber(date);
  yearlyStandingsCache = calculateYearlyStandings(allActivities, date);
  seasonData = simulateSeasonEliminations(allActivities, currentSeasonNumber, date);
}

// ============================================
// DATE SLIDER (EN BAS DE PAGE)
// ============================================
function initDateSlider() {
  const container = document.getElementById('dateSliderContainer');
  if (!container) return;
  
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const today = new Date();
  const initial = today < startDate ? startDate : (today > endDate ? endDate : today);
  const totalDays = Math.floor((endDate - startDate) / 86400000);
  const initialValue = Math.floor((initial - startDate) / 86400000);
  
  container.innerHTML = `
    <div class="date-slider-wrapper">
      <div class="date-slider-label">
        <span class="slider-icon">🗓️</span>
        <span class="slider-title">Date simulée</span>
        <button class="slider-btn" id="prevDay">◀</button>
        <span class="slider-date" id="sliderDateDisplay">${formatDate(initial, {day: 'numeric', month: 'short', year: 'numeric'})}</span>
        <button class="slider-btn" id="nextDay">▶</button>
      </div>
      <input type="range" id="dateSlider" min="0" max="${totalDays}" value="${initialValue}" class="date-slider">
      <div class="slider-bounds"><span>1 jan</span><span>31 déc</span></div>
    </div>
  `;
  
  const slider = document.getElementById('dateSlider');
  const update = (val) => {
    const newDate = new Date(startDate);
    newDate.setDate(newDate.getDate() + val);
    slider.value = val;
    document.getElementById('sliderDateDisplay').textContent = formatDate(newDate, {day: 'numeric', month: 'short', year: 'numeric'});
    setSimulatedDate(newDate);
    updateContext();
    renderAll();
    startCountdown();
  };
  
  slider.addEventListener('input', (e) => update(parseInt(e.target.value)));
  document.getElementById('prevDay').addEventListener('click', () => update(Math.max(0, parseInt(slider.value) - 1)));
  document.getElementById('nextDay').addEventListener('click', () => update(Math.min(totalDays, parseInt(slider.value) + 1)));
  
  setSimulatedDate(initial);
}

// ============================================
// COMPTE À REBOURS
// ============================================
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  
  const update = () => {
    const el = document.getElementById('eliminationCountdown');
    if (!el) return;
    
    if (seasonData?.seasonComplete) {
      el.innerHTML = '<span class="countdown-complete">🏆 Saison terminée</span>';
      return;
    }
    
    const roundDates = getRoundDates(currentRoundNumber);
    const now = getCurrentDate();
    const end = new Date(roundDates.end);
    end.setHours(23, 59, 59, 999);
    const diff = end - now;
    
    if (diff <= 0) {
      el.innerHTML = '<span class="countdown-complete">⚠️ Élimination !</span>';
      return;
    }
    
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    
    el.innerHTML = `
      <div class="countdown-grid">
        <div class="countdown-item"><span class="countdown-value">${String(d).padStart(2,'0')}</span><span class="countdown-unit">j</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-value">${String(h).padStart(2,'0')}</span><span class="countdown-unit">h</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-value">${String(m).padStart(2,'0')}</span><span class="countdown-unit">m</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-value">${String(s).padStart(2,'0')}</span><span class="countdown-unit">s</span></div>
      </div>
      <div class="countdown-label">avant élimination</div>
    `;
  };
  
  update();
  countdownInterval = setInterval(update, 1000);
}

// ============================================
// RENDU GLOBAL
// ============================================
function renderAll() {
  renderSeasonBanner();
  renderRoundBanner();
  renderRanking();
  renderEliminatedChallenge();
  renderFinalStandings();
  renderParticipants();
  renderHistorySection();
}

// ============================================
// BANNIÈRE SAISON
// ============================================
function renderSeasonBanner() {
  const container = document.getElementById('seasonBanner');
  if (!container) return;
  
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const roundsPerSeason = getRoundsPerSeason();
  const roundInSeason = getRoundInSeason(getCurrentDate());
  const status = seasonData?.seasonComplete ? 'Terminée' : 'En cours';
  
  container.innerHTML = `
    <div class="season-info">
      <span class="season-label">Saison ${status}</span>
      <div class="season-number">${currentSeasonNumber}</div>
      <div class="season-dates">${formatDateRange(seasonDates.start, seasonDates.end)}</div>
    </div>
    <div class="season-progress">
      <div class="progress-text">Round ${roundInSeason} / ${roundsPerSeason}</div>
      <div class="progress-bar-container"><div class="progress-bar" style="width:${(roundInSeason/roundsPerSeason)*100}%"></div></div>
      <div class="progress-detail">${seasonData?.active?.length || 0} joueurs • ${seasonData?.eliminated?.length || 0} éliminés</div>
    </div>
    <div class="season-countdown" id="eliminationCountdown"></div>
    ${seasonData?.winner ? `<div class="season-winner"><span class="winner-icon">🏆</span><span class="winner-name">${seasonData.winner.name}</span></div>` : ''}
  `;
}

// ============================================
// BANNIÈRE ROUND
// ============================================
function renderRoundBanner() {
  const container = document.getElementById('roundBanner');
  if (!container) return;
  
  const roundInfo = getRoundInfo(currentRoundNumber);
  const roundDates = getRoundDates(currentRoundNumber);
  const roundInSeason = getRoundInSeason(getCurrentDate());
  const isFinal = isFinaleRound(roundInSeason);
  const today = getCurrentDate();
  const status = today < new Date(roundDates.start) ? 'À venir' : (today > new Date(roundDates.end) ? 'Terminé' : 'En cours');
  
  container.innerHTML = `
    <div class="round-info">
      <span class="round-label">Round ${status} ${isFinal ? '🏆 FINALE' : ''}</span>
      <div class="round-number">${roundInSeason}/${getRoundsPerSeason()}</div>
      <div class="round-dates">${formatDateRange(roundDates.start, roundDates.end)}</div>
      ${!isFinal ? `<div class="round-eliminations">⚠️ ${CHALLENGE_CONFIG.eliminationsPerRound} élimination(s)</div>` : ''}
    </div>
    <div class="round-divider"></div>
    <div class="round-rule">
      <div class="rule-icon">${roundInfo?.rule?.icon || '📊'}</div>
      <div class="rule-name">${roundInfo?.rule?.name || 'Standard'}</div>
      <div class="rule-description">${roundInfo?.rule?.description || ''}</div>
    </div>
  `;
}

// ============================================
// CLASSEMENT DU ROUND
// ============================================
function renderRanking() {
  const container = document.getElementById('rankingContainer');
  if (!container) return;
  
  if (seasonData?.seasonComplete) {
    container.innerHTML = `<div class="empty-state"><p>🏆 Saison terminée ! Champion : ${seasonData.winner?.name || 'N/A'}</p></div>`;
    return;
  }
  
  const roundDates = getRoundDates(currentRoundNumber);
  const today = getCurrentDate();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);
  const roundInfo = getRoundInfo(currentRoundNumber);
  const ranking = calculateRanking(roundActivities, seasonData?.active || [], roundInfo?.rule?.id || 'standard', yearlyStandingsCache, currentSeasonNumber);
  const seasonDates = getSeasonDates(currentSeasonNumber);
  
  let html = `<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ Round</div><div>D+ Saison</div><div>Jokers</div></div>`;
  
  ranking.forEach((e, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rowClass = e.isInDangerZone ? 'danger-zone' : '';
    const seasonStats = calculateStats(filterByParticipant(filterByPeriod(allActivities, seasonDates.start, endDate), e.participant.id));
    const tooltip = generateActivitiesTooltip(e.activities);
    const jokers = (e.participant.jokers || []).map(j => JOKER_TYPES[j] ? `<span class="joker-badge" title="${JOKER_TYPES[j].name}">${JOKER_TYPES[j].icon}</span>` : '').join('');
    
    html += `
      <div class="ranking-row ${rowClass}">
        <div class="ranking-position ${posClass}">${e.position}</div>
        <div class="ranking-athlete tooltip-wrapper">
          <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
          <div class="athlete-info">
            <span class="athlete-name">${e.participant.name}</span>
            <span class="athlete-status ${e.isInDangerZone ? 'eliminated' : 'active'}">${e.isInDangerZone ? '⚠️ Danger' : 'En course'}</span>
          </div>
          <div class="tooltip-content">${tooltip}</div>
        </div>
        <div class="ranking-elevation">${formatElevation(e.totalElevation, false)} <span>m</span></div>
        <div class="ranking-elevation season">${formatElevation(seasonStats.totalElevation, false)} <span>m</span></div>
        <div class="ranking-jokers">${jokers || '-'}</div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

function generateActivitiesTooltip(activities) {
  if (!activities || activities.length === 0) return '<div class="tooltip-empty">Aucune activité</div>';
  const sorted = [...activities].sort((a, b) => new Date(b.start_date) - new Date(a.start_date)).slice(0, 12);
  let html = '<div class="tooltip-activities">';
  sorted.forEach(a => {
    const date = new Date(a.start_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    html += `<div class="tooltip-activity"><span class="tooltip-date">${date}</span><span class="tooltip-name">${(a.name || '').substring(0, 20)}</span><span class="tooltip-sport">${a.sport_type || ''}</span><span class="tooltip-elevation">+${Math.round(a.total_elevation_gain || 0)}m</span></div>`;
  });
  return html + '</div>';
}

// ============================================
// CHALLENGE DES ÉLIMINÉS
// ============================================
function renderEliminatedChallenge() {
  const container = document.getElementById('eliminatedChallengeContainer');
  if (!container) return;
  
  if (!seasonData?.eliminated?.length) {
    container.innerHTML = '<div class="empty-state"><p>Aucun éliminé cette saison</p></div>';
    return;
  }
  
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const ranking = calculateEliminatedChallenge(allActivities, seasonData.eliminated, seasonDates, getCurrentDate());
  
  let html = `<div class="ranking-header"><div>Pos.</div><div>Athlète</div><div>D+ cumulé</div><div>Éliminé</div><div>Points</div></div>`;
  
  ranking.forEach(e => {
    html += `
      <div class="ranking-row">
        <div class="ranking-position">${e.position}</div>
        <div class="ranking-athlete">
          <div class="athlete-avatar" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
          <div class="athlete-info"><span class="athlete-name">${e.participant.name}</span><span class="athlete-status eliminated">${e.daysSinceElimination}j</span></div>
        </div>
        <div class="ranking-elevation">${formatElevation(e.totalElevation, false)} <span>m</span></div>
        <div class="ranking-round">R${e.eliminatedRound % getRoundsPerSeason() || getRoundsPerSeason()}</div>
        <div class="ranking-points"><span class="points-badge">${e.points} pts</span></div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

// ============================================
// CLASSEMENT ANNUEL
// ============================================
function renderFinalStandings() {
  const container = document.getElementById('finalStandingsContainer');
  if (!container) return;
  
  const activeIds = new Set((seasonData?.active || []).map(p => p.id));
  const standings = yearlyStandingsCache || [];
  const completedSeasons = standings[0]?.seasonsPlayed || 0;
  
  let html = `<div class="standings-header"><div>Rang</div><div>Athlète</div><div>Pts Principal</div><div>Pts Éliminés</div><div>Total</div></div>`;
  
  standings.forEach(e => {
    const isActive = activeIds.has(e.participant.id);
    const wins = e.wins > 0 ? `<span class="wins-badge">🏆×${e.wins}</span>` : '';
    html += `
      <div class="standings-row ${isActive ? '' : 'eliminated'}">
        <div class="standings-rank">${e.rank}</div>
        <div class="standings-athlete">
          <div class="athlete-avatar-small" style="background:linear-gradient(135deg,${getAthleteColor(e.participant.id)},${getAthleteColor(e.participant.id)}88)">${getAthleteInitials(e.participant.id)}</div>
          <span>${e.participant.name}</span>${wins}${isActive ? '<span class="active-badge">En course</span>' : ''}
        </div>
        <div class="standings-points main">${e.totalMainPoints || '-'}</div>
        <div class="standings-points eliminated">${e.totalEliminatedPoints || '-'}</div>
        <div class="standings-total">${e.totalPoints}</div>
      </div>
    `;
  });
  
  html += `<div class="standings-footer"><p>📊 ${completedSeasons} saison(s) terminée(s) • Saison ${currentSeasonNumber} en cours</p></div>`;
  container.innerHTML = html;
}

// ============================================
// PARTICIPANTS
// ============================================
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
    const jokers = (p.jokers || []).map(j => JOKER_TYPES[j] ? `<span class="joker-badge">${JOKER_TYPES[j].icon}</span>` : '').join('');
    
    html += `
      <div class="participant-card ${isElim ? 'eliminated' : ''}">
        <div class="participant-header">
          <div class="participant-avatar" style="background:linear-gradient(135deg,${getAthleteColor(p.id)},${getAthleteColor(p.id)}88)">${getAthleteInitials(p.id)}</div>
          <div><div class="participant-name">${p.name}</div><div class="athlete-status ${isElim ? 'eliminated' : 'active'}">${isElim ? `Éliminé R${elimData?.roundInSeason}` : formatPosition(entry.position)}</div></div>
        </div>
        <div class="participant-stats">
          <div class="stat-item"><div class="stat-value">${formatElevation(entry.totalElevation || 0, false)}</div><div class="stat-label">D+ round</div></div>
          <div class="stat-item"><div class="stat-value">${formatElevation(seasonStats.totalElevation, false)}</div><div class="stat-label">D+ saison</div></div>
        </div>
        <div class="participant-jokers">${jokers || '<span style="color:var(--text-muted);font-size:0.8rem">Aucun</span>'}</div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

// ============================================
// HISTORIQUE DES SAISONS
// ============================================
function renderHistorySection() {
  const container = document.getElementById('historyTimeline');
  if (!container) return;
  
  const totalSeasons = Math.min(currentSeasonNumber, getTotalSeasons());
  const completedSeasons = [];
  for (let s = 1; s < currentSeasonNumber; s++) {
    const summary = getSeasonSummary(allActivities, s, getCurrentDate());
    if (summary.isComplete) completedSeasons.push(summary);
  }
  
  // Menu déroulant
  let html = `
    <div class="history-controls">
      <label>Saison : </label>
      <select id="seasonSelect" class="season-select">
        <option value="current">Saison ${currentSeasonNumber} (en cours)</option>
        ${completedSeasons.map(s => `<option value="${s.seasonNumber}">Saison ${s.seasonNumber} - ${s.winner?.name || 'N/A'} 🏆</option>`).join('')}
      </select>
    </div>
    <div id="historyContent"></div>
  `;
  
  container.innerHTML = html;
  
  const select = document.getElementById('seasonSelect');
  const content = document.getElementById('historyContent');
  
  const renderSeasonHistory = (seasonNum) => {
    if (seasonNum === 'current') {
      // Saison en cours
      if (!seasonData?.eliminated?.length) {
        content.innerHTML = `<div class="history-item"><div class="history-round">Saison ${currentSeasonNumber}</div><div class="history-title">Aucune élimination</div><div class="history-details">${PARTICIPANTS.length} participants en lice</div></div>`;
        return;
      }
      
      const byRound = {};
      seasonData.eliminated.forEach(p => {
        if (!byRound[p.roundInSeason]) byRound[p.roundInSeason] = [];
        byRound[p.roundInSeason].push(p);
      });
      
      let h = '';
      Object.keys(byRound).sort((a, b) => a - b).forEach(r => {
        const ps = byRound[r];
        h += `<div class="history-item"><div class="history-round">Round ${r}</div><div class="history-title">Éliminé(s) : ${ps.map(p => p.name).join(', ')}</div></div>`;
      });
      content.innerHTML = h;
    } else {
      // Saison passée
      const summary = getSeasonSummary(allActivities, parseInt(seasonNum), getCurrentDate());
      let h = `<div class="history-season-summary"><h3>🏆 Champion : ${summary.winner?.name || 'N/A'}</h3><p>${formatDateRange(summary.dates.start, summary.dates.end)}</p></div>`;
      
      summary.rounds.forEach(r => {
        const ruleIcon = r.rule.isSpecial ? `<span class="rule-badge">${r.rule.icon} ${r.rule.name}</span>` : '';
        const winnerInfo = r.winner ? `<span class="round-winner">👑 ${r.winner.name} (+${formatElevation(r.winnerElevation, false)}m)</span>` : '';
        
        h += `
          <div class="history-item ${r.rule.isSpecial ? 'special-round' : ''}">
            <div class="history-round">Round ${r.roundInSeason} ${ruleIcon}</div>
            <div class="history-title">${r.eliminated.length ? `Éliminé(s) : ${r.eliminated.join(', ')}` : 'Aucun éliminé'}</div>
            <div class="history-details">${winnerInfo}</div>
          </div>
        `;
      });
      
      // Classement des éliminés
      if (summary.eliminatedRanking.length) {
        h += `<div class="history-eliminated-title">Challenge des Éliminés</div>`;
        summary.eliminatedRanking.forEach(e => {
          h += `<div class="history-eliminated-row"><span>${e.position}.</span><span>${e.participant.name}</span><span>${formatElevation(e.totalElevation)}</span><span class="points-badge">${e.points} pts</span></div>`;
        });
      }
      
      content.innerHTML = h;
    }
  };
  
  select.addEventListener('change', (e) => renderSeasonHistory(e.target.value));
  renderSeasonHistory('current');
}

// ============================================
// ÉVÉNEMENTS
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  init();
  document.getElementById('loginBtn')?.addEventListener('click', () => window.location.href = 'login.html');
});

window.versant = { getCurrentDate, setSimulatedDate, refresh: renderAll };
