/**
 * ============================================
 * VERSANT - CONTEXTE D'ÉDITION
 * ============================================
 * Résout les entrées d'une édition (ligue + saison annuelle) : quels fichiers
 * lire et écrire, quelle config utiliser. L'identité de l'édition n'entre
 * jamais dans les calculs : elle ne sert qu'à trouver les données.
 *
 * Le contexte voyage avec l'appel asynchrone (AsyncLocalStorage) : un gel
 * lancé par withEdition(ctx, fn) lit et écrit les fichiers de ctx, même si un
 * autre gel tourne en parallèle. Hors de tout withEdition, c'est le contexte
 * « legacy » : exactement les fichiers et la config d'avant le multi-ligues.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const { DATA_DIR, DEFAULT_EDITION_DIR } = require('./data-dir');
const { CHALLENGE_CONFIG, LEGACY_PLANNING, loadEditionPlanning } = require('./shared-config');

/**
 * Contexte d'une édition dont les données sont rangées dans `dataDir`, avec la
 * même arborescence que backend/data/ aujourd'hui.
 * `planning` (types de saisons, échéances Deadline, durées de round) est lu
 * dans dataDir s'il n'est pas fourni ; il reste modifiable (admin).
 */
function createEditionContext({ leagueId, editionId = null, dataDir, config, planning = loadEditionPlanning(dataDir) }) {
  return Object.freeze({
    leagueId,
    editionId,
    config,
    planning,
    paths: Object.freeze({
      seasonPlanning: path.join(dataDir, 'season_planning.json'),
      frozen: path.join(dataDir, 'frozen_results.json'),
      bonuses: path.join(dataDir, 'bonuses.json'),
      jokers: path.join(dataDir, 'jokers_usage.json'),
      pendingBonusChoices: path.join(dataDir, 'pending_bonus_choices.json'),
      seasonTeams: path.join(dataDir, 'season_teams.json'),
      roundConfigs: path.join(dataDir, 'round_configs.json'),
      specialRules: path.join(dataDir, 'special_rules.json'),
      // Organisation legacy uniquement (store/legacy.js) : activités de la ligue
      activities: id => path.join(DATA_DIR, 'leagues', `${id}_activities.json`)
    })
  });
}

// Édition par défaut, versant-2026 : ses fichiers à la racine de backend/data/
// (organisation legacy) ou dans leagues/versant/editions/2026/ (organisation
// editions, L32), et la config partagée, même objet (même identité, mêmes
// consommateurs).
const LEGACY_CONTEXT = createEditionContext({
  leagueId: CHALLENGE_CONFIG.leagueId,
  dataDir: DEFAULT_EDITION_DIR,
  config: CHALLENGE_CONFIG,
  planning: LEGACY_PLANNING
});

const storage = new AsyncLocalStorage();

/** Contexte de l'appel en cours, ou le contexte legacy. */
function currentEdition() {
  return storage.getStore() || LEGACY_CONTEXT;
}

/** Exécute fn (synchrone ou asynchrone) dans le contexte ctx. */
function withEdition(ctx, fn) {
  return storage.run(ctx, fn);
}

module.exports = { createEditionContext, currentEdition, withEdition, LEGACY_CONTEXT };
