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

const { baseUrl, publicDir, at, edition, internalToken } = workerData;
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
  TeamFormation: require(join(publicDir, 'shared', 'team-formation.js')),
  // Règles des nouvelles éditions (L54)
  EditionRules: require(join(publicDir, 'shared', 'edition-rules.js'))
};
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

const realFetch = globalThis.fetch;
// Édition autre que celle par défaut (L33) : en-têtes internes, la requête est
// traitée par le serveur dans le contexte de cette édition
// Édition par défaut : jeton interne seul, exigé par les anciennes routes de lecture (L53)
const editionHeaders = edition
  ? { 'x-versant-edition': edition.key, 'x-versant-internal': edition.token }
  : (internalToken ? { 'x-versant-internal': internalToken } : {});
globalThis.fetch = (input, init = {}) => {
  let url = typeof input === 'string' ? input : input.url;
  // Identifiant « ligue/édition » inséré tel quel par le front dans les chemins
  // (/api/athletes/${leagueId}) : on l'encode pour qu'il reste un seul segment
  if (edition?.key.includes('/')) url = url.split(`/${edition.key}`).join(`/${encodeURIComponent(edition.key)}`);
  return realFetch(new URL(url, baseUrl), { ...init, headers: { ...(init.headers || {}), ...editionHeaders } });
};

const load = file => import(pathToFileURL(join(publicDir, 'js', file)).href);

try {
  const config = await load('config.js');
  const jokers = await load('jokers.js');
  const engine = await load('standings-engine.js');

  // Édition autre que celle par défaut (L33) : les constantes du front portent
  // les réglages de versant-2026 (identifiant, dates, planning par défaut avec
  // saisons en équipes). On applique ceux de l'édition avant tout calcul, sur
  // les mêmes objets ; son planning remplace entièrement celui par défaut
  // (applyEditionConfig, la même fonction que dans le navigateur, L50).
  if (edition) config.applyEditionConfig(await (await fetch('/api/config')).json());

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
