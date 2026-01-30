/**
 * ============================================
 * VERSANT - GESTION DES JOKERS
 * ============================================
 * Gère l'état, l'utilisation et les effets des jokers.
 * Stockage en localStorage pour persistance.
 */

import { PARTICIPANTS, JOKER_TYPES, getParticipantById } from './config.js';

// ============================================
// ÉTAT DES JOKERS
// ============================================
let jokersState = {};

/**
 * Initialise l'état des jokers pour tous les participants
 */
export function initializeJokersState() {
  jokersState = {};
  
  PARTICIPANTS.forEach(p => {
    let stock = { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };
    
    // Récupérer le stock initial depuis la config du participant
    if (p.jokerStock) stock = p.jokerStock;
    else if (p.jokers_stock) stock = p.jokers_stock;
    else if (p.jokers && typeof p.jokers === 'object') stock = p.jokers;
    
    jokersState[p.id] = {
      stock: { ...stock },
      used: [],      // Historique des jokers utilisés
      active: [],    // Jokers actifs ce round
      pending: []    // Jokers programmés pour le prochain round
    };
  });
  
  // Charger l'état sauvegardé
  loadJokersState();
  
  console.log('🃏 Jokers initialisés:', Object.keys(jokersState).length, 'participants');
}

/**
 * Charge l'état des jokers depuis localStorage
 */
function loadJokersState() {
  try {
    const saved = localStorage.getItem('versant_jokers_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(jokersState, parsed);
    }
  } catch (e) {
    console.warn('Impossible de charger l\'état des jokers:', e);
  }
}

/**
 * Sauvegarde l'état des jokers dans localStorage
 */
export function saveJokersState() {
  try {
    localStorage.setItem('versant_jokers_state', JSON.stringify(jokersState));
  } catch (e) {
    console.warn('Impossible de sauvegarder l\'état des jokers:', e);
  }
}

// ============================================
// GESTION DU STOCK
// ============================================

/**
 * Récupère le stock de jokers d'un participant
 */
export function getJokerStock(participantId) {
  return jokersState[participantId]?.stock || { duel: 0, multiplicateur: 0, bouclier: 0, sabotage: 0 };
}

/**
 * Ajoute un joker au stock (admin)
 */
export function addJoker(participantId, jokerId) {
  const state = jokersState[participantId];
  if (!state) return false;
  if (!JOKER_TYPES[jokerId]) return false;
  
  state.stock[jokerId] = (state.stock[jokerId] || 0) + 1;
  saveJokersState();
  return true;
}

/**
 * Retire un joker du stock (admin)
 */
export function removeJoker(participantId, jokerId) {
  const state = jokersState[participantId];
  if (!state) return false;
  if (!state.stock[jokerId] || state.stock[jokerId] <= 0) return false;
  
  state.stock[jokerId]--;
  saveJokersState();
  return true;
}

/**
 * Réinitialise les jokers d'un participant
 */
export function resetJokers(participantId) {
  const state = jokersState[participantId];
  if (!state) return false;
  
  state.stock = { duel: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };
  state.used = [];
  state.active = [];
  state.pending = [];
  saveJokersState();
  return true;
}

// ============================================
// UTILISATION DES JOKERS
// ============================================

/**
 * Utilise un joker - programmé pour le PROCHAIN round
 * @param {string} participantId - ID du participant
 * @param {string} jokerId - Type de joker (duel, multiplicateur, etc.)
 * @param {number} currentRoundNumber - Numéro du round actuel
 * @param {Date} currentDate - Date actuelle
 * @param {Object} options - Options supplémentaires (targetId, targetName pour duel/sabotage)
 */
export function useJoker(participantId, jokerId, currentRoundNumber, currentDate, options = {}) {
  const state = jokersState[participantId];
  if (!state) return { success: false, error: 'Participant non trouvé' };
  
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) return { success: false, error: 'Joker inconnu' };
  
  // Vérifier le stock
  if (!state.stock[jokerId] || state.stock[jokerId] <= 0) {
    return { success: false, error: 'Plus de joker disponible' };
  }
  
  // Décrémenter le stock
  state.stock[jokerId]--;
  
  // Créer l'enregistrement d'utilisation
  const activationRound = currentRoundNumber + 1;
  const usage = {
    id: `${participantId}-${jokerId}-${activationRound}-${Date.now()}`,
    jokerId,
    jokerName: jokerType.name,
    jokerIcon: jokerType.icon,
    round: activationRound,
    scheduledAt: currentRoundNumber,
    usedAt: currentDate.toISOString(),
    ...options
  };
  
  // Ajouter aux pending (sera activé au prochain round)
  state.pending.push(usage);
  
  // Historique complet
  state.used.push(usage);
  
  saveJokersState();
  
  return { success: true, usage, activationRound };
}

// ============================================
// ACTIVATION DES JOKERS
// ============================================

/**
 * Active les jokers en attente pour le round donné
 */
export function activatePendingJokers(currentRoundNumber) {
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const toActivate = (state.pending || []).filter(j => j.round === currentRoundNumber);
    
    toActivate.forEach(j => {
      // Ne pas dupliquer si déjà actif
      if (!state.active.some(a => a.id === j.id)) {
        state.active.push(j);
      }
      // Retirer de pending
      state.pending = state.pending.filter(p => p.id !== j.id);
    });
  });
  
  saveJokersState();
}

/**
 * Récupère tous les jokers actifs pour un round donné
 */
export function getActiveJokersForRound(roundNumber) {
  const activeJokers = [];
  
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const participant = getParticipantById(participantId);
    
    (state.active || [])
      .filter(j => j.round === roundNumber)
      .forEach(j => {
        activeJokers.push({
          ...j,
          participantId,
          participantName: participant?.name || 'Inconnu'
        });
      });
  });
  
  return activeJokers;
}

/**
 * Récupère les jokers en attente pour le prochain round
 */
export function getPendingJokersForNextRound(currentRoundNumber) {
  const pendingJokers = [];
  
  Object.entries(jokersState).forEach(([participantId, state]) => {
    const participant = getParticipantById(participantId);
    
    (state.pending || [])
      .filter(j => j.round === currentRoundNumber + 1)
      .forEach(j => {
        pendingJokers.push({
          ...j,
          participantId,
          participantName: participant?.name || 'Inconnu'
        });
      });
  });
  
  return pendingJokers;
}

// ============================================
// APPLICATION DES EFFETS
// ============================================

/**
 * Applique les effets des jokers sur le classement
 * @param {Array} ranking - Classement à modifier
 * @param {number} currentRoundNumber - Round actuel
 * @returns {Array} Classement modifié avec effets
 */
export function applyJokerEffects(ranking, currentRoundNumber) {
  // Activer les jokers en attente
  activatePendingJokers(currentRoundNumber);
  
  const effects = {};
  const activeJokers = getActiveJokersForRound(currentRoundNumber);
  
  activeJokers.forEach(joker => {
    const participant = ranking.find(r => String(r.participant.id) === String(joker.participantId));
    if (!participant) return;
    
    if (!effects[joker.participantId]) {
      effects[joker.participantId] = { bonuses: {} };
    }
    
    // ---- MULTIPLICATEUR : ×1.5 sur tout le D+ ----
    if (joker.jokerId === 'multiplicateur') {
      const bonus = participant.totalElevation * 0.5; // ×1.5 = base + 50%
      participant.totalElevation += bonus;
      effects[joker.participantId].bonuses.multiplier = { amount: bonus };
    }
    
    // ---- DUEL : Le gagnant vole 25% du D+ du perdant ----
    else if (joker.jokerId === 'duel') {
      const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (target) {
        const challengerWins = participant.totalElevation > target.totalElevation;
        const winner = challengerWins ? participant : target;
        const loser = challengerWins ? target : participant;
        const stolen = Math.round(loser.totalElevation * 0.5);
        
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
        
        // Informations du duel pour l'affichage
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
    }
    
    // ---- SABOTAGE : -25% du D+ de la cible ----
    else if (joker.jokerId === 'sabotage') {
      const sabTarget = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (sabTarget) {
        const malus = Math.round(sabTarget.totalElevation * 0.25);
        sabTarget.totalElevation = Math.max(0, sabTarget.totalElevation - malus);
        
        if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
        effects[joker.targetId].bonuses.sabotaged = { amount: malus, by: participant.participant.name };
        effects[joker.participantId].bonuses.sabotageApplied = { amount: malus, to: sabTarget.participant.name };
      }
    }
    
    // ---- BOUCLIER : Protection contre l'élimination ----
    else if (joker.jokerId === 'bouclier') {
      effects[joker.participantId].hasShield = true;
    }
  });
  
  // Re-trier le classement après application des effets
  ranking.sort((a, b) => b.totalElevation - a.totalElevation);
  
  // Attacher les effets à chaque entrée du classement
  ranking.forEach((e, i) => {
    e.position = i + 1;
    e.jokerEffects = effects[e.participant.id] || { bonuses: {} };
  });
  
  return ranking;
}

// ============================================
// REQUÊTES D'ÉTAT
// ============================================

/**
 * Récupère l'état complet des jokers d'un participant pour un round
 */
export function getJokerStatusForRound(participantId, roundNumber) {
  const state = jokersState[participantId] || { stock: {}, active: [], used: [], pending: [] };
  
  return {
    stock: state.stock,
    active: (state.active || []).filter(j => j.round === roundNumber),
    pending: (state.pending || []).filter(j => j.round === roundNumber + 1),
    used: state.used || []
  };
}

/**
 * Récupère l'état complet de tous les jokers d'un participant
 */
export function getParticipantJokersState(participantId) {
  return jokersState[participantId] || null;
}

/**
 * Récupère l'état complet de tous les jokers (debug/admin)
 */
export function getAllJokersState() {
  return { ...jokersState };
}
