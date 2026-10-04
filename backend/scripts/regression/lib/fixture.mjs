/**
 * ============================================
 * VERSANT - HARNAIS : FIXTURE ET FAUSSE API
 * ============================================
 * Une fixture est une copie figée et anonymisée de backend/data/ (cf.
 * make-fixture.mjs). Ce module la charge et fournit un `fetch` simulé qui
 * rejoue les réponses des routes GET utilisées par le moteur.
 *
 * Fidélité : les transformations faites par le serveur (projection de
 * /api/athletes, fusion des jokers figés dans /api/jokers/all) ne sont pas
 * recopiées ; elles sont extraites de backend/server.js et exécutées.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileAsync, extractBetween, extractFunction, readSource } from './extract.mjs';

export const REQUIRED_FILES = [
  'athletes.json',
  'frozen_results.json',
  'bonuses.json',
  'jokers_usage.json',
  'pending_bonus_choices.json',
  'season_teams.json',
  'round_configs.json'
];

export const OPTIONAL_FILES = ['special_rules.json'];

export function activitiesPath(leagueId) {
  return join('leagues', `${leagueId}_activities.json`);
}

/** Charge la fixture : métadonnées + textes bruts des fichiers de données. */
export function loadFixture(fixtureDir) {
  const metaPath = join(fixtureDir, 'fixture.json');
  if (!existsSync(metaPath)) throw new Error(`fixture.json introuvable dans ${fixtureDir}`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const dataDir = join(fixtureDir, 'data');

  const raw = {};
  for (const file of REQUIRED_FILES) {
    const p = join(dataDir, file);
    if (!existsSync(p)) throw new Error(`Fixture incomplète : ${file} manquant`);
    raw[file] = readFileSync(p, 'utf8');
  }
  for (const file of OPTIONAL_FILES) {
    const p = join(dataDir, file);
    if (existsSync(p)) raw[file] = readFileSync(p, 'utf8');
  }
  const actFile = activitiesPath(meta.leagueId);
  raw[actFile] = readFileSync(join(dataDir, actFile), 'utf8');

  return {
    dir: fixtureDir,
    dataDir,
    meta,
    raw,
    activitiesFile: actFile,
    json: file => JSON.parse(raw[file])
  };
}

/** Fins des rounds figés de la fixture, triées par numéro de round (clé). */
export function frozenRoundEnds(frozen) {
  return Object.entries(frozen.rounds || {})
    .filter(([, r]) => r?.frozen && r.dates?.end)
    .map(([key, r]) => ({ round: Number(key), season: Number(r.seasonNumber), end: r.dates.end }))
    .sort((a, b) => a.round - b.round);
}

/**
 * Fonctions serveur extraites de backend/server.js, alimentées par la fixture.
 */
export function buildServerHandlers(fixture, repoRoot) {
  const file = 'backend/server.js';
  const server = readSource(join(repoRoot, file));

  const normalizeJokerUsage = compile(extractFunction(server, 'normalizeJokerUsage', file), 'normalizeJokerUsage');
  const readJokerUsage = compile(extractFunction(server, 'readJokerUsage', file), 'readJokerUsage', {
    safeReadJSON: async () => fixture.json('jokers_usage.json'),
    JOKERS_FILE: 'jokers_usage.json',
    normalizeJokerUsage
  });
  const readJokerUsageWithFrozen = compile(extractFunction(server, 'readJokerUsageWithFrozen', file), 'readJokerUsageWithFrozen', {
    readJokerUsage,
    frozenResults: { getAllFrozenResults: async () => fixture.json('frozen_results.json') }
  });

  // Corps de la route GET /api/athletes/:leagueId (lecture + projection)
  const routeMarker = "app.get('/api/athletes/:leagueId'";
  const routeEnd = 'res.json(leagueAthletes);';
  const route = extractBetween(server, routeMarker, routeEnd, file);
  const bodyStartMarker = 'const athletes = await safeReadJSON(ATHLETES_FILE, []);';
  const bodyStart = route.indexOf(bodyStartMarker);
  if (bodyStart < 0) throw new Error(`${file} : corps de la route /api/athletes/:leagueId introuvable`);
  const athletesRouteBody = route.slice(bodyStart, route.length - routeEnd.length);

  const listAthletes = leagueId => compileAsync(athletesRouteBody, 'leagueAthletes', {
    safeReadJSON: async () => fixture.json('athletes.json'),
    ATHLETES_FILE: 'athletes.json',
    req: { params: { leagueId } }
  });

  // Forme compacte stockée par POST /api/standings/snapshot
  const compactBlock = extractBetween(
    server,
    'const compact = standings.map(',
    ".filter(s => s.id && s.id !== 'undefined');",
    file
  );
  const compactSnapshot = standings => compile(compactBlock, 'compact', { standings });

  return { normalizeJokerUsage, readJokerUsage, readJokerUsageWithFrozen, listAthletes, compactSnapshot };
}

/**
 * fetch simulé. Chaque appel renvoie une copie neuve, comme une vraie requête.
 * Les URL non prévues répondent 404 et sont journalisées dans `calls`.
 */
export function createFakeFetch(fixture, handlers, calls) {
  const leagueId = fixture.meta.leagueId;

  const routes = [
    [/^\/api\/athletes\/([^/]+)$/, m => handlers.listAthletes(decodeURIComponent(m[1]))],
    [/^\/api\/activities\/([^/]+)$/, m => (decodeURIComponent(m[1]) === leagueId ? fixture.json(fixture.activitiesFile) : [])],
    [/^\/api\/frozen-results$/, () => fixture.json('frozen_results.json')],
    [/^\/api\/bonuses\/all$/, () => fixture.json('bonuses.json')],
    [/^\/api\/round-configs$/, () => fixture.json('round_configs.json')],
    [/^\/api\/special-rules$/, () => (fixture.raw['special_rules.json'] ? fixture.json('special_rules.json') : {})],
    [/^\/api\/jokers\/all$/, () => handlers.readJokerUsageWithFrozen()]
  ];

  return async function fakeFetch(input) {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    for (const [re, handler] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      const payload = JSON.stringify(await handler(m));
      calls.push({ path, status: 200 });
      return response(200, payload);
    }
    calls.push({ path, status: 404 });
    return response(404, JSON.stringify({ error: 'route non simulée par le harnais' }));
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => JSON.parse(body),
    text: async () => body
  };
}
