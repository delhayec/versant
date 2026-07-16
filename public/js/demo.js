/**
 * ============================================
 * VERSANT - FONCTIONS DÉMO
 * ============================================
 * Gère les fonctionnalités spécifiques à la démo :
 * - Date simulée
 * - Slider de navigation temporelle
 * - Clic droit contextuel
 */

import { CHALLENGE_CONFIG, getSeasonNumber, getRoundInSeason, getGlobalRoundNumber } from './config.js';
import { formatDate } from './ui.js';

// ============================================
// GESTION DE LA DATE SIMULÉE
// ============================================
let simulatedDate = null;

/**
 * Définit la date simulée
 * @param {Date|string|null} date - Date à simuler ou null pour la date réelle
 */
export function setSimulatedDate(date) {
  simulatedDate = date ? new Date(date) : null;
}

/**
 * Récupère la date courante (simulée ou réelle)
 * @returns {Date}
 */
export function getCurrentDate() {
  return simulatedDate ? new Date(simulatedDate) : new Date();
}

/**
 * Vérifie si on est en mode démo (date simulée active)
 */
export function isDemoMode() {
  return simulatedDate !== null;
}

/**
 * Réinitialise à la date réelle
 */
export function resetToRealDate() {
  simulatedDate = null;
}

// ============================================
// SLIDER DE NAVIGATION TEMPORELLE
// ============================================

/**
 * Initialise le slider de date
 * @param {Function} onDateChange - Callback appelé quand la date change
 */
export function initDateSlider(onDateChange) {
  const container = document.getElementById('dateSliderContainer');
  if (!container) return;
  
  const yearStart = new Date(CHALLENGE_CONFIG.yearStartDate);
  const yearEnd = new Date(CHALLENGE_CONFIG.yearEndDate);
  const today = getCurrentDate();
  const totalDays = Math.floor((yearEnd - yearStart) / (1000 * 60 * 60 * 24));
  let currentDay = Math.floor((today - yearStart) / (1000 * 60 * 60 * 24));
  currentDay = Math.max(0, Math.min(totalDays, currentDay));
  
  container.innerHTML = `
    <div class="slider-compact">
      <div class="slider-left">
        <button class="slider-nav-btn" id="prevDay" title="Jour précédent">◀</button>
        <button class="slider-nav-btn" id="nextDay" title="Jour suivant">▶</button>
        <span class="slider-date" id="sliderDate">${formatDate(today)}</span>
        <span class="slider-info-inline">
          <span class="info-badge">S<strong id="sliderSeason">${getSeasonNumber(today)}</strong></span>
          <span class="info-badge">R<strong id="sliderRound">${getRoundInSeason(today)}</strong></span>
        </span>
        <button class="slider-reset-btn" id="resetDate" title="Retour à aujourd'hui">↻</button>
      </div>
      <div class="slider-right">
        <input type="range" class="date-slider" id="dateSlider" min="0" max="${totalDays}" value="${currentDay}">
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
    
    if (onDateChange) onDateChange(newDate);
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
  
  document.getElementById('resetDate')?.addEventListener('click', () => {
    resetToRealDate();
    const realToday = new Date();
    const dayOffset = Math.floor((realToday - yearStart) / (1000 * 60 * 60 * 24));
    slider.value = Math.max(0, Math.min(totalDays, dayOffset));
    
    dateLabel.textContent = formatDate(realToday);
    seasonLabel.textContent = getSeasonNumber(realToday);
    roundLabel.textContent = getRoundInSeason(realToday);
    
    if (onDateChange) onDateChange(realToday);
  });
}

// ============================================
// UTILITAIRES DE FORMATAGE (LOCAUX)
// ============================================

// formatDate : voir import depuis ui.js (source unique).

// ============================================
// NAVIGATION PAR CLIC DROIT (JUMP TO DATE)
// ============================================
let jumpModal = null;

/**
 * Affiche une modale pour sauter à une date spécifique
 */
export function showJumpToDateModal(onDateSelect) {
  if (jumpModal) {
    document.body.removeChild(jumpModal);
  }
  
  jumpModal = document.createElement('div');
  jumpModal.className = 'jump-modal';
  jumpModal.innerHTML = `
    <div class="jump-modal-content">
      <div class="jump-modal-header">
        <span>📅 Aller à une date</span>
        <button class="jump-modal-close">&times;</button>
      </div>
      <div class="jump-modal-body">
        <div class="jump-presets">
          <button class="preset-btn" data-preset="today">Aujourd'hui</button>
          <button class="preset-btn" data-preset="season-start">Début saison</button>
          <button class="preset-btn" data-preset="round-start">Début round</button>
          <button class="preset-btn" data-preset="year-start">1er janvier</button>
        </div>
        <div class="jump-custom">
          <label>Date personnalisée :</label>
          <input type="date" id="customDate" value="${getCurrentDate().toISOString().split('T')[0]}">
          <button class="go-btn" id="goToDate">Aller</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(jumpModal);
  
  // Fermer la modale
  jumpModal.querySelector('.jump-modal-close').onclick = () => {
    document.body.removeChild(jumpModal);
    jumpModal = null;
  };
  
  jumpModal.onclick = (e) => {
    if (e.target === jumpModal) {
      document.body.removeChild(jumpModal);
      jumpModal = null;
    }
  };
  
  // Présets
  jumpModal.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      let targetDate;
      const today = new Date();
      const current = getCurrentDate();
      
      switch (btn.dataset.preset) {
        case 'today':
          resetToRealDate();
          targetDate = today;
          break;
        case 'season-start':
          const season = getSeasonNumber(current);
          const durationDays = Math.ceil((PARTICIPANTS?.length || 13 - 1) / CHALLENGE_CONFIG.eliminationsPerRound) * CHALLENGE_CONFIG.roundDurationDays;
          targetDate = new Date(CHALLENGE_CONFIG.yearStartDate);
          targetDate.setDate(targetDate.getDate() + (season - 1) * durationDays);
          break;
        case 'round-start':
          const globalRound = getGlobalRoundNumber(current);
          targetDate = new Date(CHALLENGE_CONFIG.yearStartDate);
          targetDate.setDate(targetDate.getDate() + (globalRound - 1) * CHALLENGE_CONFIG.roundDurationDays);
          break;
        case 'year-start':
          targetDate = new Date(CHALLENGE_CONFIG.yearStartDate);
          break;
      }
      
      if (targetDate) {
        setSimulatedDate(targetDate);
        if (onDateSelect) onDateSelect(targetDate);
      }
      
      document.body.removeChild(jumpModal);
      jumpModal = null;
    };
  });
  
  // Date personnalisée
  document.getElementById('goToDate').onclick = () => {
    const customDate = new Date(document.getElementById('customDate').value);
    if (!isNaN(customDate.getTime())) {
      setSimulatedDate(customDate);
      if (onDateSelect) onDateSelect(customDate);
    }
    document.body.removeChild(jumpModal);
    jumpModal = null;
  };
}

// ============================================
// INITIALISATION GLOBALE DÉMO
// ============================================

/**
 * Initialise le mode démo complet
 * @param {Object} options - Options d'initialisation
 * @param {Function} options.onDateChange - Callback appelé quand la date change
 * @param {boolean} options.showSlider - Afficher le slider (défaut: true)
 * @param {boolean} options.enableRightClick - Activer le clic droit (défaut: true)
 */
export function initDemoMode(options = {}) {
  const { onDateChange, showSlider = true, enableRightClick = true } = options;
  
  // Slider de date
  if (showSlider) {
    initDateSlider(onDateChange);
  }
  
  // Clic droit sur l'espace vide pour jump to date
  if (enableRightClick) {
    document.addEventListener('contextmenu', (e) => {
      // Ne pas intercepter si on clique sur un élément interactif
      if (e.target.closest('.ranking-row, .participant-card, .joker-context-menu')) {
        return;
      }
      
      // Sur un espace vide, proposer le jump to date
      if (e.target.closest('.main-content, .container, body')) {
        e.preventDefault();
        showJumpToDateModal(onDateChange);
      }
    });
  }
  
  console.log('🎮 Mode démo initialisé');
}

// Import pour utiliser PARTICIPANTS (circular import handling)
import { PARTICIPANTS } from './config.js';
