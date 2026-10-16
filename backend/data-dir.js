/**
 * ============================================
 * VERSANT - DOSSIER DES DONNÉES
 * ============================================
 * Par défaut backend/data/. La variable VERSANT_DATA_DIR permet de faire tourner
 * une copie du serveur sur un autre jeu de données (bac à sable du harnais de
 * non-régression) sans jamais toucher aux données de prod. À ne pas définir en
 * production.
 *
 * Organisation des données (VERSANT_STORE_LAYOUT, cf. store/index.js) :
 * - legacy (défaut) : fichiers de l'édition à la racine de DATA_DIR ;
 * - editions (L32) : fichiers de l'édition dans leagues/<ligue>/editions/<édition>/,
 *   créés par scripts/migrate-editions.js.
 */

const path = require('path');

const DATA_DIR = process.env.VERSANT_DATA_DIR
  ? path.resolve(process.env.VERSANT_DATA_DIR)
  : path.join(__dirname, 'data');

const STORE_LAYOUT = process.env.VERSANT_STORE_LAYOUT || 'legacy';

// Édition servie par défaut (routes actuelles, crons) : versant / 2026
const DEFAULT_EDITION = Object.freeze({ leagueId: 'versant', editionId: '2026', legacyId: 'versant-2026' });

const DEFAULT_EDITION_DIR = STORE_LAYOUT === 'editions'
  ? path.join(DATA_DIR, 'leagues', DEFAULT_EDITION.leagueId, 'editions', DEFAULT_EDITION.editionId)
  : DATA_DIR;

module.exports = { DATA_DIR, STORE_LAYOUT, DEFAULT_EDITION, DEFAULT_EDITION_DIR };
