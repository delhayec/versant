/**
 * ============================================
 * DASHBOARD PERSONNEL - VERSANT 2026 v2.0
 * ============================================
 * - Jokers du challenge principal
 * - Bonus éphémères du challenge des éliminés
 */

import { 
  CHALLENGE_CONFIG, JOKER_TYPES, BONUS_TYPES,
  getRoundDates as _getRoundDates, 
  getGlobalRoundNumber,
  getSeasonNumber, isTeamSeason
} from './config.js';

const API_BASE = '/api';
const LEAGUE_ID = CHALLENGE_CONFIG.leagueId;
const INITIAL_JOKER_STOCK = 2;

let currentUser = null;
let allActivities = [];
let jokerUsageCache = [];
let bonusData = null; // Bonus éphémère du joueur
let bonusChoices = null; // Choix de bonus en attente
let isPlayerEliminated = false; // Statut éliminé du joueur courant

// ============================================
// AUTHENTIFICATION
// ============================================
function getCurrentUserId() {
  return localStorage.getItem('versant_athlete_id');
}

function getAuthToken() {
  return localStorage.getItem('versant_token');
}

/**
 * Fetch authentifié avec gestion automatique des erreurs 401
 * Redirige vers login si la session a expiré
 */
async function authFetch(url, options = {}) {
  const token = getAuthToken();
  if (!token) {
    handleSessionExpired();
    throw new Error('Non authentifié');
  }

  const authOptions = {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      'Cache-Control': 'no-cache'
    }
  };

  const response = await fetch(url, authOptions);

  if (response.status === 401) {
    handleSessionExpired();
    throw new Error('Session expirée');
  }

  return response;
}

/**
 * Gère l'expiration de session : nettoie et redirige
 */
function handleSessionExpired() {
  console.warn('⚠️ Session expirée, redirection vers login...');
  localStorage.removeItem('versant_athlete_id');
  localStorage.removeItem('versant_token');

  // Afficher un message avant redirection
  alert('Votre session a expiré. Veuillez vous reconnecter.');
  window.location.href = 'login.html';
}

// ============================================
// CHARGEMENT DES DONNÉES
// ============================================
async function loadCurrentUser() {
  try {
    const athleteId = getCurrentUserId();
    if (!athleteId) {
      throw new Error('Non connecté');
    }

    const cacheBuster = Date.now();
    const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}?_=${cacheBuster}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error('Erreur chargement');

    const athletes = await res.json();
    currentUser = athletes.find(a => String(a.id) === String(athleteId));

    if (!currentUser) {
      throw new Error('Athlète non trouvé');
    }

    return currentUser;
  } catch (error) {
    console.error('Erreur chargement utilisateur:', error);
    localStorage.removeItem('versant_athlete_id');
    localStorage.removeItem('versant_token');
    window.location.href = 'login.html';
  }
}

async function loadActivities() {
  try {
    const cacheBuster = Date.now();
    const res = await fetch(`${API_BASE}/activities/${LEAGUE_ID}?_=${cacheBuster}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error('Erreur chargement activités');

    allActivities = await res.json();
    return allActivities;
  } catch (error) {
    console.error('Erreur chargement activités:', error);
    return [];
  }
}

async function loadJokersFromServer() {
  try {
    const cacheBuster = Date.now();
    const res = await fetch(`${API_BASE}/jokers/all?_=${cacheBuster}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      console.warn('⚠️ Impossible de charger les jokers');
      return [];
    }
    const data = await res.json();
    // Normaliser: gérer le format objet {athletes, usage, config} ET le format tableau []
    jokerUsageCache = Array.isArray(data) ? data :
      (data && Array.isArray(data.usage)) ? data.usage : [];
    return jokerUsageCache;
  } catch (error) {
    console.error('❌ Erreur chargement jokers:', error);
    return [];
  }
}

/**
 * Charge le bonus éphémère du joueur
 */
async function loadBonusFromServer() {
  try {
    const cacheBuster = Date.now();
    const res = await authFetch(`${API_BASE}/bonuses/my?_=${cacheBuster}`, {
      cache: 'no-store'
    });

    if (!res.ok) {
      console.warn('⚠️ Impossible de charger le bonus');
      return null;
    }

    const data = await res.json();
    bonusData = data.bonus;
    return bonusData;
  } catch (error) {
    // Si c'est une erreur de session, authFetch a déjà géré la redirection
    if (error.message !== 'Session expirée' && error.message !== 'Non authentifié') {
      console.error('❌ Erreur chargement bonus:', error);
    }
    return null;
  }
}

/**
 * Vérifie si le joueur a des choix de bonus en attente
 */
async function loadBonusChoices() {
  try {
    const cacheBuster = Date.now();
    const res = await authFetch(`${API_BASE}/bonuses/choices?_=${cacheBuster}`, {
      cache: 'no-store'
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.hasChoice) {
      bonusChoices = data.choices;
    }
    return bonusChoices;
  } catch (error) {
    // Si c'est une erreur de session, authFetch a déjà géré la redirection
    if (error.message !== 'Session expirée' && error.message !== 'Non authentifié') {
      console.error('❌ Erreur chargement choix bonus:', error);
    }
    return null;
  }
}

// ============================================
// CALCULS
// ============================================
function getJokerStock(participantId) {
  const pid = String(participantId);
  const stock = {};

  Object.keys(JOKER_TYPES).forEach(jokerId => {
    const usedCount = jokerUsageCache.filter(
      u => String(u.athlete_id) === pid && u.joker_id === jokerId
    ).length;
    stock[jokerId] = Math.max(0, INITIAL_JOKER_STOCK - usedCount);
  });

  return stock;
}

function getPendingJokers(participantId, currentRoundNumber) {
  const pid = String(participantId);
  return jokerUsageCache.filter(
    u => String(u.athlete_id) === pid && u.round_number === currentRoundNumber + 1
  );
}

function getCurrentRound() {
  return getGlobalRoundNumber(new Date());
}

function getDayInRound() {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const now = new Date();
  const daysSinceStart = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return (daysSinceStart % CHALLENGE_CONFIG.roundDurationDays) + 1;
}

// Utilise getRoundDates importé de config.js (wrapper pour compatibilité)
function getRoundDates(roundNumber) {
  return _getRoundDates(roundNumber);
}

// ============================================
// UTILITAIRES
// ============================================
function formatDate(date) {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function formatElevation(meters) {
  return `${Math.round(meters).toLocaleString('fr-FR')} m`;
}

function getAthleteColorSimple(id) {
  const colors = ['#f97316', '#22d3ee', '#10b981', '#8b5cf6', '#f43f5e', '#fbbf24', '#06b6d4', '#ec4899'];
  const hash = String(id).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function getInitials(name) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
}

// ============================================
// AFFICHAGE - HEADER & STATS
// ============================================
function renderHeader() {
  const nameEl = document.getElementById('athleteName');
  if (nameEl && currentUser) {
    nameEl.textContent = `${currentUser.name}`;
  }
}

/**
 * Calcule et affiche toutes les statistiques du joueur
 */
async function renderStats() {
  if (!currentUser) return;

  const userId = String(currentUser.id);

  // Charger les données nécessaires
  const frozenResults = await loadFrozenResults();
  const athletes = await loadAllAthletes();

  // Si pas d'athlètes chargés, utiliser les données locales
  const athletesList = athletes.length > 0 ? athletes : [currentUser];

  // Déterminer le statut du joueur (actif ou éliminé)
  const eliminationInfo = getEliminationInfo(userId, frozenResults, athletesList);
  const isEliminated = eliminationInfo.isEliminated;
  isPlayerEliminated = isEliminated;

  // Calculer les dates du round actuel
  const currentRound = getCurrentRound();
  const roundDates = getRoundDates(currentRound);

  // Activités du round actuel
  const roundActivities = allActivities.filter(a => {
    const date = new Date(a.start_date);
    return date >= roundDates.start && date <= roundDates.end;
  });

  // D+ du round pour cet utilisateur
  const userRoundActivities = roundActivities.filter(a => String(a.athlete_id) === userId);
  const roundElevation = userRoundActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);

  // D+ total saison (depuis le début de l'année/saison)
  const seasonStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const userActivities = allActivities.filter(a => {
    const date = new Date(a.start_date);
    return String(a.athlete_id) === userId && date >= seasonStart;
  });
  const totalElevation = userActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);

  // Calculer la position dans le challenge actuel
  let challengeRank = '-';
  let challengeTotal = '-';

  if (isEliminated) {
    // Challenge des éliminés : calculer le classement parmi les éliminés
    const eliminatedRanking = calculateEliminatedRanking(frozenResults, allActivities, athletesList);
    const myRank = eliminatedRanking.findIndex(e => String(e.id) === userId) + 1;
    if (myRank > 0) {
      challengeRank = myRank;
      challengeTotal = eliminatedRanking.length;
    }
  } else {
    // Challenge principal : calculer le classement parmi les actifs
    const activeAthletes = getActiveAthletes(frozenResults, athletesList);

    // Calculer le classement D+ du round actuel
    const ranking = calculateRankingFromActivities(roundActivities, activeAthletes);
    const myRank = ranking.findIndex(e => String(e.id) === userId) + 1;

    if (myRank > 0) {
      challengeRank = myRank;
      challengeTotal = ranking.length;
    } else if (activeAthletes.length > 0) {
      // L'utilisateur n'a pas d'activité ce round mais est actif
      challengeRank = activeAthletes.length; // Dernier par défaut
      challengeTotal = activeAthletes.length;
    }
  }

  // Calculer le classement général (points cumulés des rounds figés)
  const generalRanking = calculateGeneralRanking(frozenResults, athletesList);
  const myGeneralEntry = generalRanking.find(e => String(e.id) === userId);
  const overallRank = myGeneralEntry ? generalRanking.indexOf(myGeneralEntry) + 1 : '-';
  const totalPoints = myGeneralEntry?.points || 0;

  // ============================================
  // AFFICHAGE
  // ============================================

  // Statut du challenge
  const challengeStatusEl = document.getElementById('challengeStatus');
  if (challengeStatusEl) {
    if (isEliminated) {
      challengeStatusEl.innerHTML = `
        <span style="color: #a855f7;">👻 Éliminés</span>
        <span style="font-size: 0.75rem; color: rgba(255,255,255,0.5);">(R${eliminationInfo.round})</span>
      `;
    } else {
      challengeStatusEl.innerHTML = `<span style="color: #10b981;">🏆 Principal</span>`;
    }
  }

  // D+ du round
  const roundElevationEl = document.getElementById('roundElevation');
  if (roundElevationEl) {
    roundElevationEl.textContent = formatElevation(roundElevation);
    // Colorer selon la position
    roundElevationEl.style.color = ''; // Reset
    if (!isEliminated && challengeRank !== '-' && challengeTotal !== '-') {
      if (challengeRank <= 3) {
        roundElevationEl.style.color = '#10b981'; // Vert - top 3
      } else if (challengeRank > challengeTotal - 2 && challengeTotal > 2) {
        roundElevationEl.style.color = '#ef4444'; // Rouge - zone danger
      }
    }
  }

  // Position dans le challenge
  const challengeRankEl = document.getElementById('challengeRank');
  if (challengeRankEl) {
    if (challengeRank !== '-' && challengeTotal !== '-') {
      let rankColor = '';
      if (challengeRank === 1) rankColor = 'color: #fbbf24;'; // Or
      else if (challengeRank === 2) rankColor = 'color: #d1d5db;'; // Argent
      else if (challengeRank === 3) rankColor = 'color: #cd7f32;'; // Bronze

      challengeRankEl.innerHTML = `<strong style="${rankColor}">${challengeRank}</strong><span style="color: rgba(255,255,255,0.5);">/${challengeTotal}</span>`;
    } else {
      challengeRankEl.textContent = '-';
    }
  }

  // Classement général
  const overallRankEl = document.getElementById('overallRank');
  if (overallRankEl) {
    if (overallRank !== '-' && athletesList.length > 0) {
      overallRankEl.innerHTML = `<strong>${overallRank}</strong><span style="color: rgba(255,255,255,0.5);">/${athletesList.length}</span>`;
    } else {
      overallRankEl.textContent = '-';
    }
  }

  // D+ total et activités
  const totalElevationEl = document.getElementById('totalElevation');
  if (totalElevationEl) {
    totalElevationEl.textContent = formatElevation(totalElevation);
  }

  const totalActivitiesEl = document.getElementById('totalActivities');
  if (totalActivitiesEl) {
    totalActivitiesEl.textContent = userActivities.length;
  }

  // Points
  const totalPointsEl = document.getElementById('totalPoints');
  if (totalPointsEl) {
    totalPointsEl.textContent = `${totalPoints} pts`;
  }
}

/**
 * Affiche les infos du round actuel
 */
function renderCurrentRound() {
  const currentRound = getCurrentRound();
  const dayInRound = getDayInRound();
  const roundDates = getRoundDates(currentRound);

  const currentRoundEl = document.getElementById('currentRoundNumber');
  if (currentRoundEl) {
    currentRoundEl.textContent = `Round ${currentRound}`;
  }

  const dayInRoundEl = document.getElementById('dayInRound');
  if (dayInRoundEl) {
    dayInRoundEl.textContent = `Jour ${dayInRound}/${CHALLENGE_CONFIG.roundDurationDays}`;
  }

  const roundEndEl = document.getElementById('roundEndDate');
  if (roundEndEl) {
    roundEndEl.textContent = formatDate(roundDates.end);
  }

  const ruleEl = document.getElementById('nextRoundRule');
  if (ruleEl) {
    ruleEl.textContent = '📊 Standard';
  }
}

// ============================================
// FONCTIONS DE CALCUL
// ============================================

/**
 * Charge les résultats figés depuis l'API
 */
async function loadFrozenResults() {
  try {
    const res = await fetch(`${API_BASE}/frozen-results`);
    if (!res.ok) return {};
    return await res.json();
  } catch (error) {
    console.warn('Erreur chargement frozen results:', error);
    return {};
  }
}

/**
 * Charge tous les athlètes
 */
async function loadAllAthletes() {
  try {
    const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (error) {
    console.warn('Erreur chargement athlètes:', error);
    return [];
  }
}

/**
 * Détermine si un joueur est éliminé dans la saison en cours et à quel round
 */
function getEliminationInfo(athleteId, frozenResults, allAthletes = []) {
  const aid = String(athleteId);

  if (!frozenResults || !frozenResults.rounds) {
    return { isEliminated: false, round: null };
  }

  // Calculer la saison en cours
  const currentRound = getCurrentRound();
  const totalAthletes = allAthletes.length || 15;
  const roundsPerSeason = Math.ceil((totalAthletes - 1) / 2);
  const currentSeason = Math.ceil(currentRound / roundsPerSeason);
  const seasonStartRound = (currentSeason - 1) * roundsPerSeason + 1;
  const seasonEndRound = currentSeason * roundsPerSeason;

  for (const [roundNum, roundData] of Object.entries(frozenResults.rounds)) {
    const rn = parseInt(roundNum);
    if (rn < seasonStartRound || rn > seasonEndRound) continue;

    if (roundData.eliminations) {
      const eliminated = roundData.eliminations.find(e => String(e.id) === aid);
      if (eliminated) {
        return { isEliminated: true, round: rn, roundInSeason: ((rn - 1) % roundsPerSeason) + 1 };
      }
    }
  }

  return { isEliminated: false, round: null };
}

/**
 * Récupère les athlètes encore actifs (non éliminés dans la saison en cours)
 */
function getActiveAthletes(frozenResults, allAthletes) {
  const eliminatedIds = new Set();

  if (frozenResults && frozenResults.rounds) {
    // Calculer quelle saison on est
    const currentRound = getCurrentRound();
    const roundsPerSeason = Math.ceil((allAthletes.length - 1) / 2); // 2 éliminations par round
    const currentSeason = Math.ceil(currentRound / roundsPerSeason);
    const seasonStartRound = (currentSeason - 1) * roundsPerSeason + 1;
    const seasonEndRound = currentSeason * roundsPerSeason;

    // Ne compter que les éliminés de la saison en cours
    for (const [roundNum, roundData] of Object.entries(frozenResults.rounds)) {
      const rn = parseInt(roundNum);
      if (rn >= seasonStartRound && rn <= seasonEndRound && roundData.eliminations) {
        roundData.eliminations.forEach(e => eliminatedIds.add(String(e.id)));
      }
    }
  }

  return allAthletes.filter(a => !eliminatedIds.has(String(a.id)));
}

/**
 * Calcule le classement à partir des activités
 */
function calculateRankingFromActivities(activities, athletes) {
  return athletes
    .map(athlete => {
      const athleteActivities = activities.filter(a => String(a.athlete_id) === String(athlete.id));
      const elevation = athleteActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
      return {
        id: athlete.id,
        name: athlete.name,
        elevation
      };
    })
    .sort((a, b) => b.elevation - a.elevation);
}

/**
 * Calcule le classement des éliminés de la saison en cours (D+ depuis leur élimination)
 */
function calculateEliminatedRanking(frozenResults, allActivities, allAthletes) {
  const eliminated = [];

  if (!frozenResults || !frozenResults.rounds) return [];

  // Calculer la saison en cours
  const currentRound = getCurrentRound();
  const totalAthletes = allAthletes.length || 15;
  const roundsPerSeason = Math.ceil((totalAthletes - 1) / 2);
  const currentSeason = Math.ceil(currentRound / roundsPerSeason);
  const seasonStartRound = (currentSeason - 1) * roundsPerSeason + 1;
  const seasonEndRound = currentSeason * roundsPerSeason;

  for (const [roundNum, roundData] of Object.entries(frozenResults.rounds)) {
    const rn = parseInt(roundNum);
    if (rn < seasonStartRound || rn > seasonEndRound) continue;

    if (roundData.eliminations) {
      roundData.eliminations.forEach(e => {
        eliminated.push({
          id: e.id,
          name: e.name,
          eliminatedRound: rn
        });
      });
    }
  }

  // Calculer le D+ de chaque éliminé depuis son élimination
  return eliminated
    .map(elim => {
      const eliminationRoundDates = getRoundDates(elim.eliminatedRound);
      const activitiesSinceElim = allActivities.filter(a => {
        return String(a.athlete_id) === String(elim.id) &&
               new Date(a.start_date) > eliminationRoundDates.end;
      });
      const elevation = activitiesSinceElim.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
      return { ...elim, elevation };
    })
    .sort((a, b) => b.elevation - a.elevation);
}

/**
 * Calcule le classement général (points accumulés depuis les résultats figés)
 */
function calculateGeneralRanking(frozenResults, allAthletes) {
  const pointsMap = {};
  allAthletes.forEach(a => {
    pointsMap[String(a.id)] = { id: a.id, name: a.name, points: 0 };
  });

  if (frozenResults && frozenResults.rounds) {
    for (const roundData of Object.values(frozenResults.rounds)) {
      if (roundData.ranking) {
        roundData.ranking.forEach(entry => {
          // Utiliser les mainPoints stockés dans les frozen results
          const pts = entry.mainPoints || 0;
          if (pts > 0 && pointsMap[String(entry.id)]) {
            pointsMap[String(entry.id)].points += pts;
          }
        });
      }
    }
  }

  return Object.values(pointsMap).sort((a, b) => b.points - a.points);
}

/**
 * Calcule les dates d'un round
 */
// getRoundDates est défini plus haut (wrapper de config.js)

function renderActivities() {
  const list = document.getElementById('activitiesList');
  if (!list || !currentUser) return;

  const userActivities = allActivities
    .filter(a => String(a.athlete_id) === String(currentUser.id))
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))
    .slice(0, 10);

  if (userActivities.length === 0) {
    list.innerHTML = '<div class="no-data">Aucune activité enregistrée</div>';
    return;
  }

  list.innerHTML = userActivities.map(activity => `
    <div class="activity-item">
      <div class="activity-info">
        <div class="activity-name">${activity.name || 'Activité'}</div>
        <div class="activity-meta">${formatDate(activity.start_date)}</div>
      </div>
      <div class="activity-elevation">+${Math.round(activity.total_elevation_gain || 0)}m</div>
    </div>
  `).join('');
}

// ============================================
// AFFICHAGE - JOKERS
// ============================================
function renderJokers() {
  const grid = document.getElementById('jokersGrid');
  if (!grid || !currentUser) return;

  // Si le joueur est éliminé, afficher un message et désactiver tous les jokers
  if (isPlayerEliminated) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 24px; color: rgba(255,255,255,0.5);">
        <div style="font-size: 2rem; margin-bottom: 12px;">👻</div>
        <div style="font-size: 0.9rem;">Les joueurs éliminés ne peuvent pas utiliser de jokers.</div>
        <div style="font-size: 0.8rem; margin-top: 8px; color: rgba(255,255,255,0.3);">Concentre-toi sur le challenge des éliminés et tes bonus éphémères !</div>
      </div>
    `;
    return;
  }

  const jokerStock = getJokerStock(currentUser.id);
  const currentRound = getCurrentRound();
  const pendingJokers = getPendingJokers(currentUser.id, currentRound);

  // En saison Équipes : le bouclier est désactivé (toute l'équipe est éliminée
  // ou survit ensemble, le bouclier individuel n'a pas de sens).
  const isTeamMode = (() => {
    try { return isTeamSeason(getSeasonNumber(new Date())); } catch { return false; }
  })();

  grid.innerHTML = Object.entries(JOKER_TYPES).map(([id, joker]) => {
    const count = jokerStock[id] || 0;
    const isPending = pendingJokers.some(j => j.joker_id === id);
    const isAvailable = count > 0 && !isPending;
    const isDisabledByTeam = isTeamMode && id === 'bouclier';

    let statusClass = 'used';
    let statusText = 'Épuisé';
    let statusIcon = '✗';

    if (isDisabledByTeam) {
      statusClass = 'disabled-team';
      statusText = 'Désactivé en saison Équipes';
      statusIcon = '🤝';
    } else if (isPending) {
      statusClass = 'pending';
      statusText = 'Programmé';
      statusIcon = '⏳';
    } else if (isAvailable) {
      statusClass = 'available';
      statusText = `disponible${count > 1 ? 's' : ''}`;
      statusIcon = count;
    }

    return `
      <div class="joker-card ${statusClass}" data-joker="${id}" ${isDisabledByTeam ? 'data-disabled-team="true"' : ''}>
        <div class="joker-icon">${joker.icon}</div>
        <div class="joker-name">${joker.name}</div>
        <div class="joker-desc">${joker.description}</div>
        <div class="joker-count ${statusClass}">
          <strong>${statusIcon}</strong> ${statusText}
        </div>
      </div>
    `;
  }).join('');

  // Event listeners pour les jokers disponibles (mais pas pour le bouclier en team)
  grid.querySelectorAll('.joker-card.available').forEach(card => {
    card.onclick = () => {
      const jokerId = card.dataset.joker;
      const joker = JOKER_TYPES[jokerId];
      if (joker.requiresTarget) {
        showJokerTargetModal(jokerId, joker);
      } else {
        showJokerConfirmModal(jokerId, joker);
      }
    };
  });
}

// ============================================
// AFFICHAGE - BONUS ÉPHÉMÈRES
// ============================================
function renderBonus() {
  const section = document.getElementById('bonusSection');
  const content = document.getElementById('bonusContent');

  if (!section || !content) return;

  // Si pas de bonus et pas de choix en attente, cacher la section
  if (!bonusData && !bonusChoices) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  // Si choix en attente, afficher le modal de choix
  if (bonusChoices && bonusChoices.length > 0) {
    showBonusChoiceModal();
    content.innerHTML = `
      <div class="bonus-card" style="cursor: pointer;" onclick="window.showBonusChoiceModal()">
        <div class="bonus-icon">🎁</div>
        <div class="bonus-name">Choisis ton bonus !</div>
        <div class="bonus-desc">Tu es le meilleur des 2 éliminés - Clique pour choisir ton bonus parmi 2 options</div>
        <div class="bonus-status">⏳ En attente de choix</div>
      </div>
    `;
    return;
  }

  // Afficher le bonus existant
  if (bonusData) {
    const bonusType = BONUS_TYPES[bonusData.bonus_id];
    if (!bonusType) {
      content.innerHTML = '<div class="no-data">Bonus inconnu</div>';
      return;
    }

    const isUsed = bonusData.status === 'used';
    const canUse = !isUsed && canActivateBonusNow(bonusData.bonus_id);
    const isAutomatic = bonusType.activation?.timing === 'automatique';

    content.innerHTML = `
      <div class="bonus-card ${isUsed ? 'used' : 'available'}" ${!isUsed && canUse ? `onclick="window.handleBonusClick('${bonusData.bonus_id}')"` : ''}>
        <div class="bonus-icon">${bonusType.icon}</div>
        <div class="bonus-name">${bonusType.name}</div>
        <div class="bonus-desc">${bonusType.effect}</div>
        ${bonusType.timing ? `<div class="bonus-timing">${bonusType.timing}</div>` : ''}
        <div class="bonus-status ${isUsed ? 'used' : ''}">
          ${isUsed ? '✓ Utilisé' : (canUse ? '🎯 Cliquez pour utiliser' : (isAutomatic ? '✨ Actif automatiquement' : '⏳ Pas encore activable'))}
        </div>
        ${bonusData.target_athlete_name ? `
          <div class="bonus-target">
            🎯 Cible : <strong>${bonusData.target_athlete_name}</strong>
          </div>
        ` : ''}
        ${!canUse && !isUsed && !isAutomatic ? `
          <div class="bonus-timing-info">
            ℹ️ ${getBonusTimingInfo(bonusData.bonus_id)}
          </div>
        ` : ''}
      </div>
      ${!isUsed ? `
        <div class="bonus-help-text">
          <p>💡 <strong>Ton bonus est disponible jusqu'à la fin de la saison.</strong> Après, il disparaîtra.</p>
          <p>${isAutomatic
            ? '✨ Ce bonus s\'active automatiquement, tu n\'as rien à faire !'
            : '🎮 Tu peux l\'utiliser maintenant ou le garder pour le moment idéal.'}</p>
        </div>
      ` : ''}
    `;
  }
}

/**
 * Vérifie si un bonus peut être activé maintenant
 */
function canActivateBonusNow(bonusId) {
  const bonusType = BONUS_TYPES[bonusId];
  if (!bonusType) return false;

  const timing = bonusType.activation.timing;
  const dayInRound = getDayInRound();

  switch (timing) {
    case '3_premiers_jours':
      return dayInRound <= 3;
    case 'jour_1':
      return dayInRound === 1;
    case '48h_apres_elimination':
      return true;
    case 'automatique':
      return false;
    default:
      return false;
  }
}

/**
 * Retourne une info sur le timing d'activation
 */
function getBonusTimingInfo(bonusId) {
  const bonusType = BONUS_TYPES[bonusId];
  if (!bonusType) return '';

  const timing = bonusType.activation.timing;

  switch (timing) {
    case '3_premiers_jours':
      return 'Activable les 3 premiers jours du round';
    case 'jour_1':
      return 'Activable uniquement le 1er jour du round';
    case '48h_apres_elimination':
      return 'Activable dans les 48h après élimination';
    case 'automatique':
      return 'S\'active automatiquement';
    default:
      return '';
  }
}

/**
 * Affiche le modal de choix de bonus (roguelite)
 */
function showBonusChoiceModal() {
  if (!bonusChoices || bonusChoices.length === 0) return;

  const modal = document.getElementById('bonusChoiceModal');
  const grid = document.getElementById('bonusChoiceGrid');

  if (!modal || !grid) return;

  grid.innerHTML = bonusChoices.map(bonusId => {
    const bonus = BONUS_TYPES[bonusId];
    if (!bonus) return '';

    // Catégorie avec icône
    const categoryMap = {
      'offensif': '⚔️ Offensif',
      'soutien': '🤝 Soutien',
      'competitif': '🏆 Compétitif',
      'defensif': '🛡️ Défensif',
      'pari': '🎲 Pari',
      'piege': '🪤 Piège',
      'boost': '⚡ Boost'
    };
    const categoryLabel = categoryMap[bonus.category] || '';

    return `
      <div class="bonus-choice-option" onclick="window.selectBonus('${bonusId}')">
        <div class="bonus-icon">${bonus.icon}</div>
        <div class="bonus-name">${bonus.name}</div>
        <div class="bonus-desc">${bonus.effect}</div>
        ${bonus.timing ? `<div class="bonus-timing">${bonus.timing.replace(' · ', '<br>')}</div>` : ''}
        ${categoryLabel ? `<div class="bonus-category">${categoryLabel}</div>` : ''}
      </div>
    `;
  }).join('');

  modal.style.display = 'flex';
}

/**
 * Sélectionne un bonus parmi les choix
 */
async function selectBonus(bonusId) {
  try {
    const response = await authFetch(`${API_BASE}/bonuses/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ bonus_id: bonusId })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur serveur');
    }

    const result = await response.json();
    bonusData = result.bonus;
    bonusChoices = null;

    const modal = document.getElementById('bonusChoiceModal');
    if (modal) modal.style.display = 'none';

    renderBonus();

    const bonus = BONUS_TYPES[bonusId];
    showNotification(`${bonus.icon} ${bonus.name} choisi !`, 'success');

  } catch (error) {
    if (error.message !== 'Session expirée' && error.message !== 'Non authentifié') {
      console.error('Erreur sélection bonus:', error);
      showNotification(error.message, 'error');
    }
  }
}

/**
 * Gère le clic sur un bonus pour l'utiliser
 */
function handleBonusClick(bonusId) {
  const bonusType = BONUS_TYPES[bonusId];
  if (!bonusType) return;

  if (bonusType.requiresTarget) {
    showBonusTargetModal(bonusId, bonusType);
  } else {
    showBonusConfirmModal(bonusId, bonusType);
  }
}

/**
 * Modal de sélection de cible pour les bonus
 */
function showBonusTargetModal(bonusId, bonusType) {
  fetch(`${API_BASE}/athletes/${LEAGUE_ID}`)
    .then(res => res.json())
    .then(athletes => {
      let targets = athletes.filter(a => String(a.id) !== String(currentUser.id));

      const modal = document.createElement('div');
      modal.className = 'joker-selection-modal';
      modal.innerHTML = `
        <div class="joker-modal-container" style="border-color: rgba(168, 85, 247, 0.4);">
          <div class="modal-header" style="background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(236, 72, 153, 0.1));">
            <span class="modal-header-icon">${bonusType.icon}</span>
            <div class="modal-header-text">
              <div class="modal-header-title">${bonusType.name}</div>
              <div class="modal-header-subtitle">Choisissez votre cible</div>
            </div>
            <button class="modal-close-btn">&times;</button>
          </div>
          <div class="modal-body">
            <div class="modal-section">
              <div class="modal-section-title" style="color: #a855f7;">🎯 Sélectionnez un joueur</div>
              <div class="target-selection-grid">
                ${targets.map(t => `
                  <div class="target-card" data-id="${t.id}" data-name="${t.name}">
                    <div class="target-card-avatar" style="background: linear-gradient(135deg, ${getAthleteColorSimple(t.id)}, ${getAthleteColorSimple(t.id)}88)">
                      ${getInitials(t.name)}
                    </div>
                    <div class="target-card-name">${t.name}</div>
                  </div>
                `).join('')}
              </div>
            </div>

            <button class="modal-confirm-btn" style="background: linear-gradient(135deg, #a855f7, #ec4899);" disabled>
              <span class="btn-icon">${bonusType.icon}</span>
              Sélectionnez une cible
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      let selectedTarget = null;

      modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelectorAll('.target-card').forEach(card => {
        card.onclick = () => {
          modal.querySelectorAll('.target-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedTarget = { id: card.dataset.id, name: card.dataset.name };

          const btn = modal.querySelector('.modal-confirm-btn');
          btn.disabled = false;
          btn.innerHTML = `<span class="btn-icon">${bonusType.icon}</span> Cibler ${selectedTarget.name}`;
        };
      });

      modal.querySelector('.modal-confirm-btn').onclick = async () => {
        if (!selectedTarget) return;
        modal.remove();
        await useBonus(bonusId, selectedTarget.id);
      };
    });
}

/**
 * Modal de confirmation pour les bonus sans cible
 */
function showBonusConfirmModal(bonusId, bonusType) {
  const modal = document.createElement('div');
  modal.className = 'joker-selection-modal';
  modal.innerHTML = `
    <div class="joker-modal-container" style="border-color: rgba(168, 85, 247, 0.4);">
      <div class="modal-header" style="background: linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(236, 72, 153, 0.1));">
        <span class="modal-header-icon">${bonusType.icon}</span>
        <div class="modal-header-text">
          <div class="modal-header-title">${bonusType.name}</div>
          <div class="modal-header-subtitle">Confirmer l'activation</div>
        </div>
        <button class="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-section">
          <div style="padding: 20px; background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 12px;">
            <p style="color: rgba(255,255,255,0.9); font-size: 1rem; margin: 0; line-height: 1.6;">
              <strong style="color: #a855f7;">💡 Effet :</strong><br>
              ${bonusType.effect}
            </p>
          </div>
        </div>

        <button class="modal-confirm-btn" style="background: linear-gradient(135deg, #a855f7, #ec4899);">
          <span class="btn-icon">${bonusType.icon}</span>
          Activer le bonus
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.querySelector('.modal-confirm-btn').onclick = async () => {
    modal.remove();
    await useBonus(bonusId);
  };
}

/**
 * Utilise un bonus via l'API
 */
async function useBonus(bonusId, targetId = null) {
  try {
    const currentRound = getCurrentRound();

    const response = await authFetch(`${API_BASE}/bonuses/use`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target_athlete_id: targetId,
        round_number: currentRound
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Erreur serveur');
    }

    const result = await response.json();
    bonusData = result.bonus;

    renderBonus();

    const bonus = BONUS_TYPES[bonusId];
    showNotification(`${bonus.icon} ${bonus.name} activé !`, 'success');

  } catch (error) {
    if (error.message !== 'Session expirée' && error.message !== 'Non authentifié') {
      console.error('Erreur utilisation bonus:', error);
      showNotification(error.message, 'error');
    }
  }
}

// ============================================
// MODALS JOKERS
// ============================================
function showJokerConfirmModal(jokerId, joker, targetId = null, targetName = null) {
  const currentRound = getCurrentRound();
  const dayInRound = getDayInRound();
  const canActivateNow = joker.canActivateNow && dayInRound <= (joker.maxDayForImmediateUse || 3);

  const modal = document.createElement('div');
  modal.className = 'joker-selection-modal';

  // Construire les options de timing
  let timingOptionsHtml = '';
  if (canActivateNow) {
    timingOptionsHtml = `
      <div class="timing-card selected" data-timing="now" data-round="${currentRound}">
        <div class="timing-card-label">⚡ Round actuel</div>
        <div class="timing-card-value">Round ${currentRound}</div>
        <div class="timing-card-hint">Effet immédiat</div>
      </div>
      <div class="timing-card" data-timing="next" data-round="${currentRound + 1}">
        <div class="timing-card-label">⏳ Prochain round</div>
        <div class="timing-card-value">Round ${currentRound + 1}</div>
        <div class="timing-card-hint">Programmé</div>
      </div>
    `;
  } else {
    // Après jour 3, uniquement round suivant
    timingOptionsHtml = `
      <div class="timing-card selected" data-timing="next" data-round="${currentRound + 1}">
        <div class="timing-card-label">⏳ Prochain round</div>
        <div class="timing-card-value">Round ${currentRound + 1}</div>
      </div>
      <div class="timing-card disabled" title="Activation immédiate possible uniquement les 3 premiers jours">
        <div class="timing-card-label">⚡ Round actuel</div>
        <div class="timing-card-value">Non disponible</div>
        <div class="timing-card-hint">Jours 1-3 uniquement</div>
      </div>
    `;
  }

  modal.innerHTML = `
    <div class="joker-modal-container">
      <div class="modal-header">
        <span class="modal-header-icon">${joker.icon}</span>
        <div class="modal-header-text">
          <div class="modal-header-title">${joker.name}</div>
          <div class="modal-header-subtitle">${targetName ? `Cible: ${targetName}` : 'Confirmer l\'activation'}</div>
        </div>
        <button class="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-section">
          <div class="modal-section-title">⏰ Quand activer ?</div>
          <div class="timing-options-grid">
            ${timingOptionsHtml}
          </div>
        </div>

        <div class="modal-section">
          <div style="padding: 16px; background: rgba(34, 211, 238, 0.1); border: 1px solid rgba(34, 211, 238, 0.2); border-radius: 12px;">
            <p style="color: rgba(255,255,255,0.8); font-size: 0.9rem; margin: 0;">
              <strong style="color: #22d3ee;">💡 Effet :</strong> ${joker.effect || joker.description}
            </p>
          </div>
        </div>

        <button class="modal-confirm-btn">
          <span class="btn-icon">${joker.icon}</span>
          Activer le joker
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Gestion de la sélection du timing
  let selectedRound = canActivateNow ? currentRound : currentRound + 1;
  let activateNow = canActivateNow;

  modal.querySelectorAll('.timing-card:not(.disabled)').forEach(card => {
    card.onclick = () => {
      modal.querySelectorAll('.timing-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedRound = parseInt(card.dataset.round);
      activateNow = card.dataset.timing === 'now';
    };
  });

  modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.querySelector('.modal-confirm-btn').onclick = async () => {
    try {
      const response = await authFetch(`${API_BASE}/jokers/use`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          joker_id: jokerId,
          target_athlete_id: targetId,
          round_number: selectedRound,
          activate_now: activateNow
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Erreur serveur');
      }

      await loadJokersFromServer();
      renderJokers();

      const message = activateNow
        ? `${joker.icon} ${joker.name} activé pour ce round !`
        : `${joker.icon} ${joker.name} programmé pour le round ${selectedRound} !`;
      showNotification(message, 'success');
      modal.remove();
    } catch (error) {
      if (error.message !== 'Session expirée' && error.message !== 'Non authentifié') {
        console.error('Erreur utilisation joker:', error);
        showNotification(error.message || 'Erreur lors de l\'activation', 'error');
      }
    }
  };
}

function showJokerTargetModal(jokerId, joker) {
  fetch(`${API_BASE}/athletes/${LEAGUE_ID}`)
    .then(res => res.json())
    .then(athletes => {
      const opponents = athletes.filter(a => String(a.id) !== String(currentUser.id));

      const modal = document.createElement('div');
      modal.className = 'joker-selection-modal';
      modal.innerHTML = `
        <div class="joker-modal-container">
          <div class="modal-header">
            <span class="modal-header-icon">${joker.icon}</span>
            <div class="modal-header-text">
              <div class="modal-header-title">${joker.name}</div>
              <div class="modal-header-subtitle">Choisissez votre cible</div>
            </div>
            <button class="modal-close-btn">&times;</button>
          </div>
          <div class="modal-body">
            <div class="modal-section">
              <div class="modal-section-title">🎯 Sélectionnez un adversaire</div>
              <div class="target-selection-grid">
                ${opponents.map(opp => `
                  <div class="target-card" data-id="${opp.id}" data-name="${opp.name}">
                    <div class="target-card-avatar" style="background: linear-gradient(135deg, ${getAthleteColorSimple(opp.id)}, ${getAthleteColorSimple(opp.id)}88)">
                      ${getInitials(opp.name)}
                    </div>
                    <div class="target-card-name">${opp.name}</div>
                  </div>
                `).join('')}
              </div>
            </div>

            <button class="modal-confirm-btn" disabled>
              <span class="btn-icon">${joker.icon}</span>
              Sélectionnez une cible
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      let selectedTarget = null;

      modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelectorAll('.target-card').forEach(card => {
        card.onclick = () => {
          modal.querySelectorAll('.target-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedTarget = { id: card.dataset.id, name: card.dataset.name };

          const btn = modal.querySelector('.modal-confirm-btn');
          btn.disabled = false;
          btn.innerHTML = `<span class="btn-icon">${joker.icon}</span> Cibler ${selectedTarget.name}`;
        };
      });

      modal.querySelector('.modal-confirm-btn').onclick = () => {
        if (!selectedTarget) return;
        modal.remove();
        showJokerConfirmModal(jokerId, joker, selectedTarget.id, selectedTarget.name);
      };
    });
}

// ============================================
// NOTIFICATIONS
// ============================================
function showNotification(message, type = 'info') {
  const existing = document.querySelector('.dashboard-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = `dashboard-notification ${type}`;
  notification.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    padding: 16px 28px;
    border-radius: 12px;
    font-weight: 600;
    z-index: 10001;
    animation: slideUp 0.3s ease-out;
    ${type === 'success' ? 'background: linear-gradient(135deg, #10b981, #059669); color: white;' : ''}
    ${type === 'error' ? 'background: linear-gradient(135deg, #ef4444, #dc2626); color: white;' : ''}
    ${type === 'info' ? 'background: linear-gradient(135deg, #3b82f6, #2563eb); color: white;' : ''}
  `;
  notification.textContent = message;

  if (!document.getElementById('notification-keyframes')) {
    const style = document.createElement('style');
    style.id = 'notification-keyframes';
    style.textContent = `
      @keyframes slideUp {
        from { transform: translateX(-50%) translateY(20px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

// ============================================
// INITIALISATION
// ============================================
async function init() {

  try {
    await loadCurrentUser();
    await loadActivities();
    await loadJokersFromServer();
    await loadBonusFromServer();
    await loadBonusChoices();

    renderHeader();
    await renderStats(); // async maintenant
    renderCurrentRound(); // renommé depuis renderNextRound
    renderJokers();
    renderBonus();
    renderActivities();

  } catch (error) {
    console.error('❌ Erreur initialisation dashboard:', error);
  }
}

// ============================================
// DÉCONNEXION
// ============================================
function logout() {
  localStorage.removeItem('versant_athlete_id');
  localStorage.removeItem('versant_token');
  window.location.href = 'login.html';
}

// Exposer les fonctions globalement
window.logout = logout;
window.showBonusChoiceModal = showBonusChoiceModal;
window.selectBonus = selectBonus;
window.handleBonusClick = handleBonusClick;

// ============================================
// DÉMARRAGE
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  const athleteId = getCurrentUserId();
  if (!athleteId) {
    window.location.href = 'login.html';
    return;
  }

  init();
});