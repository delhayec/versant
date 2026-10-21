/**
 * ============================================
 * VERSANT - MOTEUR DE CLASSEMENT CÔTÉ SERVEUR
 * ============================================
 * Calcule le classement annuel avec le moteur du front (standings-engine.js),
 * exécuté dans un thread de travail (engine-worker.mjs). Remplace le snapshot
 * que chaque navigateur envoyait au serveur : le classement ne dépend plus du
 * code (éventuellement en cache) d'un navigateur.
 */

const path = require('path');
const { Worker } = require('node:worker_threads');

const WORKER_FILE = path.join(__dirname, 'engine-worker.mjs');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TIMEOUT_MS = 120000;

/**
 * @param {string} baseUrl - adresse de l'API du serveur (ex. http://127.0.0.1:3000)
 * @param {string} [at] - instant du calcul (ISO) ; par défaut maintenant
 * @param {Object} [edition] - { key, token } : édition autre que celle par défaut (L33)
 * @returns {Promise<{ at: string, standings: Array }>} sortie de calculateYearlyStandings
 */
function computeYearlyStandings({ baseUrl, at = null, edition = null }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, { workerData: { baseUrl, publicDir: PUBLIC_DIR, at, edition } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`moteur : pas de réponse après ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    worker.once('message', message => {
      clearTimeout(timer);
      worker.terminate();
      if (message.ok) resolve({ at: message.at, standings: message.standings });
      else reject(new Error(`moteur : ${message.error}`));
    });
    worker.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

module.exports = { computeYearlyStandings };
