/**
 * ============================================
 * VERSANT - MOTEUR DE CLASSEMENT CÔTÉ SERVEUR (thread de travail)
 * ============================================
 * Exécute le moteur du front (public/js/standings-engine.js) tel quel, dans un
 * thread séparé : ses globales de navigateur (window, fetch, localStorage) ne
 * touchent pas au processus du serveur.
 *
 * Le fetch du moteur interroge l'API du serveur lui-même (workerData.baseUrl) :
 * le moteur reçoit exactement les réponses qu'un navigateur recevrait, sans
 * recopie des traitements des routes.
 *
 * Séquence : celle d'app.js (init() puis renderAll()), jusqu'au calcul du
 * classement annuel envoyé jusqu'ici par le navigateur.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { baseUrl, publicDir, at } = workerData;
const require = createRequire(import.meta.url);

// Instant du calcul imposé (calcul « à une date », sans sauvegarde)
if (at) {
  const fixed = new Date(at).getTime();
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  globalThis.Date = FixedDate;
}

const memoryStorage = () => {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear()
  };
};

globalThis.window = {
  location: { pathname: '/index.html', search: '', href: `${baseUrl}/index.html` },
  TeamFormation: require(join(publicDir, 'shared', 'team-formation.js'))
};
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return realFetch(new URL(url, baseUrl), init);
};

const load = file => import(pathToFileURL(join(publicDir, 'js', file)).href);

try {
  const config = await load('config.js');
  const jokers = await load('jokers.js');
  const engine = await load('standings-engine.js');

  // ---- Chargement, dans l'ordre d'app.js init() ----
  await config.loadParticipants();
  const frozen = await (await fetch('/api/frozen-results')).json();
  const seasonBonusesCache = frozen.seasonBonuses || {};
  config.setFrozenCache(frozen);
  await config.loadSpecialRulesOverrides();
  const bonusesCache = await (await fetch('/api/bonuses/all')).json();
  await jokers.initializeJokersState();
  const rawActivities = await (await fetch(`/api/activities/${config.CHALLENGE_CONFIG.leagueId}`)).json();
  const allActivities = engine.parseActivitiesData(rawActivities);

  // ---- renderAll() : classement annuel (app.js:618) ----
  const today = new Date();
  const standings = engine.calculateYearlyStandings(allActivities, today, frozen, bonusesCache, seasonBonusesCache);

  parentPort.postMessage({ ok: true, at: today.toISOString(), standings: JSON.parse(JSON.stringify(standings)) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error) });
}
