#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - HARNAIS DE NON-RÉGRESSION : CAPTURE
 * ============================================
 * Calcule, sur une fixture, tout ce que le code produit pour les joueurs, et
 * l'écrit sous forme canonique (clés triées) pour comparaison avec compare.mjs.
 *
 * Utilisation :
 *   node backend/scripts/regression/snapshot.mjs --fixture <dossier> --out <fichier.json>
 *     [--parts front,back,api]             # A (moteur front), B (gel serveur), C (API)
 *     [--at capturedAt,lastFrozenEnd]      # dates de calcul : préréglages ou dates ISO
 *     [--repo <racine du code testé>]      # par défaut : ce dépôt
 *
 * Chaque calcul tourne dans un processus séparé (état des modules vierge),
 * en Europe/Paris, avec une horloge figée et un hasard à graine fixe.
 * Le résultat ne dépend donc que du code testé et de la fixture.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, stableStringify } from './lib/canonical.mjs';
import { frozenRoundEnds, loadFixture } from './lib/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPO = resolve(HERE, '..', '..', '..');
const TIME_ZONE = 'Europe/Paris';

// Variables du bac à sable (L01) : elles ne doivent jamais fuiter dans les
// calculs A et B, qui construisent leur propre bac à sable.
const SANDBOX_ENV = ['VERSANT_DATA_DIR', 'VERSANT_DISABLE_JOBS', 'STRAVA_API_BASE', 'OPEN_METEO_URL'];

const args = parseArgs(process.argv.slice(2));
try {
  if (args.worker) await runWorker(args);
  else await main(args);
} catch (error) {
  console.error(`❌ ${error?.stack || error}`);
  process.exit(1);
}

async function main(opts) {
  const fixtureDir = resolve(required(opts.fixture, '--fixture'));
  const outFile = resolve(required(opts.out, '--out'));
  const repoRoot = resolve(opts.repo || DEFAULT_REPO);
  const parts = String(opts.parts || 'front,back,api').split(',');

  const fixture = loadFixture(fixtureDir);
  const frozen = fixture.json('frozen_results.json');
  const ends = frozenRoundEnds(frozen);
  const presets = {
    capturedAt: fixture.meta.capturedAt,
    lastFrozenEnd: ends[ends.length - 1]?.end
  };
  const atList = String(opts.at || 'capturedAt,lastFrozenEnd').split(',').map(label => {
    const iso = presets[label] ?? label;
    if (Number.isNaN(Date.parse(iso))) throw new Error(`--at : date invalide « ${label} »`);
    return { label, iso: new Date(iso).toISOString() };
  });

  const started = Date.now();
  const workDir = mkdtempSync(join(tmpdir(), 'versant-capture-'));
  const logs = [];
  const output = {
    meta: {
      harnessFormat: 1,
      generatedAt: new Date().toISOString(),
      node: process.version,
      timeZone: TIME_ZONE,
      repo: { root: repoRoot, ...gitState(repoRoot) },
      fixture: { dir: fixtureDir, leagueId: fixture.meta.leagueId, capturedAt: fixture.meta.capturedAt, files: fixture.meta.files },
      at: atList
    },
    front: {},
    back: null,
    api: null
  };

  try {
    if (parts.includes('front')) {
      for (const { label, iso } of atList) {
        const { result, logs: workerLogs } = spawnWorker(workDir, 'front', { fixtureDir, repoRoot, at: iso, label });
        output.front[label] = result;
        logs.push(...workerLogs);
      }
    }
    if (parts.includes('back')) {
      const { result, logs: workerLogs } = spawnWorker(workDir, 'back', { fixtureDir, repoRoot, label: 'back' });
      output.back = result;
      logs.push(...workerLogs);
    }
    if (parts.includes('api')) {
      const { runApi } = await import('./lib/api.mjs');
      const { result, logs: apiLogs } = await runApi({ repoRoot, fixtureDir });
      output.api = canonicalize(result);
      logs.push(...apiLogs);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  output.checks = fidelityChecks(output, frozen);

  const text = stableStringify(output);
  writeFileSync(outFile, text);
  const logFile = outFile.replace(/\.json$/i, '') + '.log';
  writeFileSync(logFile, logs.join('\n') + '\n');

  printSummary(output, outFile, logFile, text, Date.now() - started);
}

function spawnWorker(workDir, kind, { fixtureDir, repoRoot, at, label }) {
  const outFile = join(workDir, `${kind}-${label}.json`);
  const workerArgs = [THIS_FILE, '--worker', kind, '--fixture', fixtureDir, '--repo', repoRoot, '--out', outFile];
  if (at) workerArgs.push('--at', at);
  const env = { ...process.env, TZ: TIME_ZONE };
  for (const name of SANDBOX_ENV) delete env[name];
  const res = spawnSync(process.execPath, workerArgs, {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.status !== 0) throw new Error(`Le calcul « ${kind} ${label} » a échoué (code ${res.status}).`);
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

async function runWorker(opts) {
  // Le fuseau doit être fixé avant toute création de date par le code testé.
  process.env.TZ = TIME_ZONE;
  const july = new Date(2026, 6, 1).getTimezoneOffset();
  const january = new Date(2026, 0, 1).getTimezoneOffset();
  if (july !== -120 || january !== -60) {
    throw new Error(`Fuseau horaire incorrect (décalages ${january}/${july} min) : Europe/Paris attendu.`);
  }

  const fixtureDir = resolve(required(opts.fixture, '--fixture'));
  const repoRoot = resolve(required(opts.repo, '--repo'));
  const outFile = resolve(required(opts.out, '--out'));

  let payload;
  if (opts.worker === 'front') {
    const { runFront } = await import('./lib/front.mjs');
    payload = await runFront({ repoRoot, fixtureDir, at: required(opts.at, '--at') });
  } else if (opts.worker === 'back') {
    const { runBack } = await import('./lib/back.mjs');
    payload = await runBack({ repoRoot, fixtureDir });
  } else {
    throw new Error(`Calcul inconnu : ${opts.worker}`);
  }

  writeFileSync(outFile, JSON.stringify({ result: canonicalize(payload.result), logs: payload.logs }));
}

/**
 * Contrôle de fidélité du harnais : à l'instant du snapshot envoyé par un vrai
 * navigateur (yearlyStandingsSnapshot), le classement recalculé doit être
 * identique. Un écart signale un défaut du harnais, pas du code testé.
 */
function fidelityChecks(output, frozen) {
  const snap = frozen.yearlyStandingsSnapshot;
  const front = output.front?.capturedAt;
  if (!snap?.standings || !front) return { navigatorSnapshot: 'non applicable' };

  const expected = snap.standings;
  const actual = front.snapshotCompact || [];
  const mismatches = [];
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    const e = expected[i];
    const a = actual[i];
    if (JSON.stringify(canonicalize(e)) !== JSON.stringify(canonicalize(a))) {
      mismatches.push({ index: i, expected: e ?? null, actual: a ?? null });
    }
  }
  return {
    navigatorSnapshot: {
      snapshotDate: snap.updatedAt,
      computedAt: front.at,
      players: expected.length,
      identical: mismatches.length === 0,
      mismatches
    }
  };
}

function printSummary(output, outFile, logFile, text, elapsedMs) {
  const sha = createHash('sha256').update(text).digest('hex');
  console.log(`✅ Capture écrite : ${outFile}`);
  console.log(`   empreinte sha256 ${sha.slice(0, 16)}… — ${(text.length / 1024).toFixed(0)} Ko — ${(elapsedMs / 1000).toFixed(1)} s`);
  console.log(`   code testé : ${output.meta.repo.commit ?? '?'}${output.meta.repo.dirty ? ' (avec modifications non commitées)' : ''}`);
  for (const [label, front] of Object.entries(output.front)) {
    const leader = front.index.finalStandings?.[0];
    console.log(`   A · ${label} (${front.at}) : saison ${front.context.currentSeasonNumber}, round ${front.context.currentRoundNumber}, ` +
      `${front.index.finalStandings.length} joueurs, 1er ${leader?.participant?.name ?? '?'} (${leader?.totalPoints ?? '?'} pts)`);
  }
  if (output.back) {
    const scenarios = Object.entries(output.back.scenarios);
    const failed = scenarios.filter(([, s]) => s.error);
    console.log(`   B · ${scenarios.length} scénarios de gel, dont ${failed.length} en erreur` +
      (failed.length ? ` (${failed.map(([name]) => name).join(', ')})` : ''));
  }
  if (output.api) {
    if (typeof output.api === 'string') {
      console.log(`   C · ${output.api}`);
    } else {
      const responses = Object.values(output.api.responses);
      const byStatus = responses.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
      console.log(`   C · ${responses.length} réponses d'API (${Object.entries(byStatus).map(([s, n]) => `${n}×${s}`).join(', ')})`);
    }
  }
  const check = output.checks.navigatorSnapshot;
  if (check && typeof check === 'object') {
    console.log(check.identical
      ? `   Fidélité : classement identique au snapshot navigateur du ${check.snapshotDate} (${check.players} joueurs)`
      : `   ⚠️ Fidélité : ${check.mismatches.length} écart(s) avec le snapshot navigateur du ${check.snapshotDate} — voir checks.navigatorSnapshot`);
  }
  console.log(`   journal : ${logFile}`);
}

function gitState(repoRoot) {
  const run = gitArgs => {
    const res = spawnSync('git', ['-C', repoRoot, ...gitArgs], { encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  const commit = run(['rev-parse', '--short', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=no']);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function required(value, name) {
  if (!value || value === true) throw new Error(`Option ${name} obligatoire`);
  return value;
}
