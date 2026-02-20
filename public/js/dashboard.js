/**
 * ============================================
 * DASHBOARD PERSONNEL - VERSANT 2026
 * ============================================
 */

import { CHALLENGE_CONFIG, JOKER_TYPES } from './config-2026.js';

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
  
  // Pour chaque type de joker, vérifier le stock
  const jokerStock = currentUser.jokerStock || {
    multiplicateur: 1,
    bouclier: 1,
    sabotage: 1,
    voleur: 1
  };
  
  const pendingJokers = currentUser.pendingJokers || [];
  
  grid.innerHTML = Object.entries(JOKER_TYPES).map(([id, joker]) => {
    const count = jokerStock[id] || 0;
    const isPending = pendingJokers.some(j => j.jokerId === id);
    const isAvailable = count > 0 && !isPending;
    
    let statusClass = 'used';
    let statusText = 'Épuisé';
    
    if (isPending) {
      statusClass = 'pending';
      statusText = '⏳ Programmé';
    } else if (isAvailable) {
      statusClass = 'available';
      statusText = `${count} disponible${count > 1 ? 's' : ''}`;
    }
    
    return `
      <div class="joker-card ${statusClass}" data-joker="${id}">
        <div class="joker-icon">${joker.icon}</div>
        <div class="joker-name">${joker.name}</div>
        <div class="joker-desc">${joker.description}</div>
        <div class="joker-count ${statusClass}">
          ${isPending ? '⏳' : count > 0 ? '✓' : '✗'} ${statusText}
        </div>
      </div>
    `;
  }).join('');
  
  // Ajouter les event listeners seulement sur les jokers disponibles
  grid.querySelectorAll('.joker-card.available').forEach(card => {
    card.addEventListener('click', () => {
      const jokerId = card.dataset.joker;
      useJoker(jokerId);
    });
  });
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
  
  // Jokers nécessitant une cible
  const needsTarget = ['duel', 'sabotage', 'voleur'].includes(jokerId);
  
  if (needsTarget) {
    showJokerTargetModal(jokerId, joker);
  } else {
    showJokerConfirmModal(jokerId, joker);
  }
}

function showJokerConfirmModal(jokerId, joker, targetId = null, targetName = null) {
  // Calculer le round d'activation
  const start = new Date(CHALLENGE_CONFIG.yearStartDate);
  const now = new Date();
  const daysSinceStart = Math.max(0, Math.floor((now - start) / (1000 * 60 * 60 * 24)));
  const currentRound = Math.floor(daysSinceStart / CHALLENGE_CONFIG.roundDurationDays) + 1;
  const activationRound = currentRound + 1;
  
  const modal = document.createElement('div');
  modal.className = 'joker-selection-modal';
  modal.innerHTML = `
    <div class="joker-modal-container">
      <div class="modal-header">
        <span class="modal-header-icon">${joker.icon}</span>
        <div class="modal-header-text">
          <div class="modal-header-title">${joker.name}</div>
          <div class="modal-header-subtitle">${joker.description}</div>
        </div>
        <button class="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body">
        ${targetName ? `
          <div class="modal-section">
            <div class="modal-section-title">🎯 Cible sélectionnée</div>
            <div style="padding: 16px; background: rgba(249, 115, 22, 0.1); border-radius: 12px; text-align: center;">
              <strong style="color: #f97316; font-size: 1.2rem;">${targetName}</strong>
            </div>
          </div>
        ` : ''}
        
        <div class="modal-section">
          <div class="modal-section-title">⏰ Activation</div>
          <div class="timing-options-grid">
            <div class="timing-card selected" data-timing="next">
              <div class="timing-card-label">Prochain round</div>
              <div class="timing-card-value">Round ${activationRound}</div>
            </div>
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
  
  // Events
  modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.querySelector('.modal-confirm-btn').onclick = async () => {
    try {
      // TODO: Appel API pour enregistrer l'utilisation du joker
      const response = await fetch(`${API_BASE}/jokers/use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: currentUser.id,
          jokerId: jokerId,
          targetId: targetId,
          activationRound: activationRound
        })
      });
      
      if (!response.ok) throw new Error('Erreur serveur');
      
      showNotification(`${joker.icon} ${joker.name} activé pour le round ${activationRound} !`, 'success');
      modal.remove();
      renderJokers();
    } catch (error) {
      console.error('Erreur utilisation joker:', error);
      // Pour le moment, simuler le succès
      showNotification(`${joker.icon} ${joker.name} programmé pour le round ${activationRound} !`, 'success');
      modal.remove();
    }
  };
}

function showJokerTargetModal(jokerId, joker) {
  // Récupérer les adversaires
  fetch(`${API_BASE}/athletes/${LEAGUE_ID}`)
    .then(res => res.json())
    .then(athletes => {
      const opponents = athletes.filter(a => a.id !== currentUser.id);
      
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
      
      // Events
      modal.querySelector('.modal-close-btn').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      
      // Target selection
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
      
      // Confirm
      modal.querySelector('.modal-confirm-btn').onclick = () => {
        if (!selectedTarget) return;
        modal.remove();
        showJokerConfirmModal(jokerId, joker, selectedTarget.id, selectedTarget.name);
      };
    })
    .catch(err => {
      console.error('Erreur chargement adversaires:', err);
      showNotification('Erreur lors du chargement des adversaires', 'error');
    });
}

// Helpers
function getAthleteColorSimple(id) {
  const colors = ['#f97316', '#22d3ee', '#10b981', '#8b5cf6', '#f43f5e', '#fbbf24', '#06b6d4', '#ec4899'];
  const hash = String(id).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function getInitials(name) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
}

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
  
  // Add animation keyframes if not exists
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
