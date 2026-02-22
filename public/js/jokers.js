/**
 * ============================================
 * VERSANT - GESTION DES JOKERS v2.0
 * ============================================
 * NOUVEAU: Synchronisation avec le serveur API
 * Les jokers sont stockés côté serveur, pas en localStorage
 */

import { PARTICIPANTS, JOKER_TYPES, getParticipantById } from './config.js';

const API_BASE = '/api';
const LEAGUE_ID = 'versant-2026';

// Cache local des jokers (chargé depuis le serveur)
let jokersCache = {
  stocks: {},      // Stock par participant
  usage: [],       // Historique d'utilisation
  active: [],      // Jokers actifs ce round
  lastFetch: null
};

// ============================================
// CHARGEMENT DEPUIS LE SERVEUR
// ============================================

/**
 * Charge tous les jokers depuis le serveur
 */
export async function loadJokersFromServer() {
  try {
    // Charger les athlètes (contient le stock de jokers)
    const athletesRes = await fetch(`${API_BASE}/athletes/${LEAGUE_ID}`);
    if (!athletesRes.ok) throw new Error('Erreur chargement athlètes');

    // Charger l'historique des jokers utilisés
    // Note: cet endpoint est public pour afficher les jokers actifs
    const usageRes = await fetch(`${API_BASE}/jokers/all`);
    const usage = usageRes.ok ? await usageRes.json() : [];

    jokersCache.usage = usage;
    jokersCache.lastFetch = Date.now();

    console.log('🃏 Jokers chargés depuis le serveur:', usage.length, 'utilisations');

    return jokersCache;
  } catch (error) {
    console.error('Erreur chargement jokers:', error);
    return jokersCache;
  }
}

/**
 * Initialise l'état des jokers (appel au démarrage)
 */
export async function initializeJokersState() {
  await loadJokersFromServer();

  // Initialiser le cache des stocks pour chaque participant
  PARTICIPANTS.forEach(p => {
    if (!jokersCache.stocks[p.id]) {
      // Stock par défaut si pas encore chargé
      jokersCache.stocks[p.id] = {
        stock: { voleur: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 },
        used: [],
        active: [],
        pending: []
      };
    }
  });

  console.log('🃏 Jokers initialisés pour', Object.keys(jokersCache.stocks).length, 'participants');
}

/**
 * Sauvegarde - ne fait rien car tout est géré côté serveur
 */
export function saveJokersState() {
  // Pas de sauvegarde locale - tout est sur le serveur
  console.log('🃏 Jokers gérés côté serveur');
}

// ============================================
// GESTION DU STOCK
// ============================================

/**
 * Récupère le stock de jokers d'un participant
 */
export function getJokerStock(participantId) {
  const state = jokersCache.stocks[participantId];
  if (state) return state.stock;

  // Stock par défaut
  return { voleur: 2, multiplicateur: 2, bouclier: 2, sabotage: 2 };
}

/**
 * Vérifie combien de jokers d'un type ont été utilisés par un participant
 */
export function getUsedJokerCount(participantId, jokerId) {
  return jokersCache.usage.filter(
    u => String(u.athlete_id) === String(participantId) && u.joker_id === jokerId
  ).length;
}

/**
 * Calcule le stock restant d'un joker
 */
export function getRemainingStock(participantId, jokerId) {
  const initialStock = 2; // Chaque joueur commence avec 2 de chaque
  const used = getUsedJokerCount(participantId, jokerId);
  return Math.max(0, initialStock - used);
}

// ============================================
// UTILISATION DES JOKERS
// ============================================

/**
 * Utilise un joker via l'API serveur
 */
export async function useJoker(participantId, jokerId, currentRoundNumber, currentDate, options = {}) {
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) return { success: false, error: 'Joker inconnu' };

  // Vérifier le stock
  const remaining = getRemainingStock(participantId, jokerId);
  if (remaining <= 0) {
    return { success: false, error: 'Plus de joker disponible' };
  }

  try {
    const token = localStorage.getItem('versant_token');

    const response = await fetch(`${API_BASE}/jokers/use`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        joker_id: jokerId,
        target_athlete_id: options.targetId || null,
        selected_day: options.selectedDay || null,
        activate_now: options.activateNow || false,
        round_number: options.activateNow ? currentRoundNumber : currentRoundNumber + 1
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return { success: false, error: err.error || 'Erreur serveur' };
    }

    const result = await response.json();

    // Mettre à jour le cache local
    jokersCache.usage.push(result.usage);

    return {
      success: true,
      usage: result.usage,
      activationRound: result.usage.round_number
    };

  } catch (error) {
    console.error('Erreur utilisation joker:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// RÉCUPÉRATION DES JOKERS ACTIFS
// ============================================

/**
 * Récupère tous les jokers actifs pour un round donné
 */
export function getActiveJokersForRound(roundNumber) {
  const activeJokers = [];

  jokersCache.usage
    .filter(u => u.round_number === roundNumber && u.status === 'active')
    .forEach(u => {
      const participant = getParticipantById(u.athlete_id);
      const jokerType = JOKER_TYPES[u.joker_id];

      if (participant && jokerType) {
        activeJokers.push({
          ...u,
          participantId: u.athlete_id,
          participantName: participant.name,
          jokerId: u.joker_id,
          jokerName: jokerType.name,
          jokerIcon: jokerType.icon,
          targetId: u.target_athlete_id,
          targetName: u.target_athlete_id ? getParticipantById(u.target_athlete_id)?.name : null
        });
      }
    });

  return activeJokers;
}

/**
 * Récupère les jokers en attente pour le prochain round
 */
export function getPendingJokersForNextRound(currentRoundNumber) {
  return getActiveJokersForRound(currentRoundNumber + 1);
}

/**
 * Active les jokers en attente (appelé automatiquement)
 */
export function activatePendingJokers(currentRoundNumber) {
  // Les jokers sont déjà "actifs" côté serveur basé sur round_number
  // Cette fonction existe pour compatibilité
  console.log(`🃏 Jokers pour round ${currentRoundNumber}:`, getActiveJokersForRound(currentRoundNumber).length);
}

// ============================================
// APPLICATION DES EFFETS
// ============================================

/**
 * Applique les effets des jokers sur le classement
 */
export function applyJokerEffects(ranking, currentRoundNumber, activities = []) {
  const effects = {};
  const activeJokers = getActiveJokersForRound(currentRoundNumber);

  console.log(`🃏 Application des effets pour round ${currentRoundNumber}:`, activeJokers.length, 'jokers actifs');

  activeJokers.forEach(joker => {
    const participant = ranking.find(r => String(r.participant.id) === String(joker.participantId));
    if (!participant) return;

    if (!effects[joker.participantId]) {
      effects[joker.participantId] = { bonuses: {} };
    }

    // ---- VOLEUR : Vole l'activité avec le plus de D+ de la cible ----
    if (joker.jokerId === 'voleur' && joker.targetId) {
      const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (target) {
        // Trouver l'activité avec le plus de D+ de la cible
        const targetActivities = activities.filter(a =>
          String(a.athlete_id) === String(joker.targetId) ||
          String(a.athlete?.id) === String(joker.targetId)
        );

        if (targetActivities.length > 0) {
          const bestActivity = targetActivities.reduce((best, curr) =>
            (curr.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? curr : best
          );

          const stolenElevation = bestActivity.total_elevation_gain || 0;

          if (stolenElevation > 0) {
            participant.totalElevation += stolenElevation;
            target.totalElevation = Math.max(0, target.totalElevation - stolenElevation);

            effects[joker.participantId].bonuses.voleur = {
              amount: stolenElevation,
              from: target.participant.name,
              activityName: bestActivity.name
            };

            if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
            effects[joker.targetId].bonuses.vpiked = {
              amount: stolenElevation,
              by: participant.participant.name,
              activityName: bestActivity.name
            };
          }
        }
      }
    }

    // ---- MULTIPLICATEUR : ×2 sur un jour spécifique ----
    else if (joker.jokerId === 'multiplicateur') {
      const selectedDay = joker.selected_day;

      if (selectedDay) {
        // Trouver les activités de ce jour
        const dayActivities = activities.filter(a => {
          const actDate = a.start_date?.substring(0, 10);
          return actDate === selectedDay &&
            (String(a.athlete_id) === String(joker.participantId) ||
             String(a.athlete?.id) === String(joker.participantId));
        });

        const dayElevation = dayActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
        const bonus = dayElevation; // ×2 = ajouter 1× de plus

        participant.totalElevation += bonus;
        effects[joker.participantId].bonuses.multiplicateur = {
          amount: bonus,
          day: selectedDay
        };
      } else {
        // Fallback: ×1.5 sur tout le D+ si pas de jour sélectionné
        const bonus = Math.round(participant.totalElevation * 0.5);
        participant.totalElevation += bonus;
        effects[joker.participantId].bonuses.multiplicateur = { amount: bonus };
      }
    }

    // ---- SABOTAGE : -25% du D+ de la cible ----
    else if (joker.jokerId === 'sabotage' && joker.targetId) {
      const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      if (target) {
        const malus = Math.round(target.totalElevation * 0.25);
        target.totalElevation = Math.max(0, target.totalElevation - malus);

        if (!effects[joker.targetId]) effects[joker.targetId] = { bonuses: {} };
        effects[joker.targetId].bonuses.sabotaged = { amount: malus, by: participant.participant.name };
        effects[joker.participantId].bonuses.sabotageApplied = { amount: malus, to: target.participant.name };
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
  const used = jokersCache.usage.filter(u => String(u.athlete_id) === String(participantId));
  const active = used.filter(u => u.round_number === roundNumber);
  const pending = used.filter(u => u.round_number === roundNumber + 1);

  // Calculer le stock restant
  const stock = {};
  Object.keys(JOKER_TYPES).forEach(jokerId => {
    stock[jokerId] = getRemainingStock(participantId, jokerId);
  });

  return {
    stock,
    active,
    pending,
    used
  };
}

/**
 * Récupère l'état complet de tous les jokers d'un participant
 */
export function getParticipantJokersState(participantId) {
  return {
    stock: getJokerStock(participantId),
    usage: jokersCache.usage.filter(u => String(u.athlete_id) === String(participantId))
  };
}

/**
 * Récupère l'état complet de tous les jokers (debug/admin)
 */
export function getAllJokersState() {
  return { ...jokersCache };
}

/**
 * Recharge les jokers depuis le serveur
 */
export async function refreshJokersFromServer() {
  await loadJokersFromServer();
}

// ============================================
// FONCTIONS ADMIN (ajout/suppression manuelle)
// ============================================

/**
 * Ajoute un joker au stock d'un participant (admin only)
 */
export function addJoker(participantId, jokerId) {
  const pid = String(participantId);
  if (!jokersCache[pid]) {
    jokersCache[pid] = { stock: {}, used: [] };
  }
  if (!jokersCache[pid].stock) {
    jokersCache[pid].stock = {};
  }
  jokersCache[pid].stock[jokerId] = (jokersCache[pid].stock[jokerId] || 0) + 1;
  saveJokersState();
  console.log(`➕ Joker ${jokerId} ajouté pour ${pid}`);
  return true;
}

/**
 * Retire un joker du stock d'un participant (admin only)
 */
export function removeJoker(participantId, jokerId) {
  const pid = String(participantId);
  if (!jokersCache[pid]?.stock?.[jokerId] || jokersCache[pid].stock[jokerId] <= 0) {
    console.warn(`⚠️ Pas de joker ${jokerId} à retirer pour ${pid}`);
    return false;
  }
  jokersCache[pid].stock[jokerId]--;
  saveJokersState();
  console.log(`➖ Joker ${jokerId} retiré pour ${pid}`);
  return true;
}

/**
 * Réinitialise tous les jokers d'un participant (admin only)
 */
export function resetJokers(participantId) {
  const pid = String(participantId);
  jokersCache[pid] = {
    stock: {
      multiplicateur: 2,
      bouclier: 2,
      sabotage: 2,
      voleur: 2
    },
    used: []
  };
  saveJokersState();
  console.log(`🔄 Jokers réinitialisés pour ${pid}`);
  return true;
}