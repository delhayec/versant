/**
 * ============================================
 * VERSANT - GESTION DES RÉSULTATS FIGÉS
 * ============================================
 *
 * Ce module stocke les résultats de chaque round de façon DÉFINITIVE.
 * Une fois un round terminé, ses résultats ne changent JAMAIS.
 *
 * IMPORTANT: Deux modes de fonctionnement:
 * 1. freezeRoundResults() - Recalcule les résultats (ancienne méthode)
 * 2. freezeRoundWithData() - Accepte les données pré-calculées du frontend (RECOMMANDÉ)
 *
 * Le mode 2 est recommandé car il garantit que les résultats figés correspondent
 * exactement à ce qui est affiché sur la page principale (avec jokers, etc.)
 */

const fs = require('fs').promises;
const path = require('path');

// Import configuration partagée (source unique de vérité)
const {
  VALID_SPORTS, isValidSport,
  MAIN_CHALLENGE_POINTS, ELIMINATED_CHALLENGE_POINTS,
  getMainPoints, getEliminatedPoints,
  BONUS_IDS,
  getRoundDates, getSeasonNumber, getRoundInSeason
} = require('./shared-config');

// Import de la fonction d'application des bonus
let applyBonusEffectsForRound = null;
try {
  const bonusesRoutes = require('./bonuses-routes.js');
  applyBonusEffectsForRound = bonusesRoutes.applyBonusEffectsForRound;
} catch (e) {
  console.warn('⚠️ Impossible de charger bonuses-routes pour auto-apply');
}

// Import du moteur de challenge éliminés (CommonJS)
const elimChallenge = require('./elim-challenge');

// Configuration
const DATA_DIR = path.join(__dirname, 'data');
const FROZEN_FILE = path.join(DATA_DIR, 'frozen_results.json');
const BONUSES_FILE = path.join(DATA_DIR, 'bonuses.json');
const SPECIAL_RULES_FILE = path.join(DATA_DIR, 'special_rules.json');

// Définition des règles spéciales (miroir de config.js frontend)
const ROUND_RULES_BACKEND = {
  handicap: {
    id: 'handicap',
    parameters: {
      malusPerPosition: { 1: 50, 2: 40, 3: 35, 4: 30, 5: 25, 6: 20, 7: 15, 8: 10, 9: 7, 10: 5 },
      bonusLastCount: 5,
      bonusLastPercent: 10,
      eliminationsOverride: 4
    }
  }
};

/**
 * Charge les overrides de règles spéciales depuis le fichier JSON
 */
async function loadSpecialRules() {
  try {
    const data = await fs.readFile(SPECIAL_RULES_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Retourne la règle spéciale et ses paramètres pour un round donné
 */
async function getSpecialRuleForRound(roundNumber) {
  const rules = await loadSpecialRules();
  const ruleId = rules[String(roundNumber)];
  if (!ruleId || ruleId === 'standard') return null;
  return { id: ruleId, ...(ROUND_RULES_BACKEND[ruleId] || {}) };
}

// ============================================
// UTILITAIRES DE FICHIER
// ============================================

async function loadFrozenResults() {
  try {
    const data = await fs.readFile(FROZEN_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { version: "1.0", rounds: {}, lastUpdated: null };
  }
}

async function saveFrozenResults(data) {
  data.lastUpdated = new Date().toISOString();
  await fs.writeFile(FROZEN_FILE, JSON.stringify(data, null, 2));
}

// ============================================
// ENRICHISSEMENT: bonusesUsed, jokersUsed, rescapeInfo
// ============================================

/**
 * Charge les bonus utilisés dans un round donné depuis bonuses.json.
 * Retourne une copie filtrée (status === 'used' && used_in_round === roundNumber).
 */
async function loadBonusesUsedInRound(roundNumber) {
  try {
    const raw = await fs.readFile(BONUSES_FILE, 'utf8');
    const all = JSON.parse(raw);
    if (!Array.isArray(all)) return [];
    return all
      .filter(b => b && b.status === 'used' && Number(b.used_in_round) === Number(roundNumber))
      // Clone chaque bonus pour ne pas partager la référence avec le fichier sur disque
      .map(b => JSON.parse(JSON.stringify(b)));
  } catch {
    return [];
  }
}

/**
 * Charge les jokers actifs (status === 'active') d'un round donné depuis jokers_usage.json.
 * Retourne une liste normalisée en camelCase (athleteId, jokerId, ...) avec `status` et `effect_result`.
 */
async function loadJokersUsedInRound(roundNumber) {
  const JOKERS_FILE = path.join(DATA_DIR, 'jokers_usage.json');
  try {
    const raw = await fs.readFile(JOKERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const usage = Array.isArray(data) ? data : (data && Array.isArray(data.usage) ? data.usage : []);
    return usage
      .filter(j => j && Number(j.round_number) === Number(roundNumber) && j.status === 'active')
      .map(j => ({
        athleteId: j.athlete_id != null ? String(j.athlete_id) : null,
        athleteName: j.athlete_name || null,
        jokerId: j.joker_id || null,
        targetId: j.target_athlete_id != null ? String(j.target_athlete_id) : null,
        targetName: j.target_athlete_name || null,
        status: j.status || 'active',
        effect_result: j.effect_result || null
      }));
  } catch {
    return [];
  }
}

/**
 * Enrichit un tableau jokersUsed existant (ex: venant du frontend) avec `status` et
 * `effect_result` lus depuis jokers_usage.json. Ne casse rien si le fichier est absent.
 */
async function enrichJokersUsed(jokersUsed, roundNumber) {
  if (!Array.isArray(jokersUsed) || jokersUsed.length === 0) return jokersUsed || [];

  let diskUsage = [];
  try {
    const JOKERS_FILE = path.join(DATA_DIR, 'jokers_usage.json');
    const raw = await fs.readFile(JOKERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    diskUsage = Array.isArray(data) ? data : (data && Array.isArray(data.usage) ? data.usage : []);
  } catch {
    // Pas de fichier : on retourne tel quel avec des défauts sûrs
  }

  return jokersUsed.map(j => {
    // Chercher l'entrée correspondante sur disque
    const match = diskUsage.find(d =>
      Number(d.round_number) === Number(roundNumber) &&
      String(d.athlete_id) === String(j.athleteId || j.athlete_id) &&
      d.joker_id === (j.jokerId || j.joker_id)
    );
    return {
      athleteId: j.athleteId != null ? String(j.athleteId) : (j.athlete_id != null ? String(j.athlete_id) : null),
      athleteName: j.athleteName || j.athlete_name || null,
      jokerId: j.jokerId || j.joker_id || null,
      targetId: j.targetId != null ? String(j.targetId) : (j.target_athlete_id != null ? String(j.target_athlete_id) : null),
      targetName: j.targetName || j.target_athlete_name || null,
      status: j.status || match?.status || 'active',
      effect_result: j.effect_result || match?.effect_result || null
    };
  });
}

/**
 * Calcule rescapeInfo pour un round : dernier survivant = dernier non-éliminé.
 * Ne s'applique PAS en finale de saison (tous éliminés sauf le gagnant).
 * `consecutive` est calculé en regardant les rounds précédents de la saison.
 *
 * @param {Object} roundData - Doit contenir ranking, eliminations, seasonNumber, roundInSeason
 * @param {Object} allRounds - Map roundKey -> roundData (pour consulter les rounds précédents)
 * @param {number} roundNumber - Numéro global du round
 * @param {number} totalParticipants - Nombre total de participants de l'année
 * @param {number} eliminationsPerRound - Config.eliminationsPerRound
 * @returns {Object|null} rescapeInfo ou null si pas applicable
 */
function computeRescapeInfo(roundData, allRounds, roundNumber, totalParticipants, eliminationsPerRound) {
  if (!roundData || !Array.isArray(roundData.ranking) || !Array.isArray(roundData.eliminations)) {
    return null;
  }

  const roundsPerSeason = Math.ceil((totalParticipants - 1) / eliminationsPerRound);
  const seasonNumber = roundData.seasonNumber || Math.ceil(roundNumber / roundsPerSeason);
  const roundInSeason = roundData.roundInSeason || (((roundNumber - 1) % roundsPerSeason) + 1);
  const isFinale = roundInSeason === roundsPerSeason;

  if (isFinale) return null;

  // Dernier survivant = dernier du ranking parmi les non-éliminés
  // Règle : un joueur ayant utilisé un bouclier ce round est exclu de l'attribution
  // du rescapé (il a déjà bénéficié d'une protection forte ; cumuler bouclier +
  // bonus rescapé serait trop avantageux).
  const eliminatedIds = new Set(roundData.eliminations.map(e => String(e.id)));
  const survivors = roundData.ranking.filter(r =>
    !eliminatedIds.has(String(r.id)) && !r.hasShield
  );
  if (survivors.length === 0) return null;

  // Les rankings sont déjà triés par position (1 = meilleur). Le dernier survivant = dernier du tableau.
  // On s'appuie sur `position` si elle est présente, sinon sur l'ordre.
  const sortedSurvivors = [...survivors].sort((a, b) => (a.position || 0) - (b.position || 0));
  const rescape = sortedSurvivors[sortedSurvivors.length - 1];
  if (!rescape) return null;

  // Compter les rescapés consécutifs dans la saison courante
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  let consecutive = 1;
  for (let prevR = roundNumber - 1; prevR >= seasonStartRound; prevR--) {
    const prev = allRounds[String(prevR)];
    if (prev && prev.rescapeInfo && String(prev.rescapeInfo.athleteId) === String(rescape.id)) {
      consecutive++;
    } else {
      break;
    }
  }

  return {
    athleteId: String(rescape.id),
    athleteName: rescape.name,
    consecutive,
    points: consecutive >= 2 ? 2 : 0
  };
}

// ============================================
// NOUVELLE MÉTHODE: FREEZE AVEC DONNÉES PRÉ-CALCULÉES
// ============================================

/**
 * Fige un round avec des données pré-calculées provenant du frontend
 * Cette méthode ne recalcule RIEN - elle sauvegarde exactement les données reçues
 *
 * @param {number} roundNumber - Numéro du round
 * @param {Object} roundData - Données du round calculées par le frontend
 * @param {Object} options - Options (force: true pour remplacer un round existant)
 * @returns {Object} Les données sauvegardées
 */
async function freezeRoundWithData(roundNumber, roundData, options = {}) {
  const data = await loadFrozenResults();
  const roundKey = String(roundNumber);

  // Vérifier si déjà figé (sauf si force=true)
  if (data.rounds[roundKey]?.frozen && !options.force) {
    console.log(`⚠️ Round ${roundNumber} déjà figé. Utilisez force=true pour remplacer.`);
    return { success: false, error: 'already_frozen', existing: data.rounds[roundKey] };
  }

  // Valider les données minimales requises
  if (!roundData.ranking || !Array.isArray(roundData.ranking)) {
    return { success: false, error: 'missing_ranking' };
  }
  if (!roundData.eliminations || !Array.isArray(roundData.eliminations)) {
    return { success: false, error: 'missing_eliminations' };
  }

  // Charger la règle spéciale pour ce round (pour traçabilité)
  const specialRule = await getSpecialRuleForRound(roundNumber);

  // Construire l'objet de résultat
  const frozenRound = {
    roundNumber: roundNumber,
    seasonNumber: roundData.seasonNumber || 1,
    roundInSeason: roundData.roundInSeason || roundNumber,
    dates: roundData.dates || {
      start: new Date().toISOString(),
      end: new Date().toISOString()
    },
    frozen: true,
    frozenAt: new Date().toISOString(),
    frozenMethod: 'frontend_data', // Indique que les données viennent du frontend
    specialRule: specialRule?.id || roundData.specialRule || null, // Règle spéciale appliquée
    activeParticipants: roundData.activeParticipants || roundData.ranking.map(r => String(r.id)),
    ranking: roundData.ranking.map(entry => ({
      id: String(entry.id),
      name: entry.name,
      elevation: entry.elevation || entry.totalElevation || 0,
      activitiesCount: entry.activitiesCount || 0,
      originalElevation: entry.originalElevation || entry.elevation || 0,
      position: entry.position,
      mainPoints: entry.mainPoints || 0,
      bonusPoints: entry.bonusPoints || 0,
      eliminatedPosition: entry.eliminatedPosition,
      hasShield: entry.hasShield || entry.jokerEffects?.hasShield || false,
      jokerEffects: entry.jokerEffects || null
    })),
    eliminations: roundData.eliminations.map(elim => ({
      id: String(elim.id),
      name: elim.name,
      elevation: elim.elevation || elim.totalElevation || 0,
      reason: elim.reason || (elim.elevation === 0 ? 'zero_elevation' : 'last_position'),
      position: elim.position,
      zeroElimination: elim.zeroElimination || elim.elevation === 0
    })),
    jokersUsed: roundData.jokersUsed || [],
    bonusesUsed: [],
    rescapeInfo: null,
    stats: roundData.stats || {
      totalActivities: roundData.ranking.reduce((sum, r) => sum + (r.activitiesCount || 0), 0),
      totalElevation: roundData.ranking.reduce((sum, r) => sum + (r.elevation || 0), 0),
      eliminationsCount: roundData.eliminations.length
    }
  };

  // Enrichissement jokersUsed: ajouter status + effect_result quand disponibles
  frozenRound.jokersUsed = await enrichJokersUsed(frozenRound.jokersUsed, roundNumber);

  // Enrichissement bonusesUsed: lire depuis bonuses.json (snapshot initial, re-snapshot après auto-apply)
  frozenRound.bonusesUsed = await loadBonusesUsedInRound(roundNumber);

  // Enrichissement rescapeInfo: dernier survivant + nombre de fois consécutives
  // Utilise les rounds DÉJÀ figés pour compter les consécutifs
  const totalParticipantsForRescape =
    roundData.totalParticipants ||
    (frozenRound.activeParticipants?.length || 0) + (frozenRound.eliminations?.length || 0);
  // Fallback: si on n'a pas le total, on utilise activeParticipants + éliminations de tous les rounds passés
  let totalParticipants = totalParticipantsForRescape;
  if (!totalParticipants || totalParticipants < 2) {
    // Essayer de récupérer depuis le 1er round figé
    const firstRound = data.rounds[String(1)] || data.rounds[String(2)];
    if (firstRound && Array.isArray(firstRound.activeParticipants)) {
      totalParticipants = firstRound.activeParticipants.length;
    }
  }
  if (totalParticipants && totalParticipants >= 2) {
    frozenRound.rescapeInfo = computeRescapeInfo(
      frozenRound,
      data.rounds,
      roundNumber,
      totalParticipants,
      2 // eliminationsPerRound par défaut (aligné avec shared-config.CHALLENGE_CONFIG)
    );
  }

  // Sauvegarder
  data.rounds[roundKey] = frozenRound;
  await saveFrozenResults(data);

  console.log(`❄️ Round ${roundNumber} figé (via frontend): ${frozenRound.eliminations.length} éliminé(s)`);

  // Appliquer automatiquement les effets des bonus si la fonction est disponible
  let appliedBonuses = [];
  if (applyBonusEffectsForRound && roundData.activities) {
    try {
      appliedBonuses = await applyBonusEffectsForRound(roundNumber, roundData.activities, {
        yearStartDate: roundData.dates?.start || new Date().toISOString(),
        roundDurationDays: 5
      });
      // Re-snapshot des bonus utilisés après application (effect_result peut avoir été ajouté)
      const refreshedBonuses = await loadBonusesUsedInRound(roundNumber);
      if (refreshedBonuses.length > 0) {
        frozenRound.bonusesUsed = refreshedBonuses;
        data.rounds[roundKey] = frozenRound;
        await saveFrozenResults(data);
      }
    } catch (e) {
      console.warn(`⚠️ Erreur application auto bonus round ${roundNumber}:`, e.message);
    }
  }

  // Générer automatiquement les choix de bonus pour le meilleur éliminé
  let bonusChoiceGenerated = null;
  if (frozenRound.eliminations && frozenRound.eliminations.length >= 2) {
    try {
      bonusChoiceGenerated = await generateBonusChoiceForBestEliminated(frozenRound.eliminations, roundNumber);
    } catch (e) {
      console.warn(`⚠️ Erreur génération choix bonus round ${roundNumber}:`, e.message);
    }
  }

  // Phase 2 : si on vient de figer la FINALE d'une saison, figer automatiquement
  // le classement final du challenge des éliminés pour cette saison.
  // Détection : il ne reste qu'1 athlète actif après les éliminations de ce round.
  // (le nombre de rounds par saison varie selon les éliminations cumulées —
  //  règles spéciales handicap, multi-éliminations pour inactivité, etc.)
  let eliminatedChallengeFrozen = null;
  try {
    const activeAtStart = frozenRound.activeParticipants?.length || 0;
    const eliminatedThisRound = frozenRound.eliminations?.length || 0;
    const survivors = activeAtStart - eliminatedThisRound;

    if (activeAtStart > 0 && survivors <= 1) {
      eliminatedChallengeFrozen = await freezeEliminatedChallengeForSeason(
        frozenRound.seasonNumber,
        { force: options.force === true }
      );
      if (eliminatedChallengeFrozen?.success) {
        console.log(
          `🏔️ Auto-freeze challenge éliminés saison ${frozenRound.seasonNumber} ` +
          `(${eliminatedChallengeFrozen.ranking.length} athlètes)`
        );
      }
    }
  } catch (e) {
    console.warn(`⚠️ Erreur auto-freeze challenge éliminés saison ${frozenRound.seasonNumber}:`, e.message);
  }

  return {
    success: true,
    round: frozenRound,
    method: 'frontend_data',
    appliedBonuses: appliedBonuses.length,
    bonusChoiceGenerated,
    eliminatedChallengeFrozen
  };
}

/**
 * Génère un choix de bonus pour le meilleur des 2 éliminés
 */
async function generateBonusChoiceForBestEliminated(eliminations, roundNumber) {
  if (!eliminations || eliminations.length < 2) return null;

  // Trier par D+ décroissant pour trouver le meilleur
  const sorted = [...eliminations].sort((a, b) => (b.elevation || 0) - (a.elevation || 0));
  const bestEliminated = sorted[0];

  // Ne pas donner de bonus si le meilleur a 0 D+
  if (!bestEliminated.elevation || bestEliminated.elevation === 0) {
    console.log(`🎁 Pas de bonus pour round ${roundNumber}: meilleur éliminé à 0 D+`);
    return null;
  }

  // Charger les choix en attente
  const pendingFile = path.join(DATA_DIR, 'pending_bonus_choices.json');
  let pendingChoices = {};
  try {
    const content = await fs.readFile(pendingFile, 'utf8');
    pendingChoices = JSON.parse(content);
  } catch (e) {
    // Fichier n'existe pas encore
  }

  // Vérifier si déjà généré pour ce joueur
  const playerId = String(bestEliminated.id);
  if (pendingChoices[playerId]) {
    console.log(`🎁 Choix bonus déjà existant pour ${bestEliminated.name}`);
    return null;
  }

  // Tirer 2 bonus au hasard (utilise BONUS_IDS importé de shared-config)
  const shuffled = [...BONUS_IDS].sort(() => Math.random() - 0.5);
  const choices = shuffled.slice(0, 2);

  // Ajouter le choix
  pendingChoices[playerId] = {
    choices,
    elimination_round: roundNumber,
    athlete_name: bestEliminated.name,
    created_at: new Date().toISOString(),
    expires_at: `${new Date().getFullYear()}-12-31T23:59:59.999Z`
  };

  // Sauvegarder
  await fs.writeFile(pendingFile, JSON.stringify(pendingChoices, null, 2));

  console.log(`🎁 Choix bonus généré pour ${bestEliminated.name} (round ${roundNumber}): ${choices.join(', ')}`);

  return {
    athleteId: playerId,
    athleteName: bestEliminated.name,
    choices,
    eliminationRound: roundNumber
  };
}

/**
 * Importe plusieurs rounds depuis un fichier JSON complet
 * Utile pour restaurer ou corriger les données
 *
 * @param {Object} importData - Données à importer (format frozen_results.json)
 * @param {Object} options - Options (merge: true pour fusionner, false pour remplacer)
 */
async function importFrozenResults(importData, options = { merge: true }) {
  const currentData = await loadFrozenResults();

  if (!importData.rounds) {
    return { success: false, error: 'invalid_format' };
  }

  let imported = 0;
  let skipped = 0;

  for (const [roundKey, roundData] of Object.entries(importData.rounds)) {
    // En mode merge, ne pas remplacer les rounds existants
    if (options.merge && currentData.rounds[roundKey]?.frozen) {
      skipped++;
      continue;
    }

    // Ajouter les métadonnées d'import
    roundData.importedAt = new Date().toISOString();
    roundData.frozen = true;

    currentData.rounds[roundKey] = roundData;
    imported++;
  }

  await saveFrozenResults(currentData);

  console.log(`📥 Import: ${imported} round(s) importé(s), ${skipped} ignoré(s)`);

  return {
    success: true,
    imported,
    skipped,
    totalRounds: Object.keys(currentData.rounds).length
  };
}

// ============================================
// ANCIENNE MÉTHODE: CALCUL DES RÉSULTATS
// ============================================

/**
 * Calcule et fige les résultats d'un round terminé
 * ATTENTION: Cette méthode recalcule tout - préférer freezeRoundWithData()
 */
async function calculateRoundResults(roundNumber, activities, athletes, jokerUsage, config, previousRounds) {
  const roundDates = getRoundDates(roundNumber, config);
  const totalParticipants = athletes.length;
  const seasonNumber = getSeasonNumber(roundNumber, totalParticipants, config.eliminationsPerRound);
  const roundInSeason = getRoundInSeason(roundNumber, totalParticipants, config.eliminationsPerRound);
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / config.eliminationsPerRound);
  const isFinale = roundInSeason === roundsPerSeason;

  // Déterminer les participants actifs (non éliminés dans les rounds précédents de cette saison)
  let activeParticipants = athletes.map(a => String(a.id));

  // Trouver les éliminés des rounds précédents de CETTE saison
  const seasonStartRound = (seasonNumber - 1) * roundsPerSeason + 1;
  for (let r = seasonStartRound; r < roundNumber; r++) {
    const prevRound = previousRounds[String(r)];
    if (prevRound?.eliminations) {
      const eliminatedIds = prevRound.eliminations.map(e => String(e.id));
      activeParticipants = activeParticipants.filter(id => !eliminatedIds.includes(id));
    }
  }

  // Filtrer les activités du round (date ET type de sport valide)
  const roundStart = roundDates.start.getTime();
  const roundEnd = roundDates.end.getTime();

  const roundActivities = activities.filter(a => {
    // Utiliser l'heure de FIN de l'activité (start + elapsed_time)
    // pour rattacher l'activité au round où elle se termine
    const start = new Date(a.start_date).getTime();
    const elapsedMs = (a.elapsed_time || 0) * 1000;
    const actEndDate = start + elapsedMs;
    if (actEndDate < roundStart || actEndDate > roundEnd) return false;

    // Ignorer les activités exclues par l'admin
    if (a.excluded) return false;

    // Vérifier le type de sport (AlpineSki, Snowboard, etc. sont exclus)
    const sportType = a.sport_type || a.type;
    if (!isValidSport(sportType)) return false;

    return true;
  });

  // Calculer le D+ de chaque participant actif
  const ranking = activeParticipants.map(participantId => {
    const pActivities = roundActivities.filter(a => {
      const athleteId = String(a.athlete?.id || a.athlete_id);
      return athleteId === participantId;
    });

    const elevation = pActivities.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    const athlete = athletes.find(a => String(a.id) === participantId);

    return {
      id: participantId,
      name: athlete?.name || `Athlète ${participantId}`,
      elevation: Math.round(elevation),
      activitiesCount: pActivities.length,
      originalElevation: Math.round(elevation),
      bonusPoints: 0
    };
  });

  // Appliquer les effets des jokers actifs ce round
  const activeJokers = jokerUsage.filter(j =>
    j.round_number === roundNumber && j.status === 'active'
  );

  applyJokerEffects(ranking, activeJokers, roundActivities, athletes);

  // Appliquer les effets des bonus éphémères (ravitaillement, embuscade, etc.)
  await applyEphemeralBonusEffects(ranking, roundNumber, roundActivities);

  // Vérifier si ce round a une règle spéciale
  const specialRule = await getSpecialRuleForRound(roundNumber);

  // Appliquer le handicap si actif (malus/bonus sur le D+)
  if (specialRule?.id === 'handicap' && specialRule.parameters) {
    const { malusPerPosition, bonusLastCount, bonusLastPercent } = specialRule.parameters;

    // Calculer le classement général pour déterminer les rangs
    // On utilise les rounds précédents figés pour construire un classement partiel
    const generalStandings = {};
    athletes.forEach(a => { generalStandings[String(a.id)] = { points: 0 }; });
    Object.values(previousRounds).forEach(r => {
      if (!r.frozen || !r.ranking) return;
      r.ranking.forEach(e => {
        if (generalStandings[e.id]) {
          generalStandings[e.id].points += (e.mainPoints || 0);
        }
      });
    });

    // Trier pour obtenir les rangs
    const sortedGeneral = Object.entries(generalStandings)
      .sort((a, b) => b[1].points - a[1].points);
    const generalRankMap = {};
    sortedGeneral.forEach(([id], idx) => { generalRankMap[id] = idx + 1; });
    const totalInGeneral = sortedGeneral.length;

    ranking.forEach(entry => {
      const rank = generalRankMap[entry.id];
      if (!rank) return;

      entry.rawElevation = entry.elevation;
      let adjustPercent = 0;

      if (malusPerPosition[rank]) {
        adjustPercent = -malusPerPosition[rank];
      } else if (totalInGeneral - rank < bonusLastCount) {
        adjustPercent = bonusLastPercent;
      }

      if (adjustPercent !== 0) {
        entry.elevation = Math.round(entry.elevation * (1 + adjustPercent / 100));
        entry.handicapAdjustment = adjustPercent;
        entry.generalRank = rank;
      }
    });

    console.log(`⚖️ Round ${roundNumber}: Handicap appliqué (${Object.keys(malusPerPosition).length} malus, ${bonusLastCount} bonus)`);
  }

  // Trier par D+ décroissant (après handicap)
  ranking.sort((a, b) => b.elevation - a.elevation);

  // Attribuer les positions
  ranking.forEach((entry, index) => {
    entry.position = index + 1;
  });

  // ============================================
  // RÈGLES D'ÉLIMINATION
  // ============================================
  // Prend en compte l'override d'éliminations des règles spéciales (ex: handicap → 4)

  const eliminations = [];

  // Nombre d'éliminations (peut être overridé par la règle spéciale)
  const eliminationsForThisRound = specialRule?.parameters?.eliminationsOverride || config.eliminationsPerRound;

  // Joueurs éligibles (sans bouclier)
  const eligibleForElimination = ranking.filter(e => !e.hasShield);

  // Joueurs à 0 D+ (éligibles uniquement)
  const zeroElevationPlayers = eligibleForElimination.filter(e => e.elevation === 0);

  // Déterminer qui éliminer
  let toEliminate = [];

  // Appliquer les nouvelles règles seulement à partir du R7
  const useNewRules = roundNumber >= 7;

  if (isFinale) {
    // FINALE: éliminer tous sauf 1
    toEliminate = eligibleForElimination.slice(1); // Garder seulement le premier
  } else if (useNewRules && zeroElevationPlayers.length >= 2 && zeroElevationPlayers.length >= eliminationsForThisRound) {
    // Si le nombre de joueurs à 0 D+ dépasse le nombre d'éliminations prévues → tous éliminés
    toEliminate = zeroElevationPlayers;
    console.log(`📋 Round ${roundNumber}: ${zeroElevationPlayers.length} joueurs à 0 D+ (≥${eliminationsForThisRound}) → tous éliminés`);
  } else {
    // RÈGLE NORMALE: éliminer les N derniers (2 par défaut, 4 pour handicap)
    toEliminate = eligibleForElimination.slice(-eliminationsForThisRound);
  }

  // Trier par position (du pire au meilleur) pour l'attribution des points
  // Le dernier du classement doit être en premier dans eliminations
  toEliminate.sort((a, b) => b.position - a.position);

  toEliminate.forEach(entry => {
    eliminations.push({
      id: entry.id,
      name: entry.name,
      elevation: entry.elevation,
      reason: entry.elevation === 0 ? 'zero_elevation' : 'last_position',
      position: entry.position
    });
  });

  // Calculer les points pour chaque participant
  const activeAtRoundStart = activeParticipants.length;

  ranking.forEach(entry => {
    const eliminationEntry = eliminations.find(e => e.id === entry.id);

    if (eliminationEntry) {
      // indexInElims: 0 = dernier, 1 = avant-dernier, etc.
      const indexInElims = eliminations.findIndex(e => e.id === entry.id);
      // Position: dernier = activeAtRoundStart, avant-dernier = activeAtRoundStart - 1
      // Exemple avec 11 actifs: dernier → 11 (2 pts), avant-dernier → 10 (4 pts)
      const position = activeAtRoundStart - indexInElims;
      entry.mainPoints = getMainPoints(Math.max(1, Math.min(position, totalParticipants)));
      entry.eliminatedPosition = position;
    } else if (isFinale && ranking.filter(e => !eliminations.some(el => el.id === e.id)).length === 1) {
      entry.mainPoints = getMainPoints(1);
      entry.isWinner = true;
    } else {
      entry.mainPoints = 0;
    }
  });

  const jokersUsedEnriched = activeJokers.map(j => ({
    athleteId: j.athlete_id != null ? String(j.athlete_id) : null,
    athleteName: j.athlete_name,
    jokerId: j.joker_id,
    targetId: j.target_athlete_id != null ? String(j.target_athlete_id) : null,
    targetName: j.target_athlete_name,
    status: j.status || 'active',
    effect_result: j.effect_result || null
  }));

  const bonusesUsed = await loadBonusesUsedInRound(roundNumber);

  const result = {
    roundNumber,
    seasonNumber,
    roundInSeason,
    dates: {
      start: roundDates.start.toISOString(),
      end: roundDates.end.toISOString()
    },
    frozen: true,
    frozenAt: new Date().toISOString(),
    frozenMethod: 'calculated', // Indique que c'est recalculé
    specialRule: specialRule?.id || null, // Règle spéciale appliquée
    activeParticipants,
    ranking,
    eliminations,
    jokersUsed: jokersUsedEnriched,
    bonusesUsed,
    rescapeInfo: null,
    stats: {
      totalActivities: roundActivities.length,
      totalElevation: ranking.reduce((sum, e) => sum + e.elevation, 0),
      eliminationsCount: eliminations.length
    }
  };

  // Calculer rescapeInfo à partir du résultat construit
  const totalParticipants2 = athletes.length;
  if (totalParticipants2 >= 2) {
    result.rescapeInfo = computeRescapeInfo(
      result,
      previousRounds,
      roundNumber,
      totalParticipants2,
      config.eliminationsPerRound || 2
    );
  }

  return result;
}

/**
 * Applique les effets des bonus éphémères sur le classement
 * Doit être appelé AVANT le tri et le calcul des éliminations.
 *
 * Bonus qui affectent les joueurs actifs :
 * - ravitaillement : la meilleure activité du possesseur est donnée à la cible (D+ ajouté)
 * - embuscade : une activité aléatoire est volée à la cible (D+ retiré)
 */
async function applyEphemeralBonusEffects(ranking, roundNumber, roundActivities) {
  let bonuses = [];
  try {
    const raw = await fs.readFile(BONUSES_FILE, 'utf8');
    bonuses = JSON.parse(raw);
  } catch (e) {
    // Pas de fichier bonus ou erreur de lecture → rien à appliquer
    return;
  }

  if (!Array.isArray(bonuses) || bonuses.length === 0) return;

  const normalizeId = (id) => id === null || id === undefined ? null : String(id).trim();

  for (let i = 0; i < bonuses.length; i++) {
    const bonus = bonuses[i];

    // Seulement les bonus utilisés ce round
    if (bonus.used_in_round !== roundNumber) continue;

    switch (bonus.bonus_id) {
      case 'ravitaillement': {
        // La meilleure activité du possesseur est donnée à la cible
        const ownerActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id || a.athlete?.id) === normalizeId(bonus.athlete_id)
        );

        if (ownerActivities.length > 0) {
          const bestActivity = ownerActivities.reduce((best, curr) =>
            (curr.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? curr : best
          );
          const amount = Math.round(bestActivity.total_elevation_gain || 0);

          const target = ranking.find(e => e.id === normalizeId(bonus.target_athlete_id));
          if (target && amount > 0) {
            target.elevation += amount;
            target.ravitaillementReceived = { from: bonus.athlete_name, amount, activity: bestActivity.name };
            console.log(`🎁 Ravitaillement: +${amount} m pour ${target.name} (de ${bonus.athlete_name})`);
          }

          // Mettre à jour le résultat de l'effet dans bonuses.json
          bonuses[i].effect_applied = true;
          bonuses[i].effect_result = {
            bonusElevation: amount,
            activityId: bestActivity.id,
            activityName: bestActivity.name
          };
          bonuses[i].effect_applied_at = new Date().toISOString();
        } else {
          bonuses[i].effect_applied = true;
          bonuses[i].effect_result = { bonusElevation: 0, error: 'Aucune activité trouvée' };
          bonuses[i].effect_applied_at = new Date().toISOString();
        }
        break;
      }

      case 'embuscade': {
        // Une activité aléatoire est volée à la cible
        const targetActivities = roundActivities.filter(a =>
          normalizeId(a.athlete_id || a.athlete?.id) === normalizeId(bonus.target_athlete_id)
        );

        if (targetActivities.length > 0) {
          const randomIndex = Math.floor(Math.random() * targetActivities.length);
          const stolenActivity = targetActivities[randomIndex];
          const amount = Math.round(stolenActivity.total_elevation_gain || 0);

          const target = ranking.find(e => e.id === normalizeId(bonus.target_athlete_id));
          if (target && amount > 0) {
            target.elevation = Math.max(0, target.elevation - amount);
            target.embuscadeReceived = { by: bonus.athlete_name, amount, activity: stolenActivity.name };
            console.log(`🏹 Embuscade: -${amount} m pour ${target.name} (par ${bonus.athlete_name})`);
          }

          bonuses[i].effect_applied = true;
          bonuses[i].effect_result = {
            stolenElevation: amount,
            stolenActivityId: stolenActivity.id,
            stolenActivityName: stolenActivity.name
          };
          bonuses[i].effect_applied_at = new Date().toISOString();
        } else {
          bonuses[i].effect_applied = true;
          bonuses[i].effect_result = { stolenElevation: 0, error: 'Aucune activité éligible trouvée' };
          bonuses[i].effect_applied_at = new Date().toISOString();
        }
        break;
      }

      default:
        // Les autres bonus (marquage, malediction, kamikaze, etc.) n'affectent pas
        // les joueurs actifs dans le challenge principal
        break;
    }
  }

  // Sauvegarder les résultats d'effets dans bonuses.json
  try {
    await fs.writeFile(BONUSES_FILE, JSON.stringify(bonuses, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠️ Impossible de sauvegarder bonuses.json après application:', e.message);
  }
}

/**
 * Applique les effets des jokers sur le classement
 */
function applyJokerEffects(ranking, activeJokers, activities, athletes) {
  // Sabotages (-30%)
  activeJokers.filter(j => j.joker_id === 'sabotage').forEach(joker => {
    const target = ranking.find(e => e.id === String(joker.target_athlete_id));
    if (target) {
      const penalty = Math.round(target.originalElevation * 0.3);
      target.elevation = Math.max(0, target.elevation - penalty);
      target.sabotageReceived = { by: joker.athlete_name, amount: penalty };
    }
  });

  // Vols (meilleure activité)
  activeJokers.filter(j => j.joker_id === 'voleur').forEach(joker => {
    const target = ranking.find(e => e.id === String(joker.target_athlete_id));
    const thief = ranking.find(e => e.id === String(joker.athlete_id));

    if (target && thief) {
      const targetActivities = activities.filter(a =>
        String(a.athlete?.id || a.athlete_id) === target.id
      );

      if (targetActivities.length > 0) {
        const bestActivity = targetActivities.reduce((best, curr) =>
          (curr.total_elevation_gain || 0) > (best.total_elevation_gain || 0) ? curr : best
        );

        const stolen = Math.round(bestActivity.total_elevation_gain || 0);
        target.elevation = Math.max(0, target.elevation - stolen);
        thief.elevation += stolen;

        target.theftReceived = { by: joker.athlete_name, amount: stolen, activity: bestActivity.name };
        thief.theftDone = { from: target.name, amount: stolen, activity: bestActivity.name };
      }
    }
  });

  // Multiplicateurs (x1.5)
  activeJokers.filter(j => j.joker_id === 'multiplicateur').forEach(joker => {
    const participant = ranking.find(e => e.id === String(joker.athlete_id));
    if (participant) {
      const bonus = Math.round(participant.elevation * 0.5);
      participant.elevation += bonus;
      participant.multiplierBonus = bonus;
    }
  });

  // Boucliers
  activeJokers.filter(j => j.joker_id === 'bouclier').forEach(joker => {
    const participant = ranking.find(e => e.id === String(joker.athlete_id));
    if (participant) {
      participant.hasShield = true;
    }
  });
}

// ============================================
// API PUBLIQUE
// ============================================

/**
 * Récupère tous les résultats figés
 */
async function getAllFrozenResults() {
  return await loadFrozenResults();
}

/**
 * Récupère les résultats d'un round spécifique
 */
async function getFrozenRoundResult(roundNumber) {
  const data = await loadFrozenResults();
  return data.rounds[String(roundNumber)] || null;
}

/**
 * Fige les résultats d'un round (ANCIENNE MÉTHODE - recalcule)
 */
async function freezeRoundResults(roundNumber, activities, athletes, jokerUsage, config) {
  const data = await loadFrozenResults();

  if (data.rounds[String(roundNumber)]?.frozen) {
    console.log(`⚠️ Round ${roundNumber} déjà figé`);
    return data.rounds[String(roundNumber)];
  }

  const results = await calculateRoundResults(
    roundNumber,
    activities,
    athletes,
    jokerUsage,
    config,
    data.rounds
  );

  data.rounds[String(roundNumber)] = results;
  await saveFrozenResults(data);

  console.log(`❄️ Round ${roundNumber} figé (calculé): ${results.eliminations.length} éliminé(s)`);

  // Générer automatiquement les choix de bonus pour le meilleur éliminé
  // (même logique que dans freezeRoundWithData, pour que le auto-freeze
  //  et le freeze admin classique génèrent aussi les pending bonus)
  if (results.eliminations && results.eliminations.length >= 2) {
    try {
      const generated = await generateBonusChoiceForBestEliminated(results.eliminations, roundNumber);
      if (generated) {
        results.bonusChoiceGenerated = generated;
      }
    } catch (e) {
      console.warn(`⚠️ Erreur génération choix bonus round ${roundNumber}:`, e.message);
    }
  }

  // Si on vient de figer la finale d'une saison, figer le challenge éliminés.
  // Détection : il ne reste qu'1 athlète actif après les éliminations de ce round.
  // (le nombre de rounds par saison varie selon les éliminations cumulées —
  //  règles spéciales handicap, multi-éliminations pour inactivité, etc.)
  try {
    const activeAtStart = results.activeParticipants?.length || 0;
    const eliminatedThisRound = results.eliminations?.length || 0;
    const survivors = activeAtStart - eliminatedThisRound;

    if (activeAtStart > 0 && survivors <= 1) {
      const elimChallengeFrozen = await freezeEliminatedChallengeForSeason(
        results.seasonNumber,
        {}
      );
      if (elimChallengeFrozen?.success) {
        console.log(
          `🏔️ Auto-freeze challenge éliminés saison ${results.seasonNumber} ` +
          `(${elimChallengeFrozen.ranking.length} athlètes, ${elimChallengeFrozen.archivedBonuses || 0} bonus archivés)`
        );
        results.eliminatedChallengeFrozen = elimChallengeFrozen;
      }
    }
  } catch (e) {
    console.warn(`⚠️ Erreur auto-freeze challenge éliminés saison ${results.seasonNumber}:`, e.message);
  }

  return results;
}

/**
 * Vérifie et fige automatiquement les rounds terminés
 */
async function autoFreezeCompletedRounds(activities, athletes, jokerUsage, config) {
  const now = new Date();
  const data = await loadFrozenResults();
  const frozenRounds = [];

  const yearStart = new Date(config.yearStartDate);
  const daysSinceStart = Math.floor((now - yearStart) / (1000 * 60 * 60 * 24));
  const currentRound = Math.floor(daysSinceStart / config.roundDurationDays) + 1;

  for (let r = 1; r < currentRound; r++) {
    if (!data.rounds[String(r)]?.frozen) {
      const result = await freezeRoundResults(r, activities, athletes, jokerUsage, config);
      frozenRounds.push(result);
    }
  }

  return frozenRounds;
}

/**
 * Recalcule le classement annuel basé sur les résultats figés
 */
async function calculateYearlyStandings(athletes) {
  const data = await loadFrozenResults();
  const standings = {};

  athletes.forEach(a => {
    standings[String(a.id)] = {
      id: String(a.id),
      name: a.name,
      totalMainPoints: 0,
      totalEliminatedPoints: 0,
      totalPoints: 0,
      wins: 0,
      seasonsPlayed: 0
    };
  });

  Object.values(data.rounds).forEach(round => {
    if (!round.frozen) return;

    round.ranking.forEach(entry => {
      if (standings[entry.id]) {
        standings[entry.id].totalMainPoints += entry.mainPoints || 0;
        if (entry.isWinner) {
          standings[entry.id].wins++;
        }
      }
    });
  });

  const standingsArray = Object.values(standings);
  standingsArray.sort((a, b) => b.totalPoints - a.totalPoints || b.wins - a.wins);
  standingsArray.forEach((e, i) => e.rank = i + 1);

  return standingsArray;
}

/**
 * Réinitialise tous les résultats figés (ATTENTION!)
 */
async function resetAllFrozenResults() {
  await saveFrozenResults({ version: "1.0", rounds: {}, lastUpdated: null });
  console.log('🗑️ Tous les résultats figés ont été supprimés');
}

/**
 * Vérifie si un round est figé
 */
async function isRoundFrozen(roundNumber) {
  const data = await loadFrozenResults();
  return !!data.rounds[String(roundNumber)]?.frozen;
}

/**
 * Défige un round spécifique (admin only)
 */
async function unfreezeRound(roundNumber) {
  const data = await loadFrozenResults();
  if (data.rounds[String(roundNumber)]) {
    delete data.rounds[String(roundNumber)];
    await saveFrozenResults(data);
    console.log(`🔓 Round ${roundNumber} défigé`);
    return true;
  }
  return false;
}

// ============================================
// PHASE 2 : CHALLENGE ÉLIMINÉS FIGÉ PAR SAISON
// ============================================

/**
 * Charge les activités d'une ligue depuis le fichier JSON.
 * Retourne [] si le fichier n'existe pas.
 */
async function loadLeagueActivities(leagueId) {
  try {
    const file = path.join(DATA_DIR, 'leagues', `${leagueId}_activities.json`);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    // Le fichier peut être soit un tableau direct, soit { activities: [...] }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.activities)) return parsed.activities;
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Charge tous les bonus (status "used" ou autre) depuis bonuses.json.
 */
async function loadAllBonuses() {
  try {
    const raw = await fs.readFile(BONUSES_FILE, 'utf8');
    const all = JSON.parse(raw);
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

/**
 * Récupère la liste des éliminés d'une saison depuis les rounds figés.
 * Format de sortie compatible avec computeEliminatedChallengeRankingForSeason :
 *   [{ id, name, eliminatedRound (GLOBAL), eliminatedSeason }]
 */
function getEliminatedListFromFrozenRounds(frozenRoundsMap, seasonNumber) {
  const out = [];
  const seenIds = new Set();
  // Itérer dans l'ordre croissant des rounds pour avoir le bon elimination_round (le premier)
  const keys = Object.keys(frozenRoundsMap)
    .map(k => Number(k))
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);

  for (const roundNumber of keys) {
    const round = frozenRoundsMap[String(roundNumber)];
    if (!round || !round.frozen) continue;
    if (Number(round.seasonNumber) !== Number(seasonNumber)) continue;
    if (!Array.isArray(round.eliminations)) continue;

    for (const elim of round.eliminations) {
      const id = String(elim.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push({
        id,
        name: elim.name,
        eliminatedRound: roundNumber,
        eliminatedSeason: seasonNumber
      });
    }
  }
  return out;
}

/**
 * Calcule la plage de dates d'une saison à partir des rounds figés.
 * Fallback si aucun round figé : renvoie les dates du 1er et dernier round
 * attendus pour la saison (basé sur CHALLENGE_CONFIG).
 */
function getSeasonDatesFromFrozen(frozenRoundsMap, seasonNumber) {
  const seasonRounds = Object.values(frozenRoundsMap || {})
    .filter(r => r && Number(r.seasonNumber) === Number(seasonNumber));

  if (seasonRounds.length > 0) {
    const starts = seasonRounds
      .map(r => r.dates?.start ? new Date(r.dates.start) : null)
      .filter(d => d && !Number.isNaN(d.getTime()));
    const ends = seasonRounds
      .map(r => r.dates?.end ? new Date(r.dates.end) : null)
      .filter(d => d && !Number.isNaN(d.getTime()));
    if (starts.length && ends.length) {
      return {
        start: new Date(Math.min(...starts.map(d => d.getTime()))),
        end: new Date(Math.max(...ends.map(d => d.getTime())))
      };
    }
  }
  // Fallback : rien de figé → on ne peut pas calculer
  return null;
}

/**
 * Fige le classement final du challenge des éliminés pour une saison donnée
 * et l'enregistre dans frozen_results.eliminatedChallengeRankings[seasonNumber].
 *
 * @param {number} seasonNumber - Numéro de la saison à figer
 * @param {Object} [options]
 * @param {string} [options.leagueId] - ID de ligue pour charger les activités (défaut : CHALLENGE_CONFIG.leagueId)
 * @param {Date} [options.currentDate] - Borne sup du calcul (défaut : now)
 * @param {boolean} [options.force] - Écraser une valeur existante
 * @returns {Object} { success, ranking?, error? }
 */
async function freezeEliminatedChallengeForSeason(seasonNumber, options = {}) {
  const data = await loadFrozenResults();

  // Vérifier si déjà figé
  if (!data.eliminatedChallengeRankings) data.eliminatedChallengeRankings = {};
  if (data.eliminatedChallengeRankings[String(seasonNumber)] && !options.force) {
    return {
      success: false,
      error: 'already_frozen',
      existing: data.eliminatedChallengeRankings[String(seasonNumber)]
    };
  }

  // Récupérer la liste des éliminés
  const eliminatedList = getEliminatedListFromFrozenRounds(data.rounds || {}, seasonNumber);
  if (eliminatedList.length === 0) {
    return { success: false, error: 'no_eliminations_found', seasonNumber };
  }

  // Déterminer la plage de dates
  const seasonDates = getSeasonDatesFromFrozen(data.rounds || {}, seasonNumber);
  if (!seasonDates) {
    return { success: false, error: 'season_dates_unavailable', seasonNumber };
  }

  // Charger les activités et les bonus
  const { CHALLENGE_CONFIG } = require('./shared-config');
  const leagueId = options.leagueId || CHALLENGE_CONFIG.leagueId;
  const activities = await loadLeagueActivities(leagueId);
  const bonusesCache = await loadAllBonuses();
  const seasonBonusesCache = data.seasonBonuses || {};

  // Date courante (par défaut : maintenant)
  const currentDate = options.currentDate || new Date();

  // Calculer le ranking
  const ranking = elimChallenge.computeEliminatedChallengeRankingForSeason({
    seasonNumber,
    activities,
    eliminatedList,
    seasonDates,
    currentDate,
    bonusesCache,
    seasonBonusesCache,
    frozenRoundsMap: data.rounds || {}
  });

  // ============================================================
  // ARCHIVAGE DES BONUS DE LA SAISON
  // ============================================================
  // Identifier les bonus de cette saison qui doivent être figés/archivés.
  // Critère : un bonus appartient à la saison N si son elimination_round
  // tombe dans un round dont seasonNumber === N.
  const elimRoundsBySeason = new Set();
  for (const [k, r] of Object.entries(data.rounds || {})) {
    if (r && Number(r.seasonNumber) === Number(seasonNumber)) {
      elimRoundsBySeason.add(Number(k));
    }
  }

  const updatedBonusesLive = [...bonusesCache];
  const archivedBonuses = []; // pour seasonBonuses[N]
  const SEASONAL_BONUS_IDS = new Set(['second_souffle', 'trap', 'duel', 'brouillard']);

  for (let i = 0; i < updatedBonusesLive.length; i++) {
    const bonus = updatedBonusesLive[i];
    const elimRound = Number(bonus.elimination_round);
    if (!elimRoundsBySeason.has(elimRound)) continue; // pas de cette saison

    // Pour les bonus saisonniers (second_souffle / trap / duel / brouillard) qui sont
    // encore "active" ou "chosen" (pas encore résolus), on calcule leur effet final.
    let nextEffectResult = bonus.effect_result;
    let nextStatus = bonus.status;

    if (SEASONAL_BONUS_IDS.has(bonus.bonus_id) &&
        (bonus.status === 'active' || bonus.status === 'chosen')) {
      // Retrouver l'entrée de ranking pour cet athlète pour récupérer le détail calculé
      const entry = ranking.find(e => String(e.id) === String(bonus.athlete_id));
      const detail = entry?.bonusEffects?.details?.find(d => {
        if (bonus.bonus_id === 'second_souffle') return d.type === 'second_souffle';
        if (bonus.bonus_id === 'trap') return d.type === 'trap_gain';
        if (bonus.bonus_id === 'duel') return d.type === 'duel';
        if (bonus.bonus_id === 'brouillard') return d.type === 'brouillard';
        return false;
      });
      if (detail) {
        nextEffectResult = {
          amount: detail.amount || 0,
          activityName: detail.activityName || null,
          appliedAt: new Date().toISOString(),
          frozenAtSeasonClose: true
        };
      } else {
        // Pas d'effet calculé (ex: l'athlète n'a pas eu d'activité dans la fenêtre)
        nextEffectResult = {
          amount: 0,
          activityName: null,
          appliedAt: new Date().toISOString(),
          frozenAtSeasonClose: true,
          noEffect: true
        };
      }
      nextStatus = 'used';
    }

    // Marquer le bonus à jour avec season_number et effet
    updatedBonusesLive[i] = {
      ...bonus,
      status: nextStatus,
      season_number: Number(seasonNumber),
      effect_result: nextEffectResult,
      effect_applied: true,
      effect_applied_at: bonus.effect_applied_at || new Date().toISOString()
    };

    // Copie pour archive
    archivedBonuses.push({ ...updatedBonusesLive[i] });
  }

  // ============================================================
  // PURGE DES BONUS NON UTILISÉS À LA FIN DE LA SAISON
  // ============================================================
  // Règle : "Si le bonus n'est pas choisi ou n'est pas utilisé à la fin
  // de la saison, il doit disparaître."
  //
  // Cas 1 : un bonus a été choisi (status 'available' = en attente d'usage)
  //         mais n'a jamais été utilisé pendant la saison → on l'expire.
  // Cas 2 : un athlète a un pending_bonus_choices (jamais validé) →
  //         on supprime l'entrée pending.
  // Note : les bonus saisonniers (second_souffle, trap, etc.) ont déjà
  //        été traités au-dessus (status passé à 'used' avec leur effet
  //        figé). Ici on traite juste les éphémères ciblés non utilisés.
  const purgeLog = { expiredBonuses: [], purgedPendingChoices: [] };

  // Cas 1 : expirer les bonus 'available' (choisis mais non utilisés)
  for (let i = 0; i < updatedBonusesLive.length; i++) {
    const b = updatedBonusesLive[i];
    if (!elimRoundsBySeason.has(Number(b.elimination_round))) continue;
    if (SEASONAL_BONUS_IDS.has(b.bonus_id)) continue; // déjà traités au-dessus
    if (b.status === 'available') {
      updatedBonusesLive[i] = {
        ...b,
        status: 'expired',
        season_number: Number(seasonNumber),
        effect_applied: false,
        expired_at: new Date().toISOString(),
        expired_reason: 'season_closed_unused'
      };
      purgeLog.expiredBonuses.push({
        bonus_id: b.bonus_id,
        athlete_id: b.athlete_id,
        athlete_name: b.athlete_name,
        elimination_round: b.elimination_round
      });
      // Important : ajouter aussi à l'archive de la saison
      archivedBonuses.push({ ...updatedBonusesLive[i] });
    }
  }

  // Cas 2 : purger les pending_bonus_choices non validés pour cette saison
  try {
    const PENDING_FILE = path.join(DATA_DIR, 'pending_bonus_choices.json');
    const pendingRaw = await fs.readFile(PENDING_FILE, 'utf8').catch(() => '{}');
    const pending = JSON.parse(pendingRaw || '{}');
    let pendingChanged = false;

    for (const [athleteId, p] of Object.entries(pending)) {
      const elimRound = Number(p?.elimination_round);
      if (elimRoundsBySeason.has(elimRound)) {
        purgeLog.purgedPendingChoices.push({
          athlete_id: athleteId,
          athlete_name: p.athlete_name,
          elimination_round: elimRound,
          choices: p.choices
        });
        delete pending[athleteId];
        pendingChanged = true;
      }
    }

    if (pendingChanged) {
      await fs.writeFile(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn(`⚠️ Impossible de purger pending_bonus_choices pendant freeze saison ${seasonNumber}:`, e.message);
  }

  if (purgeLog.expiredBonuses.length || purgeLog.purgedPendingChoices.length) {
    console.log(
      `🧹 Purge saison ${seasonNumber}: ` +
      `${purgeLog.expiredBonuses.length} bonus expiré(s), ` +
      `${purgeLog.purgedPendingChoices.length} pending choice(s) supprimé(s)`
    );
  }

  // Sauvegarder bonuses.json (live) avec les nouveaux statuts
  try {
    await fs.writeFile(BONUSES_FILE, JSON.stringify(updatedBonusesLive, null, 2), 'utf8');
  } catch (e) {
    console.warn(`⚠️ Impossible d'écrire ${BONUSES_FILE} pendant freeze saison ${seasonNumber}:`, e.message);
  }

  // Stocker le ranking + archiver les bonus dans seasonBonuses[N]
  // Stocker le ranking + archiver les bonus dans seasonBonuses[N]
  data.eliminatedChallengeRankings[String(seasonNumber)] = {
    frozenAt: new Date().toISOString(),
    seasonNumber,
    ranking,
    bonusesCount: archivedBonuses.length,
    purgeLog
  };

  if (!data.seasonBonuses) data.seasonBonuses = {};
  data.seasonBonuses[String(seasonNumber)] = archivedBonuses;
  data.lastUpdated = new Date().toISOString();

  await saveFrozenResults(data);

  console.log(`🏔️ Challenge éliminés saison ${seasonNumber} figé : ${ranking.length} athlète(s), ${archivedBonuses.length} bonus archivé(s)`);

  return {
    success: true,
    seasonNumber,
    ranking,
    archivedBonuses: archivedBonuses.length,
    purgeLog,
    frozenAt: data.eliminatedChallengeRankings[String(seasonNumber)].frozenAt
  };
}

/**
 * Défige le classement challenge éliminés d'une saison (admin).
 */
async function unfreezeEliminatedChallengeForSeason(seasonNumber) {
  const data = await loadFrozenResults();
  if (data.eliminatedChallengeRankings && data.eliminatedChallengeRankings[String(seasonNumber)]) {
    delete data.eliminatedChallengeRankings[String(seasonNumber)];
    await saveFrozenResults(data);
    return true;
  }
  return false;
}

module.exports = {
  getAllFrozenResults,
  getFrozenRoundResult,
  freezeRoundResults,
  freezeRoundWithData,      // NOUVELLE: fige avec données du frontend
  importFrozenResults,       // NOUVELLE: import de fichier JSON
  autoFreezeCompletedRounds,
  calculateYearlyStandings,
  resetAllFrozenResults,
  isRoundFrozen,
  unfreezeRound,
  // Phase 2 : challenge éliminés par saison
  freezeEliminatedChallengeForSeason,
  unfreezeEliminatedChallengeForSeason,
  getRoundDates,
  getSeasonNumber,
  getRoundInSeason
};