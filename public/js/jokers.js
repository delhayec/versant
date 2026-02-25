/**
 * ============================================
 * VERSANT - GESTION DES JOKERS v3.0 (CLEAN)
 * ============================================
 *
 * SOURCE UNIQUE: Le serveur API (/api/jokers/all)
 *
 * Le serveur stocke uniquement les UTILISATIONS de jokers.
 * Le stock est calculé: INITIAL (2) - UTILISATIONS
 *
 * PAS de localStorage, PAS de cache complexe.
 */

import { PARTICIPANTS, JOKER_TYPES, getParticipantById } from './config.js';

// ============================================
// CONFIGURATION
// ============================================

const API_BASE = '/api';
const LEAGUE_ID = 'versant-2026';
const INITIAL_STOCK = 2; // Chaque joueur commence avec 2 de chaque joker

// ============================================
// CACHE SIMPLE - UNIQUE SOURCE DE VÉRITÉ
// ============================================

// Le cache contient uniquement les utilisations chargées depuis le serveur
let jokerUsageCache = [];
let cacheTimestamp = null;

// ============================================
// CHARGEMENT DEPUIS LE SERVEUR
// ============================================

/**
 * Charge les utilisations de jokers depuis le serveur
 * C'est LA source de vérité pour tout le calcul des jokers
 */
export async function loadJokersFromServer() {
  try {
    // Ajouter un timestamp pour éviter le cache navigateur
    const cacheBuster = Date.now();
    const response = await fetch(`${API_BASE}/jokers/all?_=${cacheBuster}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache'
      }
    });
    if (!response.ok) {
      console.warn('⚠️ Impossible de charger les jokers depuis le serveur');
      return jokerUsageCache;
    }

    jokerUsageCache = await response.json();
    cacheTimestamp = Date.now();

    console.log(`🃏 ${jokerUsageCache.length} utilisations de jokers chargées depuis le serveur`);
    return jokerUsageCache;
  } catch (error) {
    console.error('❌ Erreur chargement jokers:', error);
    return jokerUsageCache;
  }
}

/**
 * Initialise l'état des jokers (appelé au démarrage de l'app)
 */
export async function initializeJokersState() {
  await loadJokersFromServer();
  console.log(`🃏 Jokers initialisés - ${PARTICIPANTS.length} participants, ${jokerUsageCache.length} utilisations`);
}

/**
 * Rafraîchit les jokers depuis le serveur
 */
export async function refreshJokersFromServer() {
  return await loadJokersFromServer();
}

/**
 * Sauvegarde - NE FAIT RIEN car tout est géré côté serveur
 */
export function saveJokersState() {
  // Les jokers sont gérés uniquement côté serveur
  // Cette fonction existe pour compatibilité mais ne fait rien
}

// ============================================
// CALCUL DU STOCK (basé sur les utilisations)
// ============================================

/**
 * Compte combien de fois un joker a été utilisé par un participant
 */
export function getUsedJokerCount(participantId, jokerId) {
  const pid = String(participantId);
  return jokerUsageCache.filter(
    u => String(u.athlete_id) === pid && u.joker_id === jokerId
  ).length;
}

/**
 * Calcule le stock restant d'un joker pour un participant
 * Stock = INITIAL (2) - Utilisations
 */
export function getRemainingStock(participantId, jokerId) {
  const used = getUsedJokerCount(participantId, jokerId);
  return Math.max(0, INITIAL_STOCK - used);
}

/**
 * Récupère le stock complet de jokers d'un participant
 * Retourne { voleur: X, multiplicateur: X, bouclier: X, sabotage: X }
 */
export function getJokerStock(participantId) {
  const stock = {};
  Object.keys(JOKER_TYPES).forEach(jokerId => {
    stock[jokerId] = getRemainingStock(participantId, jokerId);
  });
  return stock;
}

// ============================================
// ÉTAT DES JOKERS PAR ROUND
// ============================================

/**
 * Récupère l'état complet des jokers d'un participant pour un round
 * C'est LA fonction principale utilisée par l'UI
 */
export function getJokerStatusForRound(participantId, roundNumber) {
  const pid = String(participantId);

  // Filtrer les utilisations de ce participant
  const myUsage = jokerUsageCache.filter(u => String(u.athlete_id) === pid);

  // Jokers actifs ce round
  const active = myUsage.filter(u => u.round_number === roundNumber && u.status === 'active');

  // Jokers programmés pour le prochain round
  const pending = myUsage.filter(u => u.round_number === roundNumber + 1);

  // Calculer le stock restant
  const stock = getJokerStock(participantId);

  return {
    stock,
    active,
    pending,
    allUsage: myUsage
  };
}

/**
 * Récupère tous les jokers actifs pour un round donné (tous participants)
 */
export function getActiveJokersForRound(roundNumber) {
  return jokerUsageCache
    .filter(u => u.round_number === roundNumber && u.status === 'active')
    .map(u => {
      const participant = getParticipantById(u.athlete_id);
      const jokerType = JOKER_TYPES[u.joker_id];
      const target = u.target_athlete_id ? getParticipantById(u.target_athlete_id) : null;

      return {
        ...u,
        participantId: String(u.athlete_id),
        participantName: participant?.name || 'Inconnu',
        jokerId: u.joker_id,
        jokerName: jokerType?.name || u.joker_id,
        jokerIcon: jokerType?.icon || '🃏',
        targetId: u.target_athlete_id ? String(u.target_athlete_id) : null,
        targetName: target?.name || null
      };
    });
}

/**
 * Récupère les jokers programmés pour le prochain round
 */
export function getPendingJokersForNextRound(currentRoundNumber) {
  return getActiveJokersForRound(currentRoundNumber + 1);
}

// ============================================
// UTILISATION D'UN JOKER (via API)
// ============================================

/**
 * Utilise un joker via l'API serveur
 */
export async function useJoker(participantId, jokerId, currentRoundNumber, currentDate, options = {}) {
  const jokerType = JOKER_TYPES[jokerId];
  if (!jokerType) {
    return { success: false, error: 'Joker inconnu' };
  }

  // Vérifier le stock
  const remaining = getRemainingStock(participantId, jokerId);
  if (remaining <= 0) {
    return { success: false, error: 'Plus de joker disponible' };
  }

  try {
    const token = localStorage.getItem('versant_token');
    if (!token) {
      return { success: false, error: 'Non authentifié' };
    }

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

    // Ajouter au cache local pour mise à jour immédiate
    jokerUsageCache.push(result.usage);

    return {
      success: true,
      usage: result.usage,
      activationRound: result.usage.round_number
    };

  } catch (error) {
    console.error('❌ Erreur utilisation joker:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// APPLICATION DES EFFETS SUR LE CLASSEMENT
// ============================================

/**
 * Applique les effets des jokers actifs sur le classement
 *
 * RÈGLES DE CUMUL:
 * - Sabotage: 30% calculé sur le D+ ORIGINAL (avant tout bonus), cumulable
 * - Voleur: La même activité peut être volée plusieurs fois
 * - Multiplicateur: Appliqué sur le D+ après sabotages/vols
 * - Bouclier: Protection contre l'élimination
 */
export function applyJokerEffects(ranking, currentRoundNumber, activities = []) {
  const activeJokers = getActiveJokersForRound(currentRoundNumber);

  // Créer une copie du ranking avec le D+ original sauvegardé
  const modifiedRanking = ranking.map(entry => ({
    ...entry,
    originalElevation: entry.totalElevation, // D+ de base (pour calcul sabotage)
    jokerEffects: {
      bonuses: {},
      sabotages: [],    // Liste des sabotages reçus
      thefts: [],       // Liste des vols subis
      stolenActivities: [] // Activités volées (pour éviter double comptage sur la même activité)
    }
  }));

  // ========================================
  // ÉTAPE 1: Appliquer les SABOTAGES (sur D+ original)
  // ========================================
  const sabotageJokers = activeJokers.filter(j => j.jokerId === 'sabotage');

  sabotageJokers.forEach(joker => {
    if (!joker.targetId) return;

    const targetEntry = modifiedRanking.find(e => String(e.participant.id) === joker.targetId);
    const attackerEntry = modifiedRanking.find(e => String(e.participant.id) === joker.participantId);

    if (targetEntry && attackerEntry) {
      // 30% calculé sur le D+ ORIGINAL (avant tout bonus)
      const penalty = Math.round(targetEntry.originalElevation * 0.3);
      targetEntry.totalElevation = Math.max(0, targetEntry.totalElevation - penalty);

      // Enregistrer le sabotage
      targetEntry.jokerEffects.sabotages.push({
        by: joker.participantName,
        byId: joker.participantId,
        amount: penalty
      });

      // Marquer l'attaquant
      if (!attackerEntry.jokerEffects.bonuses.sabotageApplied) {
        attackerEntry.jokerEffects.bonuses.sabotageApplied = [];
      }
      attackerEntry.jokerEffects.bonuses.sabotageApplied.push({
        to: targetEntry.participant.name,
        toId: joker.targetId,
        amount: penalty
      });
    }
  });

  // Consolider les sabotages pour l'affichage
  modifiedRanking.forEach(entry => {
    if (entry.jokerEffects.sabotages.length > 0) {
      const totalPenalty = entry.jokerEffects.sabotages.reduce((sum, s) => sum + s.amount, 0);
      const attackers = entry.jokerEffects.sabotages.map(s => s.by).join(', ');
      entry.jokerEffects.bonuses.sabotaged = {
        by: attackers,
        amount: totalPenalty,
        count: entry.jokerEffects.sabotages.length
      };
    }
  });

  // ========================================
  // ÉTAPE 2: Appliquer les VOLS (sur D+ original, même activité peut être volée plusieurs fois)
  // ========================================
  const voleurJokers = activeJokers.filter(j => j.jokerId === 'voleur');

  voleurJokers.forEach(joker => {
    if (!joker.targetId || activities.length === 0) return;

    const targetEntry = modifiedRanking.find(e => String(e.participant.id) === joker.targetId);
    const thiefEntry = modifiedRanking.find(e => String(e.participant.id) === joker.participantId);

    if (!targetEntry || !thiefEntry) return;

    // Trouver les activités de la cible
    const targetActivities = activities.filter(a =>
      String(a.athlete_id || a.athlete?.id) === joker.targetId
    );

    if (targetActivities.length === 0) return;

    // Trouver la meilleure activité
    const bestActivity = targetActivities.reduce((best, current) =>
      (current.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? current : best
    );

    const stolenElevation = Math.round(bestActivity.total_elevation_gain || 0);

    if (stolenElevation > 0) {
      // Retirer le D+ à la victime
      targetEntry.totalElevation = Math.max(0, targetEntry.totalElevation - stolenElevation);

      // Ajouter le D+ au voleur
      thiefEntry.totalElevation += stolenElevation;

      // Enregistrer le vol
      targetEntry.jokerEffects.thefts.push({
        by: joker.participantName,
        byId: joker.participantId,
        amount: stolenElevation,
        activity: bestActivity.name
      });

      if (!thiefEntry.jokerEffects.bonuses.thief) {
        thiefEntry.jokerEffects.bonuses.thief = [];
      }
      thiefEntry.jokerEffects.bonuses.thief.push({
        from: targetEntry.participant.name,
        fromId: joker.targetId,
        amount: stolenElevation,
        activity: bestActivity.name
      });
    }
  });

  // Consolider les vols pour l'affichage
  modifiedRanking.forEach(entry => {
    if (entry.jokerEffects.thefts.length > 0) {
      const totalStolen = entry.jokerEffects.thefts.reduce((sum, t) => sum + t.amount, 0);
      const thieves = entry.jokerEffects.thefts.map(t => t.by).join(', ');
      entry.jokerEffects.bonuses.stolen = {
        by: thieves,
        amount: totalStolen,
        count: entry.jokerEffects.thefts.length
      };
    }
  });

  // ========================================
  // ÉTAPE 3: Appliquer les MULTIPLICATEURS (sur D+ après sabotages/vols)
  // ========================================
  const multiplicateurJokers = activeJokers.filter(j => j.jokerId === 'multiplicateur');

  multiplicateurJokers.forEach(joker => {
    const participantEntry = modifiedRanking.find(e => String(e.participant.id) === joker.participantId);
    if (!participantEntry) return;

    // ×1.5 sur le D+ actuel (après sabotages/vols)
    const bonus = Math.round(participantEntry.totalElevation * 0.5);
    participantEntry.totalElevation += bonus;
    participantEntry.jokerEffects.bonuses.multiplier = {
      factor: 1.5,
      amount: bonus
    };
  });

  // ========================================
  // ÉTAPE 4: Appliquer les BOUCLIERS
  // ========================================
  const bouclierJokers = activeJokers.filter(j => j.jokerId === 'bouclier');

  bouclierJokers.forEach(joker => {
    const participantEntry = modifiedRanking.find(e => String(e.participant.id) === joker.participantId);
    if (!participantEntry) return;

    participantEntry.jokerEffects.hasShield = true;
    participantEntry.jokerEffects.bonuses.shield = true;
  });

  // ========================================
  // ÉTAPE 5: Retrier le classement
  // ========================================
  modifiedRanking.sort((a, b) => b.totalElevation - a.totalElevation);

  // Recalculer les positions
  modifiedRanking.forEach((entry, index) => {
    entry.position = index + 1;
  });

  return modifiedRanking;
}

// ============================================
// FONCTIONS ADMIN (compatibilité)
// ============================================

/**
 * Ces fonctions sont gardées pour compatibilité mais
 * ne font que des modifications locales temporaires.
 * Les vraies modifications doivent passer par le serveur.
 */

export function addJoker(participantId, jokerId) {
  console.warn('⚠️ addJoker: Utilisez l\'API admin pour modifier les jokers de façon permanente');
  return false;
}

export function removeJoker(participantId, jokerId) {
  console.warn('⚠️ removeJoker: Utilisez l\'API admin pour modifier les jokers de façon permanente');
  return false;
}

export function resetJokers(participantId) {
  console.warn('⚠️ resetJokers: Utilisez l\'API admin /api/admin/jokers/reset-all');
  return false;
}

// ============================================
// DEBUG & DIAGNOSTIC
// ============================================

/**
 * Retourne l'état complet du cache (pour debug)
 */
export function getAllJokersState() {
  return {
    usage: jokerUsageCache,
    cacheTimestamp,
    participantCount: PARTICIPANTS.length
  };
}

/**
 * Récupère l'état des jokers d'un participant (pour debug)
 */
export function getParticipantJokersState(participantId) {
  return {
    stock: getJokerStock(participantId),
    usage: jokerUsageCache.filter(u => String(u.athlete_id) === String(participantId))
  };
}

/**
 * Vérifie la cohérence du cache
 */
export function validateJokersCache() {
  const issues = [];

  // Vérifier que tous les athlete_id correspondent à des participants existants
  const unknownAthletes = jokerUsageCache.filter(u => !getParticipantById(u.athlete_id));
  if (unknownAthletes.length > 0) {
    issues.push(`${unknownAthletes.length} utilisations avec athlete_id inconnu`);
  }

  // Vérifier qu'aucun participant n'a utilisé plus de 2 fois le même joker
  PARTICIPANTS.forEach(p => {
    Object.keys(JOKER_TYPES).forEach(jokerId => {
      const count = getUsedJokerCount(p.id, jokerId);
      if (count > INITIAL_STOCK) {
        issues.push(`${p.name} a utilisé ${count}x ${jokerId} (max: ${INITIAL_STOCK})`);
      }
    });
  });

  return {
    valid: issues.length === 0,
    issues
  };
}