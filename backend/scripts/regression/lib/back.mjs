/**
 * ============================================
 * VERSANT - HARNAIS : PARTIE B — GEL CÔTÉ SERVEUR
 * ============================================
 * Copie backend/*.js et la fixture dans un dossier temporaire (le « bac à
 * sable »), puis exécute le code de gel réel :
 *   - regel de chaque round figé, isolément, dans une copie neuve des données ;
 *   - regel du challenge des éliminés de chaque saison terminée ;
 *   - les deux prochains gels nocturnes (autoFreezeCompletedRounds).
 *
 * But : comparer le code AVANT et APRÈS un livrable sur des entrées
 * identiques. On ne compare JAMAIS un regel aux données figées d'origine : les
 * règles ont changé entre les saisons, et l'embuscade est aléatoire.
 *
 * frozen-results.js calcule son dossier de données à partir de __dirname :
 * aucune modification du code testé n'est nécessaire.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalize, slim } from './canonical.mjs';
import { installFixedClock, setNow, RealDate } from './clock.mjs';
import { captureConsole } from './console.mjs';
import { buildServerHandlers, frozenRoundEnds, loadFixture } from './fixture.mjs';
import { restoreMathRandom, seedMathRandom } from './prng.mjs';

const WATCHED_FILES = ['bonuses.json', 'pending_bonus_choices.json'];

export async function runBack({ repoRoot, fixtureDir }) {
  const fixture = loadFixture(fixtureDir);
  const capturedAt = fixture.meta.capturedAt;
  installFixedClock(capturedAt);
  const leagueId = fixture.meta.leagueId;

  const root = mkdtempSync(join(tmpdir(), 'versant-bac-a-sable-'));
  const backendDir = join(root, 'backend');
  const dataDir = join(backendDir, 'data');
  const logs = captureConsole('back');

  try {
    mkdirSync(join(dataDir, 'leagues'), { recursive: true });
    mkdirSync(join(root, 'public', 'shared'), { recursive: true });
    for (const f of readdirSync(join(repoRoot, 'backend'))) {
      if (f.endsWith('.js')) copyFileSync(join(repoRoot, 'backend', f), join(backendDir, f));
    }
    copyFileSync(join(repoRoot, 'public', 'shared', 'team-formation.js'), join(root, 'public', 'shared', 'team-formation.js'));
    writeFileSync(join(root, 'package.json'), '{ "type": "commonjs" }\n');

    const resetData = () => {
      for (const [rel, text] of Object.entries(fixture.raw)) {
        mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
        writeFileSync(join(dataDir, rel), text);
      }
    };
    resetData();

    const require = createRequire(join(backendDir, 'harnais.js'));
    const frozenResults = require('./frozen-results.js');
    const { CHALLENGE_CONFIG, getRoundDates } = require('./shared-config.js');
    const handlers = buildServerHandlers(fixture, repoRoot);

    const readJSON = rel => JSON.parse(readFileSync(join(dataDir, rel), 'utf8'));
    const writeJSON = (rel, value) => writeFileSync(join(dataDir, rel), JSON.stringify(value, null, 2));

    // Entrées passées au gel, comme les fournit server.js (route freeze-round
    // et runAutoFreeze : server.js:2219-2234 et 2409-2421).
    const loadInputs = () => {
      const athletes = readJSON('athletes.json');
      return {
        activities: readJSON(fixture.activitiesFile),
        leagueAthletes: athletes.filter(a => a.league_id === leagueId && a.active),
        jokerUsage: handlers.normalizeJokerUsage(readJSON('jokers_usage.json'))
      };
    };

    // Effets de bord du gel sur les fichiers voisins
    const sideEffects = () => {
      const out = {};
      for (const rel of WATCHED_FILES) {
        const after = readJSON(rel);
        const before = JSON.parse(fixture.raw[rel]);
        out[rel] = sameJson(after, before) ? '(inchangé)' : after;
      }
      const frozenAfter = readJSON('frozen_results.json');
      out.eliminatedChallengeRankings = Object.keys(frozenAfter.eliminatedChallengeRankings || {});
      out.seasonBonuses = Object.keys(frozenAfter.seasonBonuses || {});
      out.rounds = Object.keys(frozenAfter.rounds || {}).length;
      return out;
    };

    const scenarios = {};
    const run = async (name, nowIso, fn) => {
      resetData();
      setNow(nowIso);
      seedMathRandom(name);
      try {
        scenarios[name] = { now: nowIso, ...(await fn()) };
      } catch (error) {
        scenarios[name] = { now: nowIso, error: sanitize(String(error?.message || error), root) };
      } finally {
        restoreMathRandom();
      }
    };

    const frozen = fixture.json('frozen_results.json');
    const ends = frozenRoundEnds(frozen);

    // 1. Regel de chaque round figé, isolément
    for (const { round } of ends) {
      await run(`regel-round-${pad(round)}`, capturedAt, async () => {
        const data = readJSON('frozen_results.json');
        delete data.rounds[String(round)];
        writeJSON('frozen_results.json', data);
        const { activities, leagueAthletes, jokerUsage } = loadInputs();
        const result = await frozenResults.freezeRoundResults(round, activities, leagueAthletes, jokerUsage, CHALLENGE_CONFIG);
        return { result: slim(result), sideEffects: sideEffects() };
      });
    }

    // 2. Regel du challenge des éliminés de chaque saison terminée
    const completedSeasons = Object.keys(frozen.eliminatedChallengeRankings || {}).map(Number).sort((a, b) => a - b);
    for (const season of completedSeasons) {
      const seasonEnd = ends.filter(e => e.season === season).map(e => e.end).sort().pop();
      await run(`regel-challenge-elimines-saison-${pad(season)}`, capturedAt, async () => {
        const result = await frozenResults.freezeEliminatedChallengeForSeason(season, {
          force: true,
          currentDate: new Date(seasonEnd)
        });
        const frozenAfter = readJSON('frozen_results.json');
        return {
          result: slim(result),
          seasonBonuses: frozenAfter.seasonBonuses?.[String(season)] ?? null,
          sideEffects: sideEffects()
        };
      });
    }

    // 3. Les deux prochains gels nocturnes (00h15 après la fin du round)
    const capturedMs = new RealDate(capturedAt).getTime();
    let current = 1;
    while (getRoundDates(current, CHALLENGE_CONFIG).end.getTime() < capturedMs) current++;
    for (const target of [current, current + 1]) {
      const nightly = getRoundDates(target, CHALLENGE_CONFIG).end.getTime() + 15 * 60 * 1000 + 1;
      await run(`gel-nocturne-apres-round-${pad(target)}`, new RealDate(nightly).toISOString(), async () => {
        const { activities, leagueAthletes, jokerUsage } = loadInputs();
        const result = await frozenResults.autoFreezeCompletedRounds(activities, leagueAthletes, jokerUsage, CHALLENGE_CONFIG);
        return { result: slim(result), sideEffects: sideEffects() };
      });
    }

    return { result: { scenarios }, logs: logs.lines };
  } finally {
    logs.restore();
    rmSync(root, { recursive: true, force: true });
  }
}

function sameJson(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function sanitize(message, root) {
  return message.split(root).join('<bac-a-sable>');
}

function pad(n) {
  return String(n).padStart(2, '0');
}
