/**
 * ============================================
 * VERSANT 2026 - APPLICATION PRINCIPALE
 * ============================================
 * Charge les données depuis l'API backend
 */

import { 
  CHALLENGE_CONFIG,
  getSeasonType,
  getMainChallengePoints,
  getEliminatedChallengePoints,
  isValidSport,
  JOKER_TYPES
} from './config-2026.js';

// ============================================
// ÉTAT GLOBAL
// ============================================
let allActivities = [];
let participants = [];
let currentUser = null;

// ============================================
// CONFIGURATION API
// ============================================
const API_BASE = '/api';
const LEAGUE_ID = CHALLENGE_CONFIG.leagueId;

// ============================================
// UTILITAIRES DE FORMATAGE
// ============================================
const formatDate = (date, opts = {}) => new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', ...opts });
const formatDateShort = (date) => formatDate(date, { month: 'short', year: undefined });
const formatElevation = (v, unit = true) => unit ? `${Math.round(v).toLocaleString('fr-FR')} m` : Math.round(v).toLocaleString('fr-FR');

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

// ============================================
// CHARGEMENT DES DONNÉES DEPUIS L'API
// ============================================
async function loadParticipants() {
  try {
    const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    if (!res.ok) throw new Error('Erreur chargement participants');
    participants = await res.json();
    return participants;
  } catch (error) {
    console.error('Erreur chargement participants:', error);
    return [];
  }
}

async function loadActivities() {
  try {
    const res = await fetch(`${API_BASE}/activities/${LEAGUE_ID}`);
    if (!res.ok) throw new Error('Erreur chargement activités');
    const data = await res.json();
    
    // Normaliser les données
    allActivities = data.map(a => ({
      ...a,
      athlete_id: String(a.athlete_id),
      date: a.start_date?.split('T')[0] || a.date
    }));
    
    return allActivities;
  } catch (error) {
    console.error('Erreur chargement activités:', error);
    return [];
  }
}

// ============================================
// CALCULS DE DATES ET ROUNDS
// ============================================
function getCurrentDate() {
  return new Date();
}

function getRoundInfo(roundNumber) {
  const startDate = new Date(CHALLENGE_CONFIG.yearStartDate);
  startDate.setDate(startDate.getDate() + (roundNumber - 1) * CHALLENGE_CONFIG.roundDurationDays);
  
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + CHALLENGE_CONFIG.roundDurationDays - 1);
  
  return {
    roundNumber,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    durationDays: CHALLENGE_CONFIG.roundDurationDays
  };
}

function getCurrentRound() {
  const now = getCurrentDate();
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  
  if (now < start) {
    return { current: false, nextRound: 1, daysUntilStart: Math.ceil((start - now) / (1000 * 60 * 60 * 24)) };
  }
  
  const daysSinceStart = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const currentRound = Math.floor(daysSinceStart / CHALLENGE_CONFIG.roundDurationDays) + 1;
  
  return { current: true, roundNumber: currentRound };
}

// ============================================
// AFFICHAGE DU BANDEAU DE SAISON
// ============================================
function renderSeasonBanner() {
  const banner = document.getElementById('seasonBanner');
  if (!banner) return;
  
  const roundInfo = getCurrentRound();
  
  if (!roundInfo.current) {
    // Avant le début de la ligue
    const startDate = new Date(CHALLENGE_CONFIG.yearStartDate);
    const rule = getNextRoundRule(1);
    
    banner.innerHTML = `
      <div class="season-info">
        <div class="season-badge">🚀 Pré-saison</div>
        <div class="season-title">Le challenge démarre le ${formatDate(startDate)}</div>
        <div class="season-meta">
          ${CHALLENGE_CONFIG.roundDurationDays} jours par round • ${CHALLENGE_CONFIG.eliminationsPerRound} éliminations par round
        </div>
      </div>
      <div class="season-stats">
        <div class="stat-item" style="flex: 2;">
          <div class="stat-label" style="margin-bottom: 8px;">⏱️ Compte à rebours</div>
          <div class="stat-value" id="countdown" style="font-size: 20px; color: #f97316;">--:--:--:--</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">${participants.length}</div>
          <div class="stat-label">Participants</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Règle Round 1</div>
          <div class="stat-value" style="font-size: 16px;">${rule.icon} ${rule.name}</div>
        </div>
      </div>
    `;
    
    // Compte à rebours en temps réel
    updateCountdown(startDate);
  } else {
    // Ligue en cours
    const round = getRoundInfo(roundInfo.roundNumber);
    const rule = getNextRoundRule(roundInfo.roundNumber);
    
    banner.innerHTML = `
      <div class="season-info">
        <div class="season-badge">Saison 1 • Round ${roundInfo.roundNumber}</div>
        <div class="season-title">${formatDateRange(round.startDate, round.endDate)}</div>
        <div class="season-meta">
          ${CHALLENGE_CONFIG.eliminationsPerRound} derniers éliminés à la fin du round
        </div>
      </div>
      <div class="season-stats">
        <div class="stat-item">
          <div class="stat-value">${participants.length}</div>
          <div class="stat-label">Participants actifs</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Règle spéciale</div>
          <div class="stat-value" style="font-size: 16px;">${rule.icon} ${rule.name}</div>
        </div>
      </div>
    `;
  }
}

function getNextRoundRule(roundNumber) {
  // Logique simplifiée - à adapter selon vos règles
  const rules = [
    { name: "Standard", icon: "📊" },
    { name: "Standard", icon: "📊" },
    { name: "Standard", icon: "📊" },
    { name: "Pente raide", icon: "⛰️" },
    { name: "Standard", icon: "📊" }
  ];
  
  const index = (roundNumber - 1) % rules.length;
  return rules[index];
}

function updateCountdown(targetDate) {
  const countdownEl = document.getElementById('countdown');
  if (!countdownEl) return;
  
  function update() {
    const now = new Date();
    const diff = targetDate - now;
    
    if (diff <= 0) {
      countdownEl.innerHTML = '<span style="color: #10b981;">C\'est parti !</span>';
      clearInterval(interval);
      // Recharger la page quand la ligue commence
      setTimeout(() => location.reload(), 2000);
      return;
    }
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    // Format JJ:HH:MM:SS
    const pad = (n) => String(n).padStart(2, '0');
    countdownEl.innerHTML = `
      <span style="font-family: 'Space Mono', monospace; font-size: 1.2em;">
        ${pad(days)}<span style="color: rgba(255,255,255,0.4);">j</span>
        ${pad(hours)}<span style="color: rgba(255,255,255,0.4);">h</span>
        ${pad(minutes)}<span style="color: rgba(255,255,255,0.4);">m</span>
        ${pad(seconds)}<span style="color: rgba(255,255,255,0.4);">s</span>
      </span>
    `;
  }
  
  update();
  const interval = setInterval(update, 1000); // Mise à jour chaque seconde
}

// ============================================
// AFFICHAGE DU CLASSEMENT
// ============================================
function renderRanking() {
  const container = document.getElementById('rankingContainer');
  if (!container) return;
  
  const roundInfo = getCurrentRound();
  
  if (!roundInfo.current) {
    container.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; color: rgba(255,255,255,0.6);">
        <div style="font-size: 48px; margin-bottom: 16px;">◭</div>
        <h3 style="font-size: 24px; margin-bottom: 12px; color: rgba(255,255,255,0.9);">
          La ligue démarre le ${formatDate(CHALLENGE_CONFIG.yearStartDate)}
        </h3>
        <p>Le classement s'affichera dès le début du Round 1</p>
        <a href="inscription.html" class="btn-primary" style="display: inline-block; margin-top: 24px; padding: 12px 24px; border-radius: 8px; text-decoration: none; background: linear-gradient(135deg, #f97316, #f43f5e); color: white;">
          Rejoindre la ligue
        </a>
      </div>
    `;
    return;
  }
  
  // Calculer le classement pour le round actuel
  const round = getRoundInfo(roundInfo.roundNumber);
  const roundActivities = allActivities.filter(a => {
    const actDate = new Date(a.date);
    const start = new Date(round.startDate);
    const end = new Date(round.endDate);
    return actDate >= start && actDate <= end;
  });
  
  // Calculer D+ par athlète
  const rankings = participants.map(p => {
    const athleteActivities = roundActivities.filter(a => a.athlete_id === p.id);
    const totalElevation = athleteActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    
    return {
      ...p,
      elevation: totalElevation,
      activities: athleteActivities
    };
  }).sort((a, b) => b.elevation - a.elevation);
  
  if (rankings.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; color: rgba(255,255,255,0.6);">
        <p>Aucune activité pour ce round</p>
      </div>
    `;
    return;
  }
  
  // Afficher le classement
  container.innerHTML = rankings.map((athlete, index) => {
    const position = index + 1;
    const maxElevation = rankings[0].elevation || 1;
    const percentage = (athlete.elevation / maxElevation) * 100;
    const color = getAthleteColor(athlete.id);
    
    const isEliminated = position > rankings.length - CHALLENGE_CONFIG.eliminationsPerRound;
    
    return `
      <div class="ranking-item ${isEliminated ? 'danger-zone' : ''}">
        <div class="ranking-position">${position}</div>
        <div class="ranking-athlete">
          <div class="athlete-avatar" style="background: ${color}">
            ${athlete.name.split(' ').map(n => n[0]).join('')}
          </div>
          <div class="athlete-info">
            <div class="athlete-name">${athlete.name}</div>
            <div class="athlete-stats">${athlete.activities.length} activités</div>
          </div>
        </div>
        <div class="ranking-value">
          ${formatElevation(athlete.elevation)}
        </div>
        <div class="ranking-bar">
          <div class="bar-fill" style="width: ${percentage}%; background: ${color}"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// AFFICHAGE DES PARTICIPANTS
// ============================================
function renderParticipants() {
  const grid = document.getElementById('participantsGrid');
  if (!grid) return;
  
  grid.innerHTML = participants.map(p => {
    const color = getAthleteColor(p.id);
    const initials = p.name.split(' ').map(n => n[0]).join('');
    
    return `
      <div class="participant-card">
        <div class="participant-avatar" style="background: ${color}">
          ${initials}
        </div>
        <div class="participant-name">${p.name}</div>
        <div class="participant-meta">
          Inscrit le ${formatDateShort(p.registered_at)}
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// GESTION DE LA CONNEXION
// ============================================
async function checkLoginStatus() {
  const dashboardLink = document.getElementById('dashboardLink');
  const loginLink = document.getElementById('loginLink');
  const token = localStorage.getItem('versant_token');
  
  if (token) {
    try {
      const response = await fetch(`${API_BASE}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        currentUser = await response.json();
        if (dashboardLink) dashboardLink.style.display = 'inline';
        if (loginLink) loginLink.style.display = 'none';
        return true;
      }
    } catch (error) {
      console.log('Token invalide');
    }
    // Token invalide
    localStorage.removeItem('versant_token');
    localStorage.removeItem('versant_athlete_id');
  }
  
  if (dashboardLink) dashboardLink.style.display = 'none';
  if (loginLink) loginLink.style.display = 'inline';
  return false;
}

// ============================================
// INITIALISATION
// ============================================
async function init() {
  console.log('🚀 Initialisation Versant 2026');
  
  // Afficher le loading
  const loading = document.getElementById('loadingScreen');
  if (loading) loading.style.display = 'flex';
  
  try {
    // Vérifier le statut de connexion
    await checkLoginStatus();
    
    // Charger les données
    await loadParticipants();
    await loadActivities();
    
    console.log(`✅ ${participants.length} participants`);
    console.log(`✅ ${allActivities.length} activités`);
    
    // Afficher les différentes sections
    renderSeasonBanner();
    renderRanking();
    renderParticipants();
    
    // Masquer le loading
    if (loading) {
      setTimeout(() => {
        loading.style.opacity = '0';
        setTimeout(() => loading.style.display = 'none', 300);
      }, 500);
    }
    
  } catch (error) {
    console.error('❌ Erreur initialisation:', error);
    
    if (loading) {
      loading.innerHTML = `
        <div class="loading-content">
          <div class="loading-icon" style="font-size: 64px;">⚠️</div>
          <div class="loading-title">Erreur de chargement</div>
          <div class="loading-text">${error.message}</div>
          <button onclick="location.reload()" style="margin-top: 20px; padding: 12px 24px; background: #f97316; border: none; border-radius: 8px; color: white; cursor: pointer;">
            Réessayer
          </button>
        </div>
      `;
    }
  }
}

// Démarrer l'application
document.addEventListener('DOMContentLoaded', init);
