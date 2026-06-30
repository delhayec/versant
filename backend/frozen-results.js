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
const roundConfigs = require('./round-configs');

// Import configuration partagée (source unique de vérité)
const {
  VALID_SPORTS, isValidSport,
  MAIN_CHALLENGE_POINTS, ELIMINATED_CHALLENGE_POINTS,
  getMainPoints, getEliminatedPoints,
  BONUS_IDS,
  getRoundDates, getSeasonNumber, getRoundInSeason,
  isTeamSeason, getSeasonType, getTeamEliminatedPoints
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

  // Pas de rescapé en saison team (règle métier validée)
  if (roundData.seasonType === 'team' || isTeamSeason(roundData.seasonNumber)) {
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

  // Générer automatiquement les choix de bonus pour le meilleur éliminé.
  // EXCEPTION saison team : pas de bonus éphémère pour les éliminés de la
  // finale principale R4 (règle métier : "Les 6 finalistes (R4) entrent au
  // R5 sans avoir reçu de bonus éphémère du R4"). On skip aussi pour le R5
  // qui n'a aucune élimination de toute façon.
  let bonusChoiceGenerated = null;
  const skipBonusGen = frozenRound.isFinalePrincipale === true || frozenRound.teamFinalRound === true;
  if (!skipBonusGen && frozenRound.eliminations && frozenRound.eliminations.length >= 2) {
    try {
      bonusChoiceGenerated = await generateBonusChoiceForBestEliminated(frozenRound.eliminations, roundNumber);
    } catch (e) {
      console.warn(`⚠️ Erreur génération choix bonus round ${roundNumber}:`, e.message);
    }
  }

  // Phase 2 : si on vient de figer la FINALE d'une saison, figer automatiquement
  // le classement final du challenge des éliminés pour cette saison.
  // Détection :
  //   - Saison standard : il ne reste qu'1 athlète actif après les éliminations.
  //   - Saison team : on fige seulement quand teamFinalRound=true (= R5 / round
  //     final éliminés). Le R4 (finale principale) ne déclenche PAS le freeze.
  let eliminatedChallengeFrozen = null;
  try {
    const isTeamRound = frozenRound.seasonType === 'team' || isTeamSeason(frozenRound.seasonNumber);
    let shouldFreezeSeason = false;

    if (isTeamRound) {
      // En saison team, le challenge éliminés se fige UNIQUEMENT à la fin du
      // round final éliminés (R5). Tous les autres rounds team (incluant R4
      // finale principale) ne déclenchent pas le freeze.
      shouldFreezeSeason = frozenRound.teamFinalRound === true;
    } else {
      const activeAtStart = frozenRound.activeParticipants?.length || 0;
      const eliminatedThisRound = frozenRound.eliminations?.length || 0;
      const survivors = activeAtStart - eliminatedThisRound;
      shouldFreezeSeason = activeAtStart > 0 && survivors <= 1;
    }

    if (shouldFreezeSeason) {
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

  // Ne pas générer de bonus si la saison de ce round est déjà close.
  // Cas typique : on défige/refige un round d'une saison passée pour réparer
  // des données (cf. restauration du fichier d'avril). Sans ce garde-fou, un
  // pending parasite est créé pour le "meilleur éliminé" d'une saison
  // terminée depuis longtemps, et s'affiche au mauvais utilisateur sur le
  // dashboard. Une saison est "close" si son challenge éliminés a été figé
  // (eliminatedChallengeRankings[seasonNumber] existe).
  try {
    const data = await loadFrozenResults();
    const frozenRound = data.rounds?.[String(roundNumber)];
    const seasonNumber = frozenRound?.seasonNumber;
    if (seasonNumber && data.eliminatedChallengeRankings?.[String(seasonNumber)]) {
      console.log(`🎁 Pas de bonus pour round ${roundNumber}: saison ${seasonNumber} déjà close (challenge éliminés figé)`);
      return null;
    }
  } catch (e) {
    console.warn(`⚠️ Erreur lecture frozen_results pour check saison close:`, e.message);
    // En cas d'erreur, on continue (ne pas bloquer la génération par sécurité)
  }

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

  // Vérifier si déjà généré pour ce round précis.
  // Un pending d'un round antérieur (saison précédente non utilisée) ne doit
  // pas bloquer la génération d'un nouveau bonus pour un round ultérieur.
  const playerId = String(bestEliminated.id);
  const existing = pendingChoices[playerId];
  if (existing && Number(existing.elimination_round) === Number(roundNumber)) {
    console.log(`🎁 Choix bonus déjà existant pour ${bestEliminated.name} au round ${roundNumber}`);
    return null;
  }
  if (existing) {
    console.log(`🎁 Ancien pending de ${bestEliminated.name} (R${existing.elimination_round}) remplacé par nouveau choix R${roundNumber}`);
  }

  // Tirer 2 bonus au hasard parmi les bonus que l'athlète n'a pas déjà.
  // Évite de proposer un second_souffle à quelqu'un qui en a déjà reçu un
  // dans une saison précédente (puisque les saisonniers restent dans
  // bonuses.json même après usage et clôture).
  let alreadyOwnedBonusIds = new Set();
  try {
    const allBonuses = await loadAllBonuses();
    alreadyOwnedBonusIds = new Set(
      allBonuses
        .filter(b => String(b.athlete_id) === String(bestEliminated.id))
        .map(b => b.bonus_id)
    );
  } catch (e) {
    // Si on n'arrive pas à lire bonuses.json, on continue sans filtrage
  }

  const eligibleBonuses = BONUS_IDS.filter(id => !alreadyOwnedBonusIds.has(id));
  // Si moins de 2 bonus éligibles (cas extrême), on retombe sur tous
  const pool = eligibleBonuses.length >= 2 ? eligibleBonuses : BONUS_IDS;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
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
// HELPERS DÉTECTION SAISON (ROBUSTE)
// ============================================

/**
 * Détecte la saison/round-in-season pour un round donné en s'appuyant
 * sur les rounds précédents déjà figés. Plus robuste que le calcul naïf
 * `Math.ceil((totalParticipants - 1) / 2)` qui se trompe quand des règles
 * spéciales ont multiplié les éliminations.
 *
 * @returns {{ seasonNumber, roundInSeason }}
 */
function detectSeasonContext(roundNumber, previousRounds) {
  // Trouver le dernier round figé < roundNumber
  let lastFrozen = null;
  for (let r = roundNumber - 1; r >= 1; r--) {
    const prev = previousRounds[String(r)];
    if (prev && prev.frozen) {
      lastFrozen = { round: r, ...prev };
      break;
    }
  }

  if (!lastFrozen) {
    // Tout premier round → saison 1, round 1
    return { seasonNumber: 1, roundInSeason: 1 };
  }

  // Détecter si la saison du dernier round figé est terminée
  // Cas 1 : le round précédent a marqué la saison comme terminée (séason team R5
  //         a aucun éliminé mais a un teamFinalRound: true ; saison standard
  //         finale a 1 actif restant à la fin).
  // Cas 2 : on regarde si des actifs restent.
  const prevSeasonNumber = lastFrozen.seasonNumber;
  const activeAtStart = (lastFrozen.activeParticipants?.length || 0);
  const eliminatedCount = (lastFrozen.eliminations?.length || 0);
  const survivorsAfter = activeAtStart - eliminatedCount;
  const wasTeamFinalRound = lastFrozen.teamFinalRound === true;

  if (survivorsAfter <= 1 || wasTeamFinalRound) {
    // Saison terminée → on commence une nouvelle saison
    return { seasonNumber: prevSeasonNumber + 1, roundInSeason: 1 };
  }
  return {
    seasonNumber: prevSeasonNumber,
    roundInSeason: (lastFrozen.roundInSeason || 0) + 1
  };
}

// ============================================
// CALCUL SAISON TEAM
// ============================================

/**
 * Récupère les équipes existantes (figées) d'une saison team.
 * Utilisé pour préserver la composition d'équipes éliminées entre rounds.
 *
 * @param {number} seasonNumber
 * @param {Object} previousRounds
 * @returns {Object} { eliminatedTeams: [...], usedAnimalIds: Set }
 *   eliminatedTeams = équipes éliminées dans la saison (composition figée)
 */
function gatherTeamSeasonHistory(seasonNumber, previousRounds) {
  const eliminatedTeams = []; // [{ animal, color, members: [{id, name}], eliminatedRound }]
  const usedAnimalIds = new Set();

  for (const [k, r] of Object.entries(previousRounds || {})) {
    if (!r?.frozen) continue;
    if (Number(r.seasonNumber) !== Number(seasonNumber)) continue;
    if (!Array.isArray(r.teams)) continue;

    for (const t of r.teams) {
      if (t.animal?.id) usedAnimalIds.add(t.animal.id);
    }
    if (r.eliminatedTeam) {
      eliminatedTeams.push({
        ...r.eliminatedTeam,
        eliminatedRound: Number(k),
        roundInSeason: r.roundInSeason
      });
    }
  }

  return { eliminatedTeams, usedAnimalIds };
}

/**
 * Calcule un round de saison team (saison 4 par défaut).
 * Modes :
 *   - Round normal (R1 à R(N-2)) : forme les équipes, calcule D+, élimine la pire.
 *   - Round finale principale (R(N-1)) : 2 équipes restantes, toutes éliminées,
 *     positions 1-6 réparties selon le D+ équipe puis individuel.
 *   - Round finale éliminés (R(N) = dernier round) : aucun joueur actif, calcule
 *     simplement les D+ R5 par équipe d'éliminés. Le ranking final du challenge
 *     éliminés est calculé séparément par freezeTeamEliminatedChallengeForSeason.
 */
async function calculateTeamRoundResults(roundNumber, seasonNumber, roundInSeason, activities, athletes, jokerUsage, config, previousRounds) {
  const teamUtils = require('./team-utils');
  const { getSeasonType } = require('./shared-config');

  const seasonType = getSeasonType(seasonNumber);
  const teamSize = seasonType?.teamSize || 3;

  const roundDates = getRoundDates(roundNumber, config);
  const roundStart = roundDates.start.getTime();
  const roundEnd = roundDates.end.getTime();

  // Activités du round
  const roundActivities = activities.filter(a => {
    const start = new Date(a.start_date).getTime();
    const elapsedMs = (a.elapsed_time || 0) * 1000;
    const actEnd = start + elapsedMs;
    if (actEnd < roundStart || actEnd > roundEnd) return false;
    if (a.excluded) return false;
    const sport = a.sport_type || a.type;
    if (!isValidSport(sport)) return false;
    return true;
  });

  // Déterminer les actifs (non éliminés dans les rounds précédents de cette saison)
  let activeIds = athletes.map(a => String(a.id));
  for (let r = roundNumber - 1; r >= 1; r--) {
    const prev = previousRounds[String(r)];
    if (!prev?.frozen) continue;
    if (Number(prev.seasonNumber) !== Number(seasonNumber)) break;
    if (Array.isArray(prev.eliminations)) {
      const elimIds = prev.eliminations.map(e => String(e.id));
      activeIds = activeIds.filter(id => !elimIds.includes(id));
    }
  }

  // Récupérer l'historique de la saison team (équipes éliminées + animaux utilisés)
  const history = gatherTeamSeasonHistory(seasonNumber, previousRounds);

  // ============================================
  // CAS A : FINALE ÉLIMINÉS (dernier round, 0 actifs OU R après finale principale)
  // ============================================
  // On détecte ce cas par : aucun actif restant ET au moins 1 équipe éliminée.
  // Dans ce round, AUCUN joueur n'est actif donc pas d'élimination, on calcule
  // juste les D+ R par équipe d'éliminés (composition figée à leur élimination).
  if (activeIds.length === 0 && history.eliminatedTeams.length > 0) {
    const teamsForRound = history.eliminatedTeams.map(t => {
      const membersWithElev = t.members.map(m => {
        const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
        const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
        return { id: String(m.id), name: m.name, elevation: Math.round(elev), activitiesCount: acts.length };
      }).sort((a, b) => b.elevation - a.elevation);
      return {
        ...t,
        members: membersWithElev,
        totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0)
      };
    }).sort((a, b) => b.totalElevation - a.totalElevation);

    return {
      roundNumber,
      seasonNumber,
      roundInSeason,
      seasonType: 'team',
      teamFinalRound: true,             // marqueur pour detectSeasonContext
      isFinaleEliminated: true,
      dates: { start: roundDates.start, end: roundDates.end },
      frozen: true,
      frozenAt: new Date().toISOString(),
      frozenMethod: 'calculated',
      specialRule: null,
      activeParticipants: [],
      ranking: [],
      eliminations: [],
      teams: teamsForRound,
      jokersUsed: [],
      bonusesUsed: [],
      rescapeInfo: null,
      stats: {
        totalActivities: roundActivities.length,
        totalElevation: teamsForRound.reduce((s, t) => s + t.totalElevation, 0),
        eliminationsCount: 0
      }
    };
  }

  // ============================================
  // CAS B : ROUND NORMAL OU FINALE PRINCIPALE
  // ============================================
  // Former équipes équilibrées sur le round courant
  const activeAthletes = activeIds.map(id => {
    const a = athletes.find(x => String(x.id) === id);
    return { id, name: a?.name || `Athlète ${id}` };
  });

  // pointsMap pour équilibrage : on lit le snapshot envoyé par le frontend
  // (calcul source de vérité, mis à jour à chaque rendu de la page index).
  // Si le snapshot n'existe pas (cas test ou ancien serveur), tous les
  // joueurs sont à 0 → équilibrage purement aléatoire mais reproductible
  // via le seed = roundNumber.
  const pointsMap = {};
  activeAthletes.forEach(a => { pointsMap[a.id] = 0; });

  try {
    const dataForSnapshot = await loadFrozenResults();
    const snap = dataForSnapshot.yearlyStandingsSnapshot?.standings;
    if (Array.isArray(snap)) {
      snap.forEach(s => {
        if (s.id != null) pointsMap[String(s.id)] = s.totalPoints || 0;
      });
    }
  } catch (e) {
    console.warn('⚠️ Snapshot yearlyStandings indisponible:', e.message);
  }

// === Lecture prioritaire des équipes verrouillées dans season_teams.json ===
  // Évite que le freeze nocturne tire une nouvelle compo différente de celle
  // affichée aux joueurs pendant la semaine.
  // Priorité :
  //   1. season_teams.json["<season>"]["rounds"]["<round>"]["teams"]
  //   2. season_teams.json["<season>"]["teams"] uniquement si R1 de la saison team
  //   3. fallback : tirage normal via formBalancedTeams
  let teamsWithAnimal = null;
  let teamsLockedSource = null;
  try {
    const path = require('path');
    const fs = require('fs').promises;
    const SEASON_TEAMS_FILE = path.join(__dirname, 'data', 'season_teams.json');
    const raw = await fs.readFile(SEASON_TEAMS_FILE, 'utf8').catch(() => null);
    if (raw) {
      const stored = JSON.parse(raw);
      const seasonEntry = stored[String(seasonNumber)];
      if (seasonEntry) {
        // 1. Round spécifique
        const roundEntry = seasonEntry.rounds?.[String(roundNumber)];
        if (roundEntry && Array.isArray(roundEntry.teams) && roundEntry.teams.length > 0) {
          teamsWithAnimal = roundEntry.teams;
          teamsLockedSource = `rounds["${roundNumber}"]`;
        }
        // 2. Compo "racine" uniquement pour R1 de saison team
        else if (Array.isArray(seasonEntry.teams) && seasonEntry.teams.length > 0) {
          const isFirstRoundOfSeason = !Object.values(previousRounds || {}).some(r =>
            Number(r?.seasonNumber) === Number(seasonNumber) && Number(r?.roundNumber) < Number(roundNumber)
          );
          if (isFirstRoundOfSeason) {
            teamsWithAnimal = seasonEntry.teams;
            teamsLockedSource = 'teams (root, legacy)';
          }
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Lecture season_teams.json échouée:', e.message);
  }

  // 3. Fallback : tirage normal
  if (!teamsWithAnimal) {
    const teams = teamUtils.formBalancedTeams(activeAthletes, pointsMap, roundNumber, teamSize);
    teamsWithAnimal = teamUtils.assignTeamAnimals(teams, history.usedAnimalIds, roundNumber);
    teamsLockedSource = 'computed (formBalancedTeams)';
  }

  console.log(`📋 R${roundNumber} équipes : source = ${teamsLockedSource}`);

  // Calcul des D+ par membre puis par équipe.
  // ÉTAPE 1 : construire un ranking individuel temporaire pour pouvoir
  // appliquer les jokers (voleur, sabotage, multiplicateur) et les bonus
  // éphémères avant la sommation par équipe (puisque ces effets ciblent
  // un joueur spécifique).
  const tmpRanking = [];
  for (const team of teamsWithAnimal) {
    for (const m of team.members) {
      const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
      const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
      tmpRanking.push({
        id: String(m.id),
        name: m.name,
        elevation: Math.round(elev),
        activitiesCount: acts.length,
        originalElevation: Math.round(elev),
        bonusPoints: 0,
        teamIndex: team.index
      });
    }
  }

  // Appliquer les effets des jokers actifs ce round
  const activeJokers = (jokerUsage || []).filter(j =>
    j.round_number === roundNumber && j.status === 'active'
  );
  if (activeJokers.length > 0) {
    applyJokerEffects(tmpRanking, activeJokers, roundActivities, athletes);
  }

  // Appliquer les effets des bonus éphémères (ravitaillement, embuscade, etc.)
  await applyEphemeralBonusEffects(tmpRanking, roundNumber, roundActivities);

  // ÉTAPE 2 : reconstruire les équipes avec les D+ corrigés post-jokers/bonus
  const elevById = {};
  const activitiesById = {};
  tmpRanking.forEach(r => {
    elevById[r.id] = r.elevation;
    activitiesById[r.id] = r.activitiesCount;
  });

  // Calcul des D+ par membre puis par équipe
  const teamsWithElevation = teamsWithAnimal.map(team => {
    const teamActs = []; // pour tie-break temporel
    const membersWithElev = team.members.map(m => {
      const acts = roundActivities.filter(a => String(a.athlete?.id || a.athlete_id) === String(m.id));
      teamActs.push(...acts);
      return {
        id: String(m.id),
        name: m.name,
        elevation: elevById[String(m.id)] ?? 0,
        activitiesCount: activitiesById[String(m.id)] ?? acts.length,
        originalElevation: Math.round(acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0)),
        bonusPoints: 0
      };
    }).sort((a, b) => b.elevation - a.elevation);

    // Timestamp de la dernière activité de l'équipe (pour tie-break temporel).
    let lastActivityTime = 0;
    for (const a of teamActs) {
      const start = new Date(a.start_date_local || a.start_date).getTime();
      const elapsed = (a.elapsed_time || 0) * 1000;
      const t = start + elapsed;
      if (t > lastActivityTime) lastActivityTime = t;
    }

    return {
      ...team,
      members: membersWithElev,
      totalElevation: membersWithElev.reduce((s, m) => s + m.elevation, 0),
      lastActivityTime
    };
  });

  // Trier les équipes par D+ total décroissant
  // Tie-break : en cas d'égalité, l'équipe avec l'activité la plus récente
  // est classée DERNIÈRE (= éliminée en priorité). Logique : on récompense
  // l'équipe qui a "fini" plus tôt sa contribution.
  teamsWithElevation.sort((a, b) => {
    if (b.totalElevation !== a.totalElevation) {
      return b.totalElevation - a.totalElevation;
    }
    // Égalité de D+ : celle qui a posté son activité la plus récente perd
    // (rang plus bas = activité plus récente = perdant).
    return a.lastActivityTime - b.lastActivityTime;
  });

  // ============================================
  // Ranking individuel (positions selon D+ équipe puis D+ individuel)
  // ============================================
  // Position 1 = meilleur contributeur de la meilleure équipe
  // Position N = dernier contributeur de la pire équipe
  const ranking = [];
  let pos = 1;
  for (const team of teamsWithElevation) {
    for (const member of team.members) {
      ranking.push({
        ...member,
        position: pos++,
        teamIndex: team.index,
        teamAnimal: team.animal,
        teamColor: team.color,
        mainPoints: 0  // sera défini ci-dessous
      });
    }
  }

  // ============================================
  // Détecter type de round : finale principale ou round normal
  // ============================================
  // Finale principale = il ne reste que 2 équipes au début du round
  const isFinalePrincipale = teamsWithElevation.length === 2;

  let eliminations = [];
  let eliminatedTeam = null;

  if (isFinalePrincipale) {
    // FINALE PRINCIPALE : toutes les équipes (les 2) sont éliminées
    // Positions 1-3 → équipe 1 (24/21/18), 4-6 → équipe 2 (15/12/10)
    // Les mainPoints sont définis sur leur position absolue
    for (const entry of ranking) {
      entry.mainPoints = MAIN_CHALLENGE_POINTS[entry.position] || 0;
    }
    // Tous les joueurs sont éliminés
    for (const team of teamsWithElevation) {
      for (const m of team.members) {
        const r = ranking.find(x => x.id === m.id);
        eliminations.push({
          id: m.id,
          name: m.name,
          elevation: m.elevation,
          reason: 'team_finale',
          position: r?.position,
          teamIndex: team.index,
          teamAnimal: team.animal,
          teamColor: team.color
        });
      }
    }
    // L'équipe vaincue (dernière) sert d'eliminatedTeam pour archive
    eliminatedTeam = {
      ...teamsWithElevation[teamsWithElevation.length - 1],
      eliminationReason: 'team_finale_loser'
    };
  } else {
    // ROUND NORMAL : la pire équipe est éliminée
    const pireTeam = teamsWithElevation[teamsWithElevation.length - 1];

    // Positions des éliminés selon le D+ croissant dans l'équipe (le pire en dernier)
    const elimMembersSorted = [...pireTeam.members].sort((a, b) => a.elevation - b.elevation);
    const totalActiveAtStart = activeIds.length;

    elimMembersSorted.forEach((m, idx) => {
      // position absolue = total_actifs - idx (le pire = position max)
      const elimPosition = totalActiveAtStart - idx;
      const r = ranking.find(x => x.id === m.id);
      if (r) {
        r.position = elimPosition;
        r.mainPoints = MAIN_CHALLENGE_POINTS[elimPosition] || 0;
      }
      eliminations.push({
        id: m.id,
        name: m.name,
        elevation: m.elevation,
        reason: 'team_elimination',
        position: elimPosition,
        teamIndex: pireTeam.index,
        teamAnimal: pireTeam.animal,
        teamColor: pireTeam.color
      });
    });

    eliminatedTeam = {
      ...pireTeam,
      eliminationReason: 'team_elimination'
    };
  }

  // Résultat
  const frozen = {
    roundNumber,
    seasonNumber,
    roundInSeason,
    seasonType: 'team',
    isTeamSeasonRound: true,
    isFinalePrincipale,
    dates: { start: roundDates.start, end: roundDates.end },
    frozen: true,
    frozenAt: new Date().toISOString(),
    frozenMethod: 'calculated',
    specialRule: null,
    activeParticipants: activeIds,
    ranking,
    eliminations,
    teams: teamsWithElevation,
    eliminatedTeam,
    jokersUsed: activeJokers,
    bonusesUsed: [],  // les bonus utilisés sont logés dans bonuses.json (pas dupliqués ici)
    rescapeInfo: null, // pas de rescapé en saison team
    stats: {
      totalActivities: roundActivities.length,
      totalElevation: teamsWithElevation.reduce((s, t) => s + t.totalElevation, 0),
      eliminationsCount: eliminations.length
    }
  };

  return frozen;
}

// ============================================
// ANCIENNE MÉTHODE: CALCUL DES RÉSULTATS
// ============================================

/**
 * Calcule et fige les résultats d'un round terminé
 * ATTENTION: Cette méthode recalcule tout - préférer freezeRoundWithData()
 */
async function calculateRoundResults(roundNumber, activities, athletes, jokerUsage, config, previousRounds) {
  // Détection robuste de la saison & du round-in-season à partir des rounds figés.
  // Fallback sur le calcul naïf si aucun round précédent n'est figé (cas des tests).
  const ctx = detectSeasonContext(roundNumber, previousRounds || {});
  const seasonNumber = ctx.seasonNumber;
  const roundInSeason = ctx.roundInSeason;
  const roundCustomConfig = await roundConfigs.getRoundConfig(roundNumber);
 const isCustomFinale = roundCustomConfig?.type === 'finale';
 const customNbEliminations = roundCustomConfig?.nbEliminations;

  // BRANCHING SAISON TEAM
  // ====================
  // Si la saison de ce round est de type "team", on délègue à un calculateur spécifique.
  if (isTeamSeason(seasonNumber)) {
    return calculateTeamRoundResults(
      roundNumber, seasonNumber, roundInSeason,
      activities, athletes, jokerUsage, config, previousRounds
    );
  }

  // ============================================
  // CALCUL STANDARD (saisons individuelles)
  // ============================================
  const roundDates = getRoundDates(roundNumber, config);
  const totalParticipants = athletes.length;
  const roundsPerSeason = Math.ceil((totalParticipants - 1) / config.eliminationsPerRound);
  const isFinale = roundInSeason === roundsPerSeason;

  // Déterminer les participants actifs (non éliminés dans les rounds précédents de cette saison)
  let activeParticipants = athletes.map(a => String(a.id));

  // Trouver les éliminés des rounds précédents de CETTE saison.
  // On s'appuie sur seasonNumber détecté pour identifier les bornes de la saison
  // dans les rounds figés (plus robuste que le calcul (s-1)*roundsPerSeason+1
  // qui se trompe quand des règles spéciales ont multiplié les éliminations).
  for (let r = roundNumber - 1; r >= 1; r--) {
    const prevRound = previousRounds[String(r)];
    if (!prevRound?.frozen) continue;
    if (Number(prevRound.seasonNumber) !== Number(seasonNumber)) break;
    if (prevRound.eliminations) {
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

// Nombre d'éliminations (peut être overridé par la règle spéciale ou la config admin du round)
  // Priorité : config admin > règle spéciale > config par défaut
  const eliminationsForThisRound = customNbEliminations
    ?? specialRule?.parameters?.eliminationsOverride
    ?? config.eliminationsPerRound;

  // Forcer le statut finale si configuré par l'admin
  // (override le calcul automatique basé sur le nombre de rounds)
  const effectiveIsFinale = isFinale || isCustomFinale;

  // Joueurs éligibles (sans bouclier)
  const eligibleForElimination = ranking.filter(e => !e.hasShield);

  // Joueurs à 0 D+ (éligibles uniquement)
  const zeroElevationPlayers = eligibleForElimination.filter(e => e.elevation === 0);

  // Déterminer qui éliminer
  let toEliminate = [];

  // Appliquer les nouvelles règles seulement à partir du R7
  const useNewRules = roundNumber >= 7;

  if (effectiveIsFinale) {
    // FINALE: éliminer tous sauf 1
    // Sauf si la config admin force nbEliminations: 0 (cas finale à plusieurs joueurs sans élimination)
    if (customNbEliminations === 0) {
      toEliminate = [];
      console.log(`🏆 Round ${roundNumber}: finale sans élimination (${eligibleForElimination.length} finalistes)`);
    } else {
      toEliminate = eligibleForElimination.slice(1);
    }
  } else if (useNewRules && zeroElevationPlayers.length >= 2 && zeroElevationPlayers.length >= eliminationsForThisRound) {
    // Si le nombre de joueurs à 0 D+ dépasse le nombre d'éliminations prévues → tous éliminés
    toEliminate = zeroElevationPlayers;
    console.log(`📋 Round ${roundNumber}: ${zeroElevationPlayers.length} joueurs à 0 D+ (≥${eliminationsForThisRound}) → tous éliminés`);
  } else {
    // RÈGLE NORMALE: éliminer les N derniers (2 par défaut, 4 pour handicap, ou config admin)
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

  // Règle "inactifs ex-aequo" : tous les inactifs éliminés sont ex-aequo et
  // reçoivent les points de la dernière position inactive du round (= position
  // la plus basse). Exemple : 9 actifs, 4 inactifs éliminés en positions 9/8/7/6,
  // tous les 4 reçoivent les points de la position 9 (= MAIN_CHALLENGE_POINTS[9]).
  // Justification : ils n'ont rien fait, donc indissociables — pas de gradation.
  const nbInactiveElims = eliminations.filter(e => e.reason === 'zero_elevation').length;
  const lastInactivePosition = nbInactiveElims > 0 ? activeAtRoundStart : null;

  ranking.forEach(entry => {
    const eliminationEntry = eliminations.find(e => e.id === entry.id);
    if (eliminationEntry) {
      const indexInElims = eliminations.findIndex(e => e.id === entry.id);
      // Position: dernier = activeAtRoundStart, avant-dernier = activeAtRoundStart - 1
      const position = activeAtRoundStart - indexInElims;

      if (eliminationEntry.reason === 'zero_elevation' && lastInactivePosition !== null) {
        // Inactif éliminé : ex-aequo avec les autres inactifs, points de la dernière position inactive
        entry.mainPoints = getMainPoints(Math.max(1, Math.min(lastInactivePosition, totalParticipants)));
      } else {
        // Actif éliminé : points selon sa position absolue dans le classement
        entry.mainPoints = getMainPoints(Math.max(1, Math.min(position, totalParticipants)));
      }
      entry.eliminatedPosition = position;
    } else if (effectiveIsFinale && ranking.filter(e => !eliminations.some(el => el.id === e.id)).length === 1) {
      entry.mainPoints = getMainPoints(1);
      entry.isWinner = true;
    } else if (effectiveIsFinale) {
      // Finale sans élimination (customNbEliminations === 0) : chaque finaliste reçoit
      // les points correspondant à sa position dans le classement final
      entry.mainPoints = getMainPoints(Math.max(1, Math.min(entry.position, totalParticipants)));
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
    frozenMethod: 'calculated',
    specialRule: specialRule?.id || null,
    // Propager le statut de finale (utile pour les snapshots et le calcul des bonus)
    // En saison individuelle, on utilise le même flag que la saison team pour cohérence.
    isFinalePrincipale: effectiveIsFinale,
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
case 'marquage': {
        // Marquage : +1 pt classement général si la cible est éliminée ce round.
        // On regarde la liste 'eliminations' du round courant (plus fiable que
        // 'eliminatedPosition' dans le ranking qui peut être absent selon l'ordre
        // d'application des effets).
        const targetId = normalizeId(bonus.target_athlete_id);
        // Chercher la cible dans les éliminations actuelles
        // ATTENTION : ici on n'a pas accès direct à r.eliminations dans
        // applyEphemeralBonusEffects. On regarde le ranking : la cible est
        // éliminée si elle existe dans le ranking ET son D+ est dans les 2
        // derniers OU si eliminatedPosition est posé.
        const targetRanking = ranking.find(e => normalizeId(e.id) === targetId);
        // Détecter l'élimination : eliminatedPosition posé, OU position dans les
        // 2 dernières du ranking (= éliminé après tri final)
        const isEliminated = targetRanking && (
          targetRanking.eliminatedPosition != null ||
          // Fallback : compter les positions par D+ croissant
          (() => {
            const sorted = [...ranking].sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
            const lastTwoIds = sorted.slice(0, 2).map(e => normalizeId(e.id));
            return lastTwoIds.includes(targetId);
          })()
        );

        bonuses[i].effect_applied = true;
        bonuses[i].effect_result = {
          targetId,
          targetName: bonus.target_athlete_name,
          targetEliminated: !!isEliminated,
          pointsAwarded: isEliminated ? 1 : 0,
          calculatedInRound: roundNumber
        };
        bonuses[i].effect_applied_at = new Date().toISOString();

        if (isEliminated) {
          console.log(`🎯 Marquage réussi: ${bonus.athlete_name} a marqué ${bonus.target_athlete_name} → +1 pt`);
        } else {
          console.log(`🎯 Marquage raté: ${bonus.target_athlete_name} a survécu`);
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

  // Générer automatiquement les choix de bonus pour le meilleur éliminé.
  // EXCEPTION saison team : pas de bonus éphémère pour les éliminés de la
  // finale principale R4 (règle métier : "Les 6 finalistes (R4) entrent au
  // R5 sans avoir reçu de bonus éphémère du R4"). On skip aussi pour le R5.
  const skipBonusGen = results.isFinalePrincipale === true || results.teamFinalRound === true;
  if (!skipBonusGen && results.eliminations && results.eliminations.length >= 2) {
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
    const isTeamRound = results.seasonType === 'team' || isTeamSeason(results.seasonNumber);
    let shouldFreezeSeason = false;

    if (isTeamRound) {
      shouldFreezeSeason = results.teamFinalRound === true;
    } else {
      const activeAtStart = results.activeParticipants?.length || 0;
      const eliminatedThisRound = results.eliminations?.length || 0;
      const survivors = activeAtStart - eliminatedThisRound;
      shouldFreezeSeason = activeAtStart > 0 && survivors <= 1;
    }

    if (shouldFreezeSeason) {
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
async function freezeTeamEliminatedChallengeForSeason(seasonNumber, options = {}) {
  const data = await loadFrozenResults();
  const { CHALLENGE_CONFIG } = require('./shared-config');

  // Récupérer tous les rounds de la saison
  const seasonRounds = [];
  for (const [k, r] of Object.entries(data.rounds || {})) {
    if (r && Number(r.seasonNumber) === Number(seasonNumber)) {
      seasonRounds.push({ roundNumber: Number(k), ...r });
    }
  }
  seasonRounds.sort((a, b) => a.roundNumber - b.roundNumber);

  if (seasonRounds.length === 0) {
    return { success: false, error: 'no_rounds_found', seasonNumber };
  }

  // Le ranking final s'appuie sur les D+ cumulés de chaque équipe d'éliminés
  // depuis leur élimination jusqu'à la fin de saison (= R5 inclus = round
  // marqué teamFinalRound: true ou le dernier round figé).
  const seasonStart = seasonRounds[0].dates?.start || seasonRounds[0].startDate;
  const seasonEnd = seasonRounds[seasonRounds.length - 1].dates?.end ||
                    seasonRounds[seasonRounds.length - 1].endDate;

  const leagueId = options.leagueId || CHALLENGE_CONFIG.leagueId;
  const allActivities = await loadLeagueActivities(leagueId);

  // Pour chaque équipe éliminée, calculer son D+ cumulé depuis l'élimination
  // jusqu'à la fin de saison.
  const eliminatedTeamsData = []; // [{ animal, color, eliminatedRound, members: [{id,name,elev,acts}] }]
  for (const round of seasonRounds) {
    if (!round.eliminatedTeam || round.isFinaleEliminated) continue;
    const team = round.eliminatedTeam;
    const elimEnd = round.dates?.end || round.endDate;
    const elimEndDate = new Date(elimEnd);
    const startMs = elimEndDate.getTime() + 1; // début de la fenêtre = juste après le round d'élimination

    const seasonEndDate = new Date(seasonEnd);
    const endMs = seasonEndDate.getTime();

    const members = team.members.map(m => {
      const acts = allActivities.filter(a => {
        if (String(a.athlete?.id || a.athlete_id) !== String(m.id)) return false;
        if (a.excluded) return false;
        const sport = a.sport_type || a.type;
        if (!isValidSport(sport)) return false;
        const start = new Date(a.start_date).getTime();
        const elapsedMs = (a.elapsed_time || 0) * 1000;
        const t = start + elapsedMs;
        return t >= startMs && t <= endMs;
      });
      const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
      return {
        id: String(m.id),
        name: m.name,
        elevation: Math.round(elev),
        activitiesCount: acts.length,
        rawElevation: Math.round(elev)
      };
    }).sort((a, b) => b.elevation - a.elevation);

    eliminatedTeamsData.push({
      animal: team.animal,
      color: team.color,
      eliminatedRound: round.roundNumber,
      eliminatedRoundInSeason: round.roundInSeason,
      members,
      totalElevation: members.reduce((s, m) => s + m.elevation, 0)
    });
  }

  // Les équipes finalistes (toutes éliminées au R(N-1)) :
  // Comme TOUTES les équipes ont été éliminées en finale principale, le R5
  // est la fenêtre commune où elles concourent. On ajoute aussi les équipes
  // finalistes à eliminatedTeamsData. Mais leur composition n'est pas dans
  // round.eliminatedTeam (un seul team y est stocké). On la récupère depuis
  // round.teams[*] du round finale principale.
  const finalRound = seasonRounds.find(r => r.isFinalePrincipale);
  if (finalRound && Array.isArray(finalRound.teams)) {
    for (const t of finalRound.teams) {
      // Ne pas re-traiter eliminatedTeam déjà ajouté ci-dessus
      if (eliminatedTeamsData.find(et =>
        et.animal?.id === t.animal?.id &&
        et.eliminatedRound === finalRound.roundNumber)) continue;

      const elimEnd = finalRound.dates?.end || finalRound.endDate;
      const startMs = new Date(elimEnd).getTime() + 1;
      const endMs = new Date(seasonEnd).getTime();

      const members = t.members.map(m => {
        const acts = allActivities.filter(a => {
          if (String(a.athlete?.id || a.athlete_id) !== String(m.id)) return false;
          if (a.excluded) return false;
          const sport = a.sport_type || a.type;
          if (!isValidSport(sport)) return false;
          const start = new Date(a.start_date).getTime();
          const elapsedMs = (a.elapsed_time || 0) * 1000;
          const at = start + elapsedMs;
          return at >= startMs && at <= endMs;
        });
        const elev = acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);
        return {
          id: String(m.id),
          name: m.name,
          elevation: Math.round(elev),
          activitiesCount: acts.length,
          rawElevation: Math.round(elev)
        };
      }).sort((a, b) => b.elevation - a.elevation);

      eliminatedTeamsData.push({
        animal: t.animal,
        color: t.color,
        eliminatedRound: finalRound.roundNumber,
        eliminatedRoundInSeason: finalRound.roundInSeason,
        members,
        totalElevation: members.reduce((s, m) => s + m.elevation, 0)
      });
    }
  }

  // Trier les équipes par D+ total cumulé décroissant (la 1ère = meilleure équipe d'éliminés)
  eliminatedTeamsData.sort((a, b) => b.totalElevation - a.totalElevation);

  // Construire le ranking individuel selon le barème team éliminés
  const ranking = [];
  let position = 1;
  eliminatedTeamsData.forEach((team, teamIdx) => {
    const teamRank = teamIdx + 1; // 1 = meilleure
    team.members.forEach((m, posInTeam) => {
      const positionInTeam = posInTeam + 1; // 1 = meilleur contributeur de l'équipe
      const points = getTeamEliminatedPoints(teamRank, positionInTeam);
      ranking.push({
        participant: { id: m.id, name: m.name },
        id: m.id,
        name: m.name,
        teamRank,
        teamAnimal: team.animal,
        teamColor: team.color,
        positionInTeam,
        position: position++,
        totalElevation: m.elevation,
        rawElevation: m.rawElevation,
        activityCount: m.activitiesCount,
        eliminatedRound: team.eliminatedRound,
        eliminatedRoundInSeason: team.eliminatedRoundInSeason,
        points,
        bonusEffects: { gained: 0, lost: 0, details: [] }
      });
    });
  });

  // Pas d'archive de bonus saisonniers pour l'instant (commit B/C)
  // [TODO commit B : intégrer bonus saisonniers en team season]
  data.eliminatedChallengeRankings[String(seasonNumber)] = {
    frozenAt: new Date().toISOString(),
    seasonNumber,
    seasonType: 'team',
    ranking,
    teams: eliminatedTeamsData,
    bonusesCount: 0
  };

  data.lastUpdated = new Date().toISOString();
  await saveFrozenResults(data);

  console.log(`🏔️ Challenge éliminés saison ${seasonNumber} (TEAM) figé : ${ranking.length} athlète(s) répartis en ${eliminatedTeamsData.length} équipes`);

  return {
    success: true,
    seasonNumber,
    seasonType: 'team',
    ranking,
    teams: eliminatedTeamsData,
    archivedBonuses: 0,
    purgeLog: { expiredBonuses: [], purgedPendingChoices: [] },
    frozenAt: data.eliminatedChallengeRankings[String(seasonNumber)].frozenAt
  };
}

/**
 * Calcule et fige le classement final du challenge des éliminés pour une saison.
 * Cette fonction est appelée à la fin d'une saison (finale figée).
 * Les saisons team sont déléguées à freezeTeamEliminatedChallengeForSeason.
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

  // BRANCHING SAISON TEAM
  if (isTeamSeason(seasonNumber)) {
    return freezeTeamEliminatedChallengeForSeason(seasonNumber, options);
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
  getRoundInSeason,
  // Accès brut pour persister des champs additionnels (yearlyStandingsSnapshot, etc.)
  loadFrozenResultsRaw: loadFrozenResults,
  saveFrozenResultsRaw: saveFrozenResults
};