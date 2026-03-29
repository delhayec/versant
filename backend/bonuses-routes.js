/**
 * ============================================
 * VERSANT - ROUTES API BONUS ÉPHÉMÈRES
 * ============================================
 * Gestion des bonus pour le challenge des éliminés
 *
 * Bonus disponibles:
 * - embuscade: Vole une activité aléatoire d'un actif
 * - ravitaillement: Donne une activité aléatoire à un actif
 * - duel: Défie le co-éliminé pour +1 point
 * - brouillard: Cache le D+ jusqu'à fin de saison
 * - marquage: Parie sur l'élimination d'un actif
 * - trap: Piège le prochain dernier éliminé
 * - second_souffle: Double la plus petite activité
 */

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BONUSES_FILE = path.join(DATA_DIR, 'bonuses.json');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');

// Liste des bonus disponibles
const BONUS_IDS = ['embuscade', 'ravitaillement', 'duel', 'brouillard', 'marquage', 'trap', 'second_souffle'];
const BONUS_CHOICE_COUNT = 2;

// ============================================
// UTILITAIRES
// ============================================

function normalizeId(id) {
  if (id === null || id === undefined) return null;
  return String(id).trim();
}

async function safeReadJSON(filepath, defaultValue = []) {
  try {
    const data = await fs.readFile(filepath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

async function safeWriteJSON(filepath, data) {
  await fs.writeFile(filepath, JSON.stringify(data, null, 2));
}

/**
 * Tire au sort N bonus parmi les disponibles
 */
function drawRandomBonuses(count = BONUS_CHOICE_COUNT) {
  const shuffled = [...BONUS_IDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Vérifie si un joueur peut activer un bonus maintenant
 */
function canActivateBonus(bonus, context = {}) {
  const { dayInRound, eliminatedAt, currentDate } = context;
  const timing = bonus.activation_timing;

  switch (timing) {
    case '3_premiers_jours':
      return dayInRound <= 3;

    case '48h_apres_elimination':
      if (!eliminatedAt) return false;
      const hoursSince = (new Date(currentDate) - new Date(eliminatedAt)) / (1000 * 60 * 60);
      return hoursSince <= 48;

    case 'jour_1':
      return dayInRound === 1;

    case 'automatique':
      return true;

    default:
      return false;
  }
}

// ============================================
// CRÉATION DES ROUTES
// ============================================

function createBonusesRoutes(app, requireAuth, checkAdmin) {

  // ==========================================
  // GET /api/bonuses/all - Tous les bonus
  // ==========================================
  app.get('/api/bonuses/all', async (req, res) => {
    try {
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      res.json(bonuses);
    } catch (error) {
      console.error('Erreur lecture bonuses:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // GET /api/bonuses/my - Mes bonus (auth)
  // ==========================================
  app.get('/api/bonuses/my', requireAuth, async (req, res) => {
    try {
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      const myBonus = bonuses.find(b => normalizeId(b.athlete_id) === normalizeId(req.athleteId));

      res.json({
        bonus: myBonus || null,
        hasBonus: !!myBonus,
        isAvailable: myBonus?.status === 'available',
        isUsed: myBonus?.status === 'used'
      });
    } catch (error) {
      console.error('Erreur lecture bonus:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // GET /api/bonuses/choices - Obtenir les choix pour un nouveau éliminé
  // ==========================================
  app.get('/api/bonuses/choices', requireAuth, async (req, res) => {
    try {
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      const existingBonus = bonuses.find(b => normalizeId(b.athlete_id) === normalizeId(req.athleteId));

      // Si déjà un bonus, pas de choix
      if (existingBonus) {
        return res.json({
          hasChoice: false,
          reason: 'already_has_bonus',
          existing: existingBonus
        });
      }

      // Vérifier s'il y a des choix en attente (stockés dans pending_choices)
      const pendingChoices = await safeReadJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), {});
      const myPending = pendingChoices[normalizeId(req.athleteId)];

      if (myPending && myPending.choices) {
        return res.json({
          hasChoice: true,
          choices: myPending.choices,
          expiresAt: myPending.expires_at
        });
      }

      res.json({ hasChoice: false, reason: 'no_pending_choices' });
    } catch (error) {
      console.error('Erreur choices:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/bonuses/generate-choices - Générer les choix (admin/système)
  // ==========================================
  app.post('/api/bonuses/generate-choices', async (req, res) => {
    if (!checkAdmin(req, res)) return;

    try {
      const { athlete_id, elimination_round, is_best_of_two } = req.body;

      if (!athlete_id || !elimination_round) {
        return res.status(400).json({ error: 'athlete_id et elimination_round requis' });
      }

      // Seul le meilleur des 2 éliminés reçoit un bonus
      if (!is_best_of_two) {
        return res.json({
          success: false,
          reason: 'not_best_of_two',
          message: 'Seul le meilleur des 2 éliminés reçoit un bonus'
        });
      }

      // Tirer 2 bonus au sort
      const choices = drawRandomBonuses(BONUS_CHOICE_COUNT);

      // Sauvegarder les choix en attente
      const pendingChoices = await safeReadJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), {});
      pendingChoices[normalizeId(athlete_id)] = {
        choices,
        elimination_round,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 jours
      };
      await safeWriteJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), pendingChoices);

      console.log(`🎁 Choix de bonus générés pour ${athlete_id}: ${choices.join(', ')}`);
      res.json({ success: true, choices });
    } catch (error) {
      console.error('Erreur generate-choices:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/bonuses/assign - Choisir son bonus
  // ==========================================
  app.post('/api/bonuses/assign', requireAuth, async (req, res) => {
    try {
      const { bonus_id } = req.body;
      const athleteId = normalizeId(req.athleteId);

      if (!bonus_id) {
        return res.status(400).json({ error: 'bonus_id requis' });
      }

      // Vérifier que le bonus est valide
      if (!BONUS_IDS.includes(bonus_id)) {
        return res.status(400).json({ error: 'Bonus invalide' });
      }

      // Vérifier les choix en attente
      const pendingChoices = await safeReadJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), {});
      const myPending = pendingChoices[athleteId];

      if (!myPending || !myPending.choices.includes(bonus_id)) {
        return res.status(400).json({ error: 'Ce bonus ne fait pas partie de tes choix' });
      }

      // Vérifier qu'il n'a pas déjà un bonus
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      if (bonuses.find(b => normalizeId(b.athlete_id) === athleteId)) {
        return res.status(400).json({ error: 'Tu as déjà un bonus' });
      }

      // Récupérer le nom de l'athlète
      const athletes = await safeReadJSON(ATHLETES_FILE, []);
      const athlete = athletes.find(a => normalizeId(a.id) === athleteId);

      // Créer le bonus
      const newBonus = {
        id: `bonus-${athleteId}-${Date.now()}`,
        athlete_id: athleteId,
        athlete_name: athlete?.name || 'Inconnu',
        bonus_id: bonus_id,
        status: 'available', // available, used, expired
        elimination_round: myPending.elimination_round,
        assigned_at: new Date().toISOString(),
        used_at: null,
        used_in_round: null,
        target_athlete_id: null,
        target_athlete_name: null,
        effect_applied: false,
        effect_result: null
      };

      bonuses.push(newBonus);
      await safeWriteJSON(BONUSES_FILE, bonuses);

      // Supprimer les choix en attente
      delete pendingChoices[athleteId];
      await safeWriteJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), pendingChoices);

      console.log(`🎁 Bonus ${bonus_id} attribué à ${athlete?.name}`);
      res.json({ success: true, bonus: newBonus });
    } catch (error) {
      console.error('Erreur assign:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/bonuses/use - Utiliser son bonus
  // ==========================================
  app.post('/api/bonuses/use', requireAuth, async (req, res) => {
    try {
      const { target_athlete_id, round_number } = req.body;
      const athleteId = normalizeId(req.athleteId);

      // Récupérer le bonus du joueur
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      const bonusIndex = bonuses.findIndex(b => normalizeId(b.athlete_id) === athleteId);

      if (bonusIndex < 0) {
        return res.status(400).json({ error: 'Tu n\'as pas de bonus' });
      }

      const bonus = bonuses[bonusIndex];

      if (bonus.status !== 'available') {
        return res.status(400).json({ error: 'Ce bonus a déjà été utilisé' });
      }

      // Vérifier si une cible est nécessaire
      const requiresTarget = ['embuscade', 'ravitaillement', 'marquage'].includes(bonus.bonus_id);
      if (requiresTarget && !target_athlete_id) {
        return res.status(400).json({ error: 'Ce bonus nécessite une cible' });
      }

      // Récupérer le nom de la cible si applicable
      let targetName = null;
      if (target_athlete_id) {
        const athletes = await safeReadJSON(ATHLETES_FILE, []);
        const target = athletes.find(a => normalizeId(a.id) === normalizeId(target_athlete_id));
        targetName = target?.name || 'Inconnu';
      }

      // Mettre à jour le bonus
      bonuses[bonusIndex] = {
        ...bonus,
        status: 'used',
        used_at: new Date().toISOString(),
        used_in_round: round_number || null,
        target_athlete_id: target_athlete_id ? normalizeId(target_athlete_id) : null,
        target_athlete_name: targetName
      };

      await safeWriteJSON(BONUSES_FILE, bonuses);

      console.log(`🎁 Bonus ${bonus.bonus_id} utilisé par ${bonus.athlete_name}${targetName ? ` sur ${targetName}` : ''}`);

      res.json({
        success: true,
        bonus: bonuses[bonusIndex],
        effect: getEffectDescription(bonus.bonus_id, targetName)
      });
    } catch (error) {
      console.error('Erreur use:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // GET /api/bonuses/active - Bonus actifs (pour affichage)
  // ==========================================
  app.get('/api/bonuses/active', async (req, res) => {
    try {
      const bonuses = await safeReadJSON(BONUSES_FILE, []);

      // Filtrer les bonus utilisés qui ont un effet en cours
      const activeBonuses = bonuses.filter(b =>
        b.status === 'used' && !b.effect_applied
      );

      res.json(activeBonuses);
    } catch (error) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/bonuses/apply-effect - Appliquer l'effet d'un bonus (admin)
  // ==========================================
  app.post('/api/bonuses/apply-effect', async (req, res) => {
    if (!checkAdmin(req, res)) return;

    try {
      const { bonus_id, athlete_id, effect_result } = req.body;

      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      const bonusIndex = bonuses.findIndex(b =>
        b.id === bonus_id || (normalizeId(b.athlete_id) === normalizeId(athlete_id) && b.bonus_id === bonus_id)
      );

      if (bonusIndex < 0) {
        return res.status(404).json({ error: 'Bonus non trouvé' });
      }

      bonuses[bonusIndex].effect_applied = true;
      bonuses[bonusIndex].effect_result = effect_result;
      bonuses[bonusIndex].effect_applied_at = new Date().toISOString();

      await safeWriteJSON(BONUSES_FILE, bonuses);

      console.log(`🎁 Effet du bonus ${bonuses[bonusIndex].bonus_id} appliqué`);
      res.json({ success: true, bonus: bonuses[bonusIndex] });
    } catch (error) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/admin/bonuses/auto-apply/:roundNumber - Appliquer auto les bonus d'un round
  // ==========================================
  app.post('/api/admin/bonuses/auto-apply/:roundNumber', async (req, res) => {
    if (!checkAdmin(req, res)) return;

    try {
      const roundNumber = parseInt(req.params.roundNumber);
      const { activities, config } = req.body;

      if (!activities || !Array.isArray(activities)) {
        return res.status(400).json({ error: 'activities requises' });
      }

      const appliedBonuses = await applyBonusEffectsForRound(roundNumber, activities, config || {
        yearStartDate: '2026-02-02',
        roundDurationDays: 5
      });

      res.json({
        success: true,
        roundNumber,
        appliedCount: appliedBonuses.length,
        bonuses: appliedBonuses
      });
    } catch (error) {
      console.error('Erreur auto-apply bonuses:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // POST /api/admin/bonuses/reset - Reset tous les bonus (admin)
  // ==========================================
  app.post('/api/admin/bonuses/reset', async (req, res) => {
    if (!checkAdmin(req, res)) return;

    try {
      await safeWriteJSON(BONUSES_FILE, []);
      await safeWriteJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), {});

      console.log('🎁 Tous les bonus réinitialisés');
      res.json({ success: true, message: 'Tous les bonus ont été réinitialisés' });
    } catch (error) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ==========================================
  // GET /api/admin/bonuses - Voir tous les bonus (admin)
  // ==========================================
  app.get('/api/admin/bonuses', async (req, res) => {
    if (!checkAdmin(req, res)) return;

    try {
      const bonuses = await safeReadJSON(BONUSES_FILE, []);
      const pendingChoices = await safeReadJSON(path.join(DATA_DIR, 'pending_bonus_choices.json'), {});

      res.json({
        count: bonuses.length,
        bonuses,
        pendingChoices: Object.keys(pendingChoices).length,
        pending: pendingChoices
      });
    } catch (error) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  console.log('🎁 Routes bonus éphémères initialisées');
}

/**
 * Retourne une description de l'effet pour l'UI
 */
function getEffectDescription(bonusId, targetName) {
  const effects = {
    embuscade: `Une activité aléatoire de ${targetName || 'la cible'} sera volée à la fin du round`,
    ravitaillement: `Une de tes activités sera donnée à ${targetName || 'la cible'} à la fin du round`,
    duel: `Le duel avec ton co-éliminé est lancé jusqu'à la fin de la saison`,
    brouillard: `Tu es maintenant caché. Tu apparais dernier du classement des éliminés`,
    marquage: `${targetName || 'La cible'} est marqué(e). +1 point si éliminé(e) ce round`,
    trap: `Le piège est posé. Le prochain dernier éliminé te donnera du D+`,
    second_souffle: `Ta plus petite activité sera doublée à la fin de la saison`
  };
  return effects[bonusId] || 'Effet activé';
}

/**
 * Applique automatiquement les effets des bonus pour un round terminé
 * @param {number} roundNumber - Numéro du round
 * @param {Array} activities - Toutes les activités
 * @param {Object} config - Configuration du challenge (yearStartDate, roundDurationDays)
 * @returns {Array} Liste des bonus avec leurs effets appliqués
 */
async function applyBonusEffectsForRound(roundNumber, activities, config) {
  const bonuses = await safeReadJSON(BONUSES_FILE, []);
  const appliedBonuses = [];

  // Calculer les dates du round
  const yearStart = new Date(config.yearStartDate);
  const roundStart = new Date(yearStart);
  roundStart.setDate(roundStart.getDate() + (roundNumber - 1) * config.roundDurationDays);
  const roundEnd = new Date(roundStart);
  roundEnd.setDate(roundEnd.getDate() + config.roundDurationDays - 1);
  roundEnd.setHours(23, 59, 59, 999);

  // Filtrer les activités du round (sports valides, >20min)
  const validSports = ['Run', 'TrailRun', 'Ride', 'MountainBikeRide', 'GravelRide', 'Hike', 'Walk',
                       'BackcountrySki', 'NordicSki', 'AlpineSki', 'Snowshoe', 'RockClimbing'];

  const roundActivities = activities.filter(a => {
    const actDate = new Date(a.start_date);
    const isInRound = actDate >= roundStart && actDate <= roundEnd;
    const isValidSport = validSports.includes(a.sport_type) || validSports.includes(a.type);
    const isLongEnough = (a.moving_time || 0) >= 1200; // 20 minutes
    return isInRound && isValidSport && isLongEnough;
  });

  // Traiter chaque bonus utilisé ce round
  for (let i = 0; i < bonuses.length; i++) {
    const bonus = bonuses[i];

    // Seulement les bonus utilisés ce round et pas encore appliqués
    if (bonus.used_in_round !== roundNumber || bonus.effect_applied) continue;

    let effectResult = null;

    switch (bonus.bonus_id) {
      case 'embuscade': {
        // Vole une activité aléatoire de la cible
        const targetActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.target_athlete_id)
        );

        if (targetActivities.length > 0) {
          // Choisir une activité aléatoire
          const randomIndex = Math.floor(Math.random() * targetActivities.length);
          const stolenActivity = targetActivities[randomIndex];
          effectResult = {
            stolenElevation: Math.round(stolenActivity.total_elevation_gain || 0),
            stolenActivityId: stolenActivity.id,
            stolenActivityName: stolenActivity.name
          };
        } else {
          effectResult = {
            stolenElevation: 0,
            error: 'Aucune activité éligible trouvée'
          };
        }
        break;
      }

      case 'ravitaillement': {
        // Donne une activité aléatoire à un actif (bonus pour l'utilisateur)
        const userActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.athlete_id)
        );

        if (userActivities.length > 0) {
          // Prendre l'activité avec le plus de D+
          const bestActivity = userActivities.reduce((best, curr) =>
            (curr.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? curr : best
          );
          effectResult = {
            bonusElevation: Math.round(bestActivity.total_elevation_gain || 0),
            activityId: bestActivity.id,
            activityName: bestActivity.name
          };
        } else {
          effectResult = {
            bonusElevation: 0,
            error: 'Aucune activité trouvée'
          };
        }
        break;
      }

      case 'marquage': {
        // -20% du D+ de la cible ce round
        const targetActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.target_athlete_id)
        );
        const totalElevation = targetActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
        const penalty = Math.round(totalElevation * 0.20);
        effectResult = {
          penaltyPercentage: 20,
          totalElevation: Math.round(totalElevation),
          penaltyAmount: penalty
        };
        break;
      }

      case 'kamikaze': {
        // -25% du D+ pour l'utilisateur ET la cible
        const userActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.athlete_id)
        );
        const targetActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.target_athlete_id)
        );
        const userElevation = userActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
        const targetElevation = targetActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
        effectResult = {
          penaltyPercentage: 25,
          userPenalty: Math.round(userElevation * 0.25),
          targetPenalty: Math.round(targetElevation * 0.25)
        };
        break;
      }

      case 'trap': {
        // Piège déclenché - vole du D+ au dernier éliminé
        // Note: nécessite de connaître qui est éliminé - sera calculé au freeze
        effectResult = {
          trapSet: true,
          triggeredBy: null,
          stolenElevation: 0
        };
        break;
      }

      case 'malediction': {
        // Vole 10% du D+ de la cible à chaque fin de round
        const targetActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id) === normalizeId(bonus.target_athlete_id)
        );
        const totalElevation = targetActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
        const stolenAmount = Math.round(totalElevation * 0.10);
        effectResult = {
          stolenThisRound: stolenAmount,
          totalTargetElevation: Math.round(totalElevation)
        };
        break;
      }

      case 'duel':
      case 'brouillard':
      case 'second_souffle': {
        // Ces bonus ont des effets à long terme, pas de calcul immédiat
        effectResult = {
          active: true,
          appliedAt: new Date().toISOString()
        };
        break;
      }

      default:
        effectResult = { applied: true };
    }

    // Mettre à jour le bonus
    bonuses[i].effect_applied = true;
    bonuses[i].effect_result = effectResult;
    bonuses[i].effect_applied_at = new Date().toISOString();
    appliedBonuses.push(bonuses[i]);

    console.log(`🎁 Effet auto-appliqué: ${bonus.bonus_id} de ${bonus.athlete_name} → ${JSON.stringify(effectResult)}`);
  }

  // Sauvegarder
  if (appliedBonuses.length > 0) {
    await safeWriteJSON(BONUSES_FILE, bonuses);
    console.log(`🎁 ${appliedBonuses.length} effets de bonus appliqués pour le round ${roundNumber}`);
  }

  return appliedBonuses;
}

module.exports = { createBonusesRoutes, applyBonusEffectsForRound };