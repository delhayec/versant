/**
 * ============================================
 * VERSANT - HARNAIS : PARTIE C — API DU SERVEUR
 * ============================================
 * Démarre le vrai backend/server.js sur une copie de la fixture, sans tâches
 * planifiées (variables d'environnement du livrable L01), avec un faux Strava
 * local, puis :
 *   1. capture les réponses de ses routes en lecture : publiques, joueur (une
 *      session par athlète) et admin ;
 *   2. passe des « sondes de sécurité » : requêtes qu'un attaquant pourrait
 *      envoyer, pour constater ce que le serveur accepte ou refuse.
 *
 * Le bac à sable reçoit des identifiants FACTICES (la fixture n'en contient
 * aucun) : un e-mail et un mot de passe connus par athlète, et un faux token
 * Strava pour l'athlète de la dernière activité. Le serveur est lancé depuis
 * le dossier du bac à sable : le .env du développeur n'est pas lu.
 *
 * Nécessite backend/node_modules (npm install) et un code postérieur à L01 :
 * sur un code plus ancien, la partie C est sautée (démarrer le serveur sans
 * VERSANT_DISABLE_JOBS lancerait le rattrapage du gel et la synchro Strava).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './canonical.mjs';
import { frozenRoundEnds, loadFixture } from './fixture.mjs';

const ADMIN_PASSWORD = 'harnais-admin';
const UNREACHABLE = 'http://127.0.0.1:9';
const MAX_INLINE_BYTES = 256 * 1024;
const SUBSCRIPTION_ID = 424242;
const FAKE_TOKEN = 'jeton-factice-harnais';

// Champs qui dépendent de l'instant ou du système de fichiers, pas du code
const VOLATILE = {
  '/api/activities-status/': ['lastModified'],
  '/api/admin/diagnostic': ['timestamp']
};

export async function runApi({ repoRoot, fixtureDir }) {
  const backendDir = join(repoRoot, 'backend');
  const serverSource = readFileSync(join(backendDir, 'server.js'), 'utf8');
  if (!existsSync(join(backendDir, 'data-dir.js')) || !serverSource.includes('VERSANT_DISABLE_JOBS')) {
    return { result: 'non applicable : code antérieur à L01 (pas de mode bac à sable)', logs: [] };
  }
  if (!existsSync(join(backendDir, 'node_modules', 'express'))) {
    throw new Error(`Partie C : dépendances absentes, lancer « npm install » dans ${backendDir}`);
  }

  const fixture = loadFixture(fixtureDir);
  const leagueId = fixture.meta.leagueId;
  const sandbox = mkdtempSync(join(tmpdir(), 'versant-api-'));
  cpSync(fixture.dataDir, sandbox, { recursive: true });

  const plan = preparePlan(fixture);
  writeCredentials(sandbox, fixture, plan);

  const logs = [];
  const strava = await startFakeStrava(plan);
  let server = null;

  try {
    server = await startServer({ backendDir, sandbox, logs, stravaBase: strava.base, adminPassword: ADMIN_PASSWORD });
    const responses = await captureReadRoutes(server.base, fixture, leagueId, plan);
    const probes = await runProbes(server.base, leagueId, plan, sandbox);
    await server.stop();
    server = null;

    // Mot de passe admin par défaut : serveur relancé SANS ADMIN_PASSWORD
    const bare = await startServer({ backendDir, sandbox, logs, stravaBase: strava.base, adminPassword: null });
    try {
      probes['admin-mot-de-passe-par-defaut'] = {
        avecAdmin123: (await call(bare.base, '/api/admin/jokers', { 'x-admin-password': 'admin123' }, { summary: true })).status,
        sansMotDePasse: (await call(bare.base, '/api/admin/jokers', {}, { summary: true })).status
      };
    } finally {
      await bare.stop();
    }

    return { result: { responses, probes }, logs };
  } finally {
    if (server) await server.stop();
    await strava.stop();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Activités et athlètes utilisés par les sondes, choisis de façon stable dans la fixture. */
function preparePlan(fixture) {
  const activities = fixture.json(fixture.activitiesFile);
  const ownerOf = a => String(a.athlete_id ?? a.athlete?.id);
  const owner = ownerOf(activities[activities.length - 1]);
  const ofOwner = activities.filter(a => ownerOf(a) === owner);
  const others = [...activities].reverse().filter(a => ownerOf(a) !== owner);
  return {
    owner,                                              // athlète muni d'un faux token Strava
    fakeDelete: ofOwner[ofOwner.length - 1].id,         // existe encore sur Strava
    realDelete: ofOwner[ofOwner.length - 2].id,         // supprimée sur Strava
    fakeDeleteGoodSub: ofOwner[ofOwner.length - 3].id,  // existe encore sur Strava
    otherOwnerActivity: others[0].id,                   // appartient à un autre athlète
    otherOwnerUpdate: others[1].id,                     // appartient à un autre athlète
    foreignAthlete: ownerOf(others[0]),
    foreignNewActivity: 99999999901,                    // inconnue en local, appartient à un autre athlète sur Strava
    deletedOnStrava: new Set([ofOwner[ofOwner.length - 2].id, others[0].id].map(String)),
    // Snapshot réellement envoyé par un navigateur (présent dans la fixture)
    legitSnapshot: fixture.json('frozen_results.json').yearlyStandingsSnapshot?.standings || []
  };
}

function credentialsOf(id) {
  return { email: `harnais-${id}@exemple.test`, password: `harnais-${id}` };
}

/** Identifiants factices et sessions, dans la copie du bac à sable uniquement. */
function writeCredentials(sandbox, fixture, plan) {
  const athletes = fixture.json('athletes.json').map(a => {
    const { email, password } = credentialsOf(a.id);
    const out = { ...a, email, password_hash: createHash('sha256').update(password).digest('hex') };
    if (String(a.id) === plan.owner) {
      out.tokens = { access_token: FAKE_TOKEN, refresh_token: FAKE_TOKEN, expires_at: 4102444800 };
    }
    return out;
  });
  writeFileSync(join(sandbox, 'athletes.json'), JSON.stringify(athletes, null, 2));

  const sessions = athletes.map(a => ({
    token: `harnais-${a.id}`,
    athlete_id: String(a.id),
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-12-31T23:59:59.000Z'
  }));
  writeFileSync(join(sandbox, 'sessions.json'), JSON.stringify(sessions, null, 2));
}

async function captureReadRoutes(base, fixture, leagueId, plan) {
  const frozen = fixture.json('frozen_results.json');
  const ends = frozenRoundEnds(frozen);
  const lastRound = ends.length ? ends[ends.length - 1].round : 0;
  const rounds = range(1, lastRound + 2);
  const seasons = [...new Set(ends.map(e => e.season))].sort((a, b) => a - b);
  const teamRounds = Object.entries(frozen.rounds || {})
    .filter(([, r]) => r?.seasonType === 'team' || r?.isTeamSeasonRound)
    .map(([k]) => Number(k));

  const routes = [
    '/api/config',
    '/api/strava-client-id',
    '/api/special-rules',
    '/api/round-configs',
    `/api/athletes/${leagueId}`,
    '/api/athletes/ligue-inexistante',
    `/api/activities/${leagueId}`,
    `/api/activities-status/${leagueId}`,
    `/api/weather-coverage/${leagueId}`,
    '/api/jokers/all',
    ...rounds.map(r => `/api/jokers/round/${r}`),
    '/api/frozen-results',
    ...rounds.map(r => `/api/frozen-results/round/${r}`),
    ...rounds.map(r => `/api/frozen-results/check/${r}`),
    `/api/frozen-results/standings/${leagueId}`,
    ...seasons.map(s => `/api/season-bonuses/${s}`),
    ...[...teamRounds, lastRound + 1].map(r => `/api/teams/round/${r}`),
    '/api/bonuses/all',
    '/api/bonuses/active',
    // Sans session : doit être refusé
    '/api/jokers/my',
    '/api/bonuses/my'
  ];

  const responses = {};
  for (const path of routes) responses[`GET ${path}`] = await call(base, path);

  // Routes joueur, une fois par athlète
  for (const a of fixture.json('athletes.json')) {
    const headers = { Authorization: `Bearer harnais-${a.id}` };
    for (const path of ['/api/jokers/my', '/api/bonuses/my', '/api/bonuses/choices']) {
      responses[`GET ${path} (athlète ${a.id})`] = await call(base, path, headers);
    }
  }

  // Routes admin en lecture
  const admin = { 'x-admin-password': ADMIN_PASSWORD };
  for (const path of [
    '/api/admin/jokers',
    `/api/admin/jokers/${leagueId}`,
    '/api/admin/jokers/download',
    '/api/admin/bonuses',
    '/api/admin/diagnostic',
    '/api/admin/webhooks/log',
    '/api/admin/webhooks/failed',
    '/api/admin/athletes/download',
    `/api/admin/athletes/${leagueId}`
  ]) {
    responses[`GET ${path} (admin)`] = await call(base, path, admin);
  }
  responses['GET /api/admin/jokers (mauvais mot de passe)'] = await call(base, '/api/admin/jokers', { 'x-admin-password': 'faux' });
  return responses;
}

/**
 * Sondes de sécurité, dans un ordre fixe, sur le même bac à sable.
 * Chaque sonde rapporte ce que le serveur a accepté ou refusé.
 */
async function runProbes(base, leagueId, plan, sandbox) {
  const admin = { 'x-admin-password': ADMIN_PASSWORD };
  const probes = {};

  // Webhook GitHub. NE JAMAIS envoyer une ref contenant « master » : l'ancien
  // code lancerait git pull + npm install + pm2 restart dans le dépôt testé.
  probes['webhook-github'] = await call(base, '/api/webhook/github', { 'x-github-event': 'push' }, {
    method: 'POST',
    body: { ref: 'refs/heads/sonde-harnais' }
  });

  // Webhook Strava : suppressions
  const deleteProbe = async (name, objectId, subscriptionId, ownerId = plan.owner) => {
    const posted = await call(base, '/api/webhook/strava', {}, {
      method: 'POST',
      body: {
        object_type: 'activity',
        aspect_type: 'delete',
        owner_id: Number(ownerId),
        object_id: Number(objectId),
        subscription_id: subscriptionId,
        event_time: 1790000000
      }
    });
    const logEntry = await waitForWebhookLog(base, admin, objectId);
    probes[name] = {
      reponse: posted.status,
      journal: logEntry ? { status: logEntry.status, details: logEntry.details ?? null } : '(aucune entrée)',
      activiteToujoursPresente: await activityExists(base, leagueId, objectId)
    };
  };
  await deleteProbe('strava-suppression-forgee', plan.fakeDelete, 999999);
  await deleteProbe('strava-suppression-reelle', plan.realDelete, SUBSCRIPTION_ID);
  await deleteProbe('strava-suppression-autre-athlete', plan.otherOwnerActivity, SUBSCRIPTION_ID);
  // Bon abonnement, mais l'activité existe toujours sur Strava : seule la
  // vérification auprès de Strava peut la protéger.
  await deleteProbe('strava-suppression-forgee-bon-abonnement', plan.fakeDeleteGoodSub, SUBSCRIPTION_ID);

  // Webhook Strava : mise à jour et création visant l'activité d'un autre athlète
  const webhookProbe = async (aspectType, objectId) => {
    const posted = await call(base, '/api/webhook/strava', {}, {
      method: 'POST',
      body: {
        object_type: 'activity',
        aspect_type: aspectType,
        owner_id: Number(plan.owner),
        object_id: Number(objectId),
        subscription_id: SUBSCRIPTION_ID,
        updates: aspectType === 'update' ? { title: 'Sonde harnais' } : {},
        event_time: 1790000000
      }
    });
    const logEntry = await waitForWebhookLog(base, admin, objectId);
    const activities = (await call(base, `/api/activities/${leagueId}`, {}, { raw: true })).body;
    const local = Array.isArray(activities) ? activities.find(a => String(a.id) === String(objectId)) : null;
    return {
      reponse: posted.status,
      journal: logEntry ? { status: logEntry.status, details: logEntry.details ?? null } : '(aucune entrée)',
      proprietaireEnLocal: local ? String(local.athlete_id ?? local.athlete?.id) : '(absente)'
    };
  };
  probes['strava-mise-a-jour-autre-athlete'] = await webhookProbe('update', plan.otherOwnerUpdate);
  probes['strava-creation-activite-d-un-autre'] = await webhookProbe('create', plan.foreignNewActivity);

  // Snapshot légitime : il doit toujours être accepté
  probes['snapshot-legitime'] = {
    reponse: (await call(base, '/api/standings/snapshot', {}, {
      method: 'POST',
      body: { standings: plan.legitSnapshot },
      summary: true
    })).status
  };

  // Snapshot de classement falsifié
  const snapshot = await call(base, '/api/standings/snapshot', {}, {
    method: 'POST',
    body: { standings: [{ id: '999999', name: 'Intrus', totalPoints: 9999 }] },
    summary: true
  });
  const frozenAfter = (await call(base, '/api/frozen-results', {}, { raw: true })).body;
  probes['snapshot-falsifie'] = {
    reponse: snapshot.status,
    intrusEnregistre: (frozenAfter?.yearlyStandingsSnapshot?.standings || []).some(s => String(s.id) === '999999')
  };

  // Connexion avec les identifiants factices, puis format du hash stocké
  const { email, password } = credentialsOf(plan.owner);
  const ok = await call(base, '/api/auth/login', {}, { method: 'POST', body: { email, password } });
  const ko = await call(base, '/api/auth/login', {}, { method: 'POST', body: { email, password: 'mauvais' } });
  const stored = JSON.parse(readFileSync(join(sandbox, 'athletes.json'), 'utf8')).find(a => String(a.id) === plan.owner);
  probes['connexion'] = {
    bonMotDePasse: { status: ok.status, jetonRecu: typeof ok.body?.token === 'string', athlete: ok.body?.athlete ?? null },
    mauvaisMotDePasse: ko.status,
    champsDuCompte: Object.keys(stored || {}).filter(k => /pass|scrypt/i.test(k)).sort()
  };

  // Synchro Strava déclenchée sans authentification
  probes['synchro-sans-authentification'] = await call(base, `/api/sync/${leagueId}`, {}, {
    method: 'POST',
    body: { startDate: '2026-10-02', endDate: '2026-10-03' }
  });

  return probes;
}

async function waitForWebhookLog(base, admin, objectId) {
  for (let i = 0; i < 80; i++) {
    const res = await call(base, '/api/admin/webhooks/log', admin, { raw: true });
    const entry = (res.body?.logs || []).find(l => String(l.object_id) === String(objectId));
    if (entry) return entry;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function activityExists(base, leagueId, objectId) {
  const res = await call(base, `/api/activities/${leagueId}`, {}, { raw: true });
  return Array.isArray(res.body) && res.body.some(a => String(a.id) === String(objectId));
}

async function call(base, path, headers = {}, { method = 'GET', body, raw = false, summary = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { texte: text };
  }
  if (raw) return { status: res.status, body: parsed };
  if (summary) return { status: res.status };

  for (const [prefix, keys] of Object.entries(VOLATILE)) {
    if (path.startsWith(prefix) && parsed && typeof parsed === 'object') {
      for (const k of keys) if (k in parsed) parsed[k] = '(variable)';
    }
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') parsed.token = '(jeton)';

  const canonical = JSON.stringify(canonicalize(parsed));
  if (canonical.length > MAX_INLINE_BYTES) {
    // Réponse volumineuse : empreinte plutôt que contenu (le détail se compare à la main)
    return {
      status: res.status,
      taille: canonical.length,
      sha256: createHash('sha256').update(canonical).digest('hex'),
      elements: Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length
    };
  }
  return { status: res.status, body: parsed };
}

/** Démarre server.js depuis le dossier du bac à sable (le .env du développeur n'est pas lu). */
async function startServer({ backendDir, sandbox, logs, stravaBase, adminPassword }) {
  const port = await freePort();
  const env = {
    ...process.env,
    VERSANT_DATA_DIR: sandbox,
    VERSANT_DISABLE_JOBS: '1',
    STRAVA_API_BASE: stravaBase,
    STRAVA_SUBSCRIPTION_ID: String(SUBSCRIPTION_ID),
    OPEN_METEO_URL: UNREACHABLE,
    PORT: String(port),
    STRAVA_CLIENT_ID: 'harnais-client',
    STRAVA_CLIENT_SECRET: 'harnais-secret',
    TZ: 'Europe/Paris'
  };
  if (adminPassword) env.ADMIN_PASSWORD = adminPassword;
  else delete env.ADMIN_PASSWORD;

  const child = spawn(process.execPath, [join(backendDir, 'server.js')], { cwd: sandbox, env });
  const tag = adminPassword ? '[api]' : '[api sans ADMIN_PASSWORD]';
  child.stdout.on('data', d => logs.push(...String(d).split('\n').filter(Boolean).map(l => `${tag} ${l}`)));
  child.stderr.on('data', d => logs.push(...String(d).split('\n').filter(Boolean).map(l => `${tag} ${l}`)));

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill();
      await exited;
    }
  };
  try {
    await waitUntilUp(base, child);
  } catch (error) {
    await stop();
    throw error;
  }
  return { base, stop };
}

/**
 * Faux Strava : répond aux seuls appels utiles aux sondes.
 * Une activité de `deletedOnStrava` répond 404, toute autre existe.
 */
async function startFakeStrava(plan) {
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const activity = /^\/api\/v3\/activities\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && activity) {
      if (plan.deletedOnStrava.has(activity[1])) return send(404, { message: 'Record Not Found' });
      if (activity[1] === String(plan.foreignNewActivity)) {
        return send(200, {
          id: plan.foreignNewActivity,
          athlete: { id: Number(plan.foreignAthlete) },
          name: 'Activité d\'un autre athlète',
          type: 'Run',
          sport_type: 'Run',
          distance: 10000,
          moving_time: 3600,
          elapsed_time: 3600,
          total_elevation_gain: 123,
          start_date: '2026-10-03T08:00:00Z',
          start_date_local: '2026-10-03T10:00:00Z'
        });
      }
      return send(200, { id: Number(activity[1]), name: 'Activité toujours sur Strava' });
    }
    if (req.method === 'GET' && url.pathname === '/api/v3/athlete/activities') return send(200, []);
    if (req.method === 'GET' && url.pathname === '/api/v3/push_subscriptions') {
      return send(200, [{ id: SUBSCRIPTION_ID, callback_url: 'https://versant-app.fr/api/webhook/strava' }]);
    }
    return send(404, { message: 'faux Strava : appel non prévu' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise(r => server.close(r))
  };
}

async function waitUntilUp(base, child) {
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (let i = 0; i < 150; i++) {
    if (exited) throw new Error('Partie C : le serveur s\'est arrêté au démarrage (voir le journal)');
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Partie C : le serveur ne répond pas après 15 s');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

