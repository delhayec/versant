/**
 * ============================================
 * VERSANT - HARNAIS : PARTIE C — API DU SERVEUR
 * ============================================
 * Démarre le vrai backend/server.js sur une copie de la fixture, sans tâches
 * planifiées ni accès réseau (variables d'environnement du livrable L01), et
 * capture les réponses de ses routes en lecture : publiques, joueur (une
 * session par athlète) et admin.
 *
 * Uniquement des GET : aucune route n'écrit dans le bac à sable. Les routes
 * d'écriture seront testées par scénarios dans les livrables qui les touchent.
 *
 * Nécessite backend/node_modules (npm install) et un code postérieur à L01 :
 * sur un code plus ancien, la partie C est sautée (démarrer le serveur sans
 * VERSANT_DISABLE_JOBS lancerait le rattrapage du gel et la synchro Strava).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './canonical.mjs';
import { frozenRoundEnds, loadFixture } from './fixture.mjs';

const ADMIN_PASSWORD = 'harnais-admin';
const UNREACHABLE = 'http://127.0.0.1:9';
const MAX_INLINE_BYTES = 256 * 1024;

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

  // Une session par athlète, pour interroger les routes joueur
  const athletes = fixture.json('athletes.json');
  const sessions = athletes.map(a => ({
    token: `harnais-${a.id}`,
    athlete_id: String(a.id),
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2099-12-31T23:59:59.000Z'
  }));
  writeFileSync(join(sandbox, 'sessions.json'), JSON.stringify(sessions, null, 2));

  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      VERSANT_DATA_DIR: sandbox,
      VERSANT_DISABLE_JOBS: '1',
      STRAVA_API_BASE: UNREACHABLE,
      OPEN_METEO_URL: UNREACHABLE,
      PORT: String(port),
      ADMIN_PASSWORD,
      STRAVA_CLIENT_ID: 'harnais-client',
      STRAVA_CLIENT_SECRET: 'harnais-secret',
      TZ: 'Europe/Paris'
    }
  });
  child.stdout.on('data', d => logs.push(...String(d).split('\n').filter(Boolean).map(l => `[api] ${l}`)));
  child.stderr.on('data', d => logs.push(...String(d).split('\n').filter(Boolean).map(l => `[api] ${l}`)));

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitUntilUp(base, child);

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
      `/api/athletes/ligue-inexistante`,
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
    for (const a of athletes) {
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
      '/api/admin/athletes/download'
    ]) {
      responses[`GET ${path} (admin)`] = await call(base, path, admin);
    }
    responses['GET /api/admin/jokers (mauvais mot de passe)'] = await call(base, '/api/admin/jokers', { 'x-admin-password': 'faux' });

    return { result: { responses }, logs };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill();
      await exited;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function call(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { texte: text };
  }
  for (const [prefix, keys] of Object.entries(VOLATILE)) {
    if (path.startsWith(prefix) && body && typeof body === 'object') {
      for (const k of keys) if (k in body) body[k] = '(variable)';
    }
  }
  const canonical = JSON.stringify(canonicalize(body));
  if (canonical.length > MAX_INLINE_BYTES) {
    // Réponse volumineuse : empreinte plutôt que contenu (le détail se compare à la main)
    return {
      status: res.status,
      taille: canonical.length,
      sha256: createHash('sha256').update(canonical).digest('hex'),
      elements: Array.isArray(body) ? body.length : Object.keys(body).length
    };
  }
  return { status: res.status, body };
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
    const srv = createServer();
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
