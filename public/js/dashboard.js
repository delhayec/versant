/**
 * ============================================
 * DASHBOARD PERSONNEL - VERSANT 2026
 * ============================================
 */

import { CHALLENGE_CONFIG, JOKER_TYPES, getRoundDates, getGlobalRoundNumber } from './config.js';

const API_BASE = '/api';
const LEAGUE_ID = CHALLENGE_CONFIG.leagueId;

let currentUser = null;
let allActivities = [];

// ============================================
// AUTHENTIFICATION
// ============================================
function getCurrentUserId() {
  // Pour l'instant, on prend le premier athlète inscrit
  // TODO: Implémenter une vraie authentification
  return localStorage.getItem('versant_athlete_id');
}

function setCurrentUserId(id) {
  localStorage.setItem('versant_athlete_id', id);
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

    const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    if (!res.ok) throw new Error('Erreur chargement');
    
    const athletes = await res.json();
    currentUser = athletes.find(a => a.id === athleteId);
    
    if (!currentUser) {
      throw new Error('Athlète non trouvé');
    }
    
    return currentUser;
  } catch (error) {
    console.error('Erreur chargement utilisateur:', error);
    // Rediriger vers inscription
    window.location.href = 'inscription.html';
  }
}

async function loadActivities() {
  try {
    const res = await fetch(`${API_BASE}/activities/${LEAGUE_ID}`);
    if (!res.ok) throw new Error('Erreur chargement activités');
    
    allActivities = await res.json();
    return allActivities;
  } catch (error) {
    console.error('Erreur chargement activités:', error);
    return [];
  }
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

// ============================================
// AFFICHAGE
// ============================================
function renderHeader() {
  const nameEl = document.getElementById('athleteName');
  if (nameEl && currentUser) {
    nameEl.textContent = `${currentUser.name}`;
  }
}

function renderStats() {
  if (!currentUser) return;
  
  const userActivities = allActivities.filter(a => a.athlete_id === currentUser.id);
  const totalElevation = userActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
  
  document.getElementById('totalElevation').textContent = formatElevation(totalElevation);
  document.getElementById('totalActivities').textContent = userActivities.length;
  document.getElementById('currentRank').textContent = '-'; // À calculer
  document.getElementById('totalPoints').textContent = '0'; // À calculer
}

function renderNextRound() {
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const now = new Date();
  
  if (now < start) {
    document.getElementById('nextRoundStart').textContent = formatDate(start);
    document.getElementById('nextRoundRule').textContent = '📊 Standard';
  } else {
    // Calculer le prochain round
    const daysSinceStart = Math.floor((now - start) / (1000 * 60 * 60 * 24));
    const currentRound = Math.floor(daysSinceStart / CHALLENGE_CONFIG.roundDurationDays) + 1;
    const nextRound = currentRound + 1;
    
    const nextRoundStart = new Date(start);
    nextRoundStart.setDate(nextRoundStart.getDate() + (nextRound - 1) * CHALLENGE_CONFIG.roundDurationDays);
    
    document.getElementById('nextRoundStart').textContent = formatDate(nextRoundStart);
    document.getElementById('nextRoundRule').textContent = '📊 Standard'; // À adapter
  }
}

function renderJokers() {
  const grid = document.getElementById('jokersGrid');
  if (!grid || !currentUser) return;
  
  // Calculer le jour actuel dans le round
  const now = new Date();
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const daysSinceStart = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const currentRound = Math.floor(daysSinceStart / CHALLENGE_CONFIG.roundDurationDays) + 1;
  const dayInRound = (daysSinceStart % CHALLENGE_CONFIG.roundDurationDays) + 1;

  const userJokers = currentUser.jokers || ['voleur', 'multiplicateur', 'bouclier', 'sabotage'];

  grid.innerHTML = Object.values(JOKER_TYPES).map(joker => {
    const hasJoker = userJokers.includes(joker.id);

    // Pour le bouclier, vérifier si on peut l'activer immédiatement
    let canUseNow = hasJoker;
    let immediateOption = false;

    if (joker.id === 'bouclier' && hasJoker) {
      immediateOption = dayInRound <= (joker.maxDayForImmediateUse || 2);
    }

    return `
      <div class="joker-card ${hasJoker ? 'available' : 'used'}" data-joker="${joker.id}" data-immediate="${immediateOption}">
        <div class="joker-icon">${joker.icon}</div>
        <div class="joker-name">${joker.name}</div>
        <div class="joker-desc">${joker.description}</div>
        ${immediateOption ? '<div class="joker-immediate">⚡ Activation immédiate possible</div>' : ''}
        <div class="joker-status ${hasJoker ? 'available' : 'used'}">
          ${hasJoker ? 'Disponible' : 'Utilisé'}
        </div>
      </div>
    `;
  }).join('');

  // Ajouter les event listeners
  grid.querySelectorAll('.joker-card.available').forEach(card => {
    card.addEventListener('click', () => {
      const jokerId = card.dataset.joker;
      const canImmediate = card.dataset.immediate === 'true';
      openJokerModal(jokerId, canImmediate, currentRound, dayInRound);
    });
  });
}

async function openJokerModal(jokerId, canImmediate, currentRound, dayInRound) {
  const joker = JOKER_TYPES[jokerId];
  if (!joker) return;

  // Charger les adversaires pour les jokers qui nécessitent une cible
  let targetHtml = '';
  if (joker.requiresTarget) {
    const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    const athletes = await res.json();
    const opponents = athletes.filter(a => a.id !== currentUser.id);

    targetHtml = `
      <div class="modal-field">
        <label>Choisir un adversaire :</label>
        <select id="jokerTarget" required>
          <option value="">-- Sélectionner --</option>
          ${opponents.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
        </select>
      </div>
    `;
  }

  // Pour le multiplicateur, ajouter le sélecteur de jour
  let dayHtml = '';
  if (joker.requiresDay) {
    const nextRound = currentRound + 1;
    const roundStart = new Date(CHALLENGE_CONFIG.yearStartDate);
    roundStart.setDate(roundStart.getDate() + (nextRound - 1) * CHALLENGE_CONFIG.roundDurationDays);

    const days = [];
    for (let i = 0; i < CHALLENGE_CONFIG.roundDurationDays; i++) {
      const day = new Date(roundStart);
      day.setDate(day.getDate() + i);
      days.push({
        date: day.toISOString().split('T')[0],
        label: day.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
      });
    }

    dayHtml = `
      <div class="modal-field">
        <label>Choisir le jour à doubler :</label>
        <select id="jokerDay" required>
          <option value="">-- Sélectionner --</option>
          ${days.map(d => `<option value="${d.date}">${d.label}</option>`).join('')}
        </select>
      </div>
    `;
  }

  // Pour le bouclier, ajouter l'option d'activation immédiate
  let timingHtml = '';
  if (jokerId === 'bouclier' && canImmediate) {
    timingHtml = `
      <div class="modal-field">
        <label>Quand activer le bouclier ?</label>
        <div class="timing-options">
          <label class="timing-option">
            <input type="radio" name="timing" value="now" checked>
            <span>⚡ Ce round (immédiat)</span>
          </label>
          <label class="timing-option">
            <input type="radio" name="timing" value="next">
            <span>⏰ Prochain round</span>
          </label>
        </div>
      </div>
    `;
  }

  // Créer le modal
  const modal = document.createElement('div');
  modal.className = 'joker-modal-overlay';
  modal.innerHTML = `
    <div class="joker-modal">
      <div class="modal-header">
        <span class="modal-icon">${joker.icon}</span>
        <h3>${joker.name}</h3>
      </div>
      <div class="modal-body">
        <p class="modal-desc">${joker.effect}</p>
        ${timingHtml}
        ${targetHtml}
        ${dayHtml}
      </div>
      <div class="modal-footer">
        <button class="btn-cancel" onclick="this.closest('.joker-modal-overlay').remove()">Annuler</button>
        <button class="btn-confirm" id="confirmJoker">Activer le joker</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Gérer la confirmation
  modal.querySelector('#confirmJoker').addEventListener('click', async () => {
    const targetId = modal.querySelector('#jokerTarget')?.value;
    const selectedDay = modal.querySelector('#jokerDay')?.value;
    const timing = modal.querySelector('input[name="timing"]:checked')?.value || 'next';

    if (joker.requiresTarget && !targetId) {
      alert('Veuillez sélectionner un adversaire');
      return;
    }

    if (joker.requiresDay && !selectedDay) {
      alert('Veuillez sélectionner un jour');
      return;
    }

    await confirmJokerUse(jokerId, {
      targetId,
      selectedDay,
      activateNow: timing === 'now',
      round: timing === 'now' ? currentRound : currentRound + 1
    });

    modal.remove();
  });
}

async function confirmJokerUse(jokerId, options) {
  try {
    const token = localStorage.getItem('versant_token');

    const res = await fetch(`${API_BASE}/jokers/use`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        joker_id: jokerId,
        target_athlete_id: options.targetId,
        selected_day: options.selectedDay,
        activate_now: options.activateNow,
        round_number: options.round
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erreur');
    }

    alert(`Joker ${JOKER_TYPES[jokerId].name} activé avec succès !`);

    // Recharger les données
    await loadCurrentUser();
    renderJokers();

  } catch (error) {
    console.error('Erreur utilisation joker:', error);
    alert('Erreur: ' + error.message);
  }
}

function renderActivities() {
  const list = document.getElementById('activitiesList');
  if (!list || !currentUser) return;
  
  const userActivities = allActivities
    .filter(a => a.athlete_id === currentUser.id)
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))
    .slice(0, 10); // Les 10 dernières
  
  if (userActivities.length === 0) {
    list.innerHTML = '<div class="no-data">Aucune activité synchronisée</div>';
    return;
  }
  
  list.innerHTML = userActivities.map(activity => {
    const date = new Date(activity.start_date);
    const sportEmoji = {
      'Run': '🏃',
      'TrailRun': '🏃',
      'Ride': '🚴',
      'MountainBikeRide': '🚵',
      'BackcountrySki': '⛷️',
      'AlpineSki': '⛷️'
    }[activity.sport_type] || '🏃';
    
    return `
      <div class="activity-item">
        <div class="activity-info">
          <div class="activity-name">${sportEmoji} ${activity.name}</div>
          <div class="activity-meta">
            ${date.toLocaleDateString('fr-FR')} • 
            ${(activity.distance / 1000).toFixed(1)} km
          </div>
        </div>
        <div class="activity-elevation">
          ${Math.round(activity.total_elevation_gain || 0)}m
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// GESTION DES JOKERS
// ============================================
async function useJoker(jokerId) {
  const joker = JOKER_TYPES[jokerId];
  if (!joker) return;
  
  // Confirmer
  const confirmed = confirm(`Voulez-vous utiliser le joker "${joker.name}" ?

${joker.description}

Cette action est irréversible.`);
  
  if (!confirmed) return;
  
  try {
    // TODO: Appel API pour enregistrer l'utilisation du joker
    alert('Fonctionnalité en développement - Le joker sera activé au prochain round');
    
    // Rafraîchir l'affichage
    renderJokers();
  } catch (error) {
    console.error('Erreur utilisation joker:', error);
    alert('Erreur lors de l\'utilisation du joker');
  }
}

// ============================================
// INITIALISATION
// ============================================
async function init() {
  console.log('🎯 Initialisation Dashboard');
  
  try {
    await loadCurrentUser();
    await loadActivities();
    
    renderHeader();
    renderStats();
    renderNextRound();
    renderJokers();
    renderActivities();
    
    console.log('✅ Dashboard chargé');
  } catch (error) {
    console.error('❌ Erreur initialisation dashboard:', error);
  }
}

// ============================================
// AUTO-LOGIN TEMPORAIRE
// ============================================
// Pour faciliter les tests, on auto-connecte le premier athlète
async function autoLogin() {
  if (!getCurrentUserId()) {
    try {
      const res = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
      const athletes = await res.json();
      if (athletes.length > 0) {
        setCurrentUserId(athletes[0].id);
        console.log('🔑 Auto-login:', athletes[0].name);
      }
    } catch (error) {
      console.error('Erreur auto-login:', error);
    }
  }
}

// Démarrer
document.addEventListener('DOMContentLoaded', async () => {
  await autoLogin();
  init();
});
