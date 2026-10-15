/**
 * ============================================
 * VERSANT - COUCHE DE STOCKAGE
 * ============================================
 * Point d'accès unique aux éditions et aux activités. L'organisation des
 * fichiers est choisie par VERSANT_STORE_LAYOUT :
 * - legacy (défaut) : l'organisation actuelle (store/legacy.js) ;
 * - editions : la nouvelle (activités par utilisateur, dossier par édition),
 *   cf. store/editions.js ; données créées par scripts/migrate-editions.js.
 *
 * Les appelants travaillent toujours sur la « vue » des activités d'une ligue :
 * un tableau dans l'ordre d'ingestion, comme le fichier actuel. C'est
 * l'adaptateur qui sait où et comment la ranger.
 */

const { createLegacyStore } = require('./legacy');
const { createEditionsStore } = require('./editions');

const LAYOUTS = {
  legacy: createLegacyStore,
  editions: () => createEditionsStore()
};

function createStore(layout = process.env.VERSANT_STORE_LAYOUT || 'legacy') {
  const factory = LAYOUTS[layout];
  if (!factory) throw new Error(`VERSANT_STORE_LAYOUT inconnu : ${layout} (attendu : ${Object.keys(LAYOUTS).join(', ')})`);
  return factory();
}

let instance = null;

/** Stockage partagé par tout le processus. */
function getStore() {
  if (!instance) instance = createStore();
  return instance;
}

module.exports = { createStore, getStore };
