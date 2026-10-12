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
const { DATA_DIR } = require('./data-dir');
const { CHALLENGE_CONFIG } = require('./shared-config');

/**
 * Contexte d'une édition dont les données sont rangées dans `dataDir`, avec la
 * même arborescence que backend/data/ aujourd'hui.
 */
function createEditionContext({ leagueId, editionId = null, dataDir, config }) {
  return Object.freeze({
    leagueId,
    editionId,
    config,
    paths: Object.freeze({
      frozen: path.join(dataDir, 'frozen_results.json'),
      bonuses: path.join(dataDir, 'bonuses.json'),
      jokers: path.join(dataDir, 'jokers_usage.json'),
      pendingBonusChoices: path.join(dataDir, 'pending_bonus_choices.json'),
      seasonTeams: path.join(dataDir, 'season_teams.json'),
      roundConfigs: path.join(dataDir, 'round_configs.json'),
      activities: id => path.join(dataDir, 'leagues', `${id}_activities.json`)
    })
  });
}

// versant-2026 tel qu'aujourd'hui : backend/data/ (ou VERSANT_DATA_DIR) et la
// config partagée, même objet (même identité, mêmes consommateurs).
const LEGACY_CONTEXT = createEditionContext({
  leagueId: CHALLENGE_CONFIG.leagueId,
  dataDir: DATA_DIR,
  config: CHALLENGE_CONFIG
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
