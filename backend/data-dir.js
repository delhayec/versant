/**
 * ============================================
 * VERSANT - DOSSIER DES DONNÉES
 * ============================================
 * Par défaut backend/data/. La variable VERSANT_DATA_DIR permet de faire tourner
 * une copie du serveur sur un autre jeu de données (bac à sable du harnais de
 * non-régression) sans jamais toucher aux données de prod. À ne pas définir en
 * production.
 */

const path = require('path');

const DATA_DIR = process.env.VERSANT_DATA_DIR
  ? path.resolve(process.env.VERSANT_DATA_DIR)
  : path.join(__dirname, 'data');

module.exports = { DATA_DIR };
