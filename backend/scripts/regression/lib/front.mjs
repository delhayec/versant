/**
 * ============================================
 * VERSANT - HARNAIS : PARTIE A — MOTEUR FRONT
 * ============================================
 * Charge public/js/config.js, jokers.js et standings-engine.js dans Node, sans
 * les modifier, à une date figée, et calcule ce que voient les joueurs :
 * classement annuel, couronnes, points par saison, seasonsPlayed, classement du
 * round en cours, graphe « Évolution des points » de la page stats.
 *
 * Les données arrivent par un fetch simulé (cf. fixture.mjs). Le chargement
 * suit l'ordre d'app.js init() (app.js:2548-2584) ; le code des pages qu'on ne
 * peut pas importer est extrait et exécuté tel quel (cf. extract.mjs).
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { slim } from './canonical.mjs';
import { installFixedClock } from './clock.mjs';
import { captureConsole } from './console.mjs';
import { compile, extractBetween, extractConst, extractFunction, readSource } from './extract.mjs';
import { buildServerHandlers, createFakeFetch, loadFixture } from './fixture.mjs';

const ENGINE_FILES = ['config.js', 'jokers.js', 'standings-engine.js'];

export async function runFront({ repoRoot, fixtureDir, at }) {
  installFixedClock(at);
  const fixture = loadFixture(fixtureDir);
  const logs = captureConsole(`front ${at}`);

  // Copie des modules dans un dossier « type: module » : chargement ESM garanti
  // quelle que soit la version de Node (public/js n'a pas de package.json).
  const engineDir = mkdtempSync(join(tmpdir(), 'versant-moteur-'));
  try {
    for (const f of ENGINE_FILES) copyFileSync(join(repoRoot, 'public', 'js', f), join(engineDir, f));
    writeFileSync(join(engineDir, 'package.json'), '{ "type": "module" }\n');

    const require = createRequire(import.meta.url);
    const TeamFormation = require(join(repoRoot, 'public', 'shared', 'team-formation.js'));
    globalThis.window = {
      location: { pathname: '/index.html', search: '', href: 'https://versant-app.fr/index.html' },
      TeamFormation
    };
    globalThis.localStorage = memoryStorage();
    globalThis.sessionStorage = memoryStorage();

    const apiCalls = [];
    const handlers = buildServerHandlers(fixture, repoRoot);
    globalThis.fetch = createFakeFetch(fixture, handlers, apiCalls);

    const config = await import(pathToFileURL(join(engineDir, 'config.js')).href);
    const jokers = await import(pathToFileURL(join(engineDir, 'jokers.js')).href);
    const engine = await import(pathToFileURL(join(engineDir, 'standings-engine.js')).href);
    const pages = buildPageExtracts(repoRoot, config);

    const result = await compute({ config, jokers, engine, pages, handlers });
    result.apiCalls = summarizeCalls(apiCalls);
    return { result, logs: logs.lines };
  } finally {
    logs.restore();
    rmSync(engineDir, { recursive: true, force: true });
  }
}

/** Code des pages exécuté tel quel : app.js et stats.js ne s'importent pas hors navigateur. */
function buildPageExtracts(repoRoot, config) {
  const appFile = 'public/js/app.js';
  const statsFile = 'public/js/stats.js';
  const app = readSource(join(repoRoot, appFile));
  const stats = readSource(join(repoRoot, statsFile));

  const parseActivitiesData = compile(extractFunction(app, 'parseActivitiesData', appFile), 'parseActivitiesData', {
    isValidSport: config.isValidSport
  });

  // renderFinalStandings : calcul des totaux affichés (le reste de la fonction est du HTML)
  const enrichBlock = extractBetween(
    app,
    'const enrichedStandings = standings.map(',
    'enrichedStandings.forEach((e, i) => e.rank = i + 1);',
    appFile
  );
  const enrichFinalStandings = (standings, frozenPoints, previousSeasonPoints, currentSeasonPoints) =>
    compile(enrichBlock, 'enrichedStandings', { standings, frozenPoints, previousSeasonPoints, currentSeasonPoints });

  const statsCode = [
    extractConst(stats, 'CHALLENGE_START', statsFile),
    extractConst(stats, 'EXCLUDED_SPORTS', statsFile),
    extractFunction(stats, 'normalizeActivity', statsFile),
    extractFunction(stats, 'filterAndNormalize', statsFile)
  ].join('\n');
  const filterAndNormalize = compile(statsCode, 'filterAndNormalize', {
    CHALLENGE_CONFIG: config.CHALLENGE_CONFIG,
    SPORT_SETTINGS: config.SPORT_SETTINGS,
    isValidSport: config.isValidSport
  });

  return { parseActivitiesData, enrichFinalStandings, filterAndNormalize };
}

async function compute({ config, jokers, engine, pages, handlers }) {
  // ---- Chargement, dans l'ordre d'app.js init() ----
  await config.loadParticipants();
  const frozen = await (await fetch('/api/frozen-results')).json();
  const seasonBonusesCache = frozen.seasonBonuses || {};
  config.setFrozenCache(frozen);
  await config.loadSpecialRulesOverrides();
  const bonusesCache = await (await fetch('/api/bonuses/all')).json();
  await jokers.initializeJokersState();
  const rawActivities = await (await fetch(`/api/activities/${config.CHALLENGE_CONFIG.leagueId}`)).json();
  const allActivities = pages.parseActivitiesData(rawActivities);
  const statsActivities = pages.filterAndNormalize(rawActivities);

  // ---- Page d'accueil : renderAll() (app.js:594-618) ----
  const today = new Date();
  const currentSeasonNumber = config.getSeasonNumber(today, frozen);
  const currentRoundNumber = config.getGlobalRoundNumber(today);
  const seasonData = engine.simulateSeasonEliminations(allActivities, currentSeasonNumber, today, frozen, null);
  const yearly = engine.calculateYearlyStandings(allActivities, today, frozen, bonusesCache, seasonBonusesCache);

  // Classement du round en cours, saison individuelle (app.js:688-716)
  let liveRanking = null;
  const currentSeasonType = config.getSeasonType(currentSeasonNumber);
  if (!currentSeasonType?.isTeamBased) {
    const roundDates = config.getRoundDates(currentRoundNumber);
    const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
    const roundActivities = engine.filterByPeriod(allActivities, roundDates.start, endDate);
    const currentRule = config.getSpecialRuleForRound(currentRoundNumber);
    let ranking = engine.calculateRanking(roundActivities, seasonData?.active || [], currentRule);
    ranking = jokers.applyJokerEffects(ranking, currentRoundNumber);
    if (currentRule === 'handicap' && yearly) ranking = engine.applyHandicapRule(ranking, yearly);
    liveRanking = { rule: currentRule, ranking: slim(ranking) };
  }

  // Jauge du round en cours (app.js:753-765)
  const gaugeDates = config.getRoundDates(currentRoundNumber);
  const gaugeEnd = today < new Date(gaugeDates.end) ? today : gaugeDates.end;
  const liveGauge = engine.computeLiveElevationGauge(
    engine.filterByPeriod(allActivities, gaugeDates.start, gaugeEnd),
    seasonData?.active || []
  );

  // Classement général affiché : renderFinalStandings() (app.js:1325-1375)
  const frozenPoints = engine.calculatePointsFromFrozenResults(frozen);
  const previousSeasonPoints = engine.calculatePointsForSeason(currentSeasonNumber - 1, allActivities, today, frozen, bonusesCache, seasonBonusesCache);
  const currentSeasonPoints = engine.calculatePointsForSeason(currentSeasonNumber, allActivities, today, frozen, bonusesCache, seasonBonusesCache);
  const finalStandings = pages.enrichFinalStandings(yearly, frozenPoints, previousSeasonPoints, currentSeasonPoints);

  // ---- Saison par saison ----
  const seasonNumbers = [...new Set([
    ...Object.values(frozen.rounds || {}).map(r => Number(r?.seasonNumber)).filter(n => n > 0),
    currentSeasonNumber
  ])].sort((a, b) => a - b);

  const seasons = {};
  for (const s of seasonNumbers) {
    const roundsOfSeason = Object.entries(frozen.rounds || {})
      .filter(([, r]) => r?.frozen && Number(r.seasonNumber) === s)
      .map(([k]) => Number(k))
      .sort((a, b) => a - b);
    seasons[s] = {
      calendar: {
        startRound: config.getSeasonStartRound(s, frozen),
        rounds: config.getRoundsForSeason(s, frozen),
        dates: config.getSeasonDates(s, frozen)
      },
      simulation: summarizeSimulation(engine.simulateSeasonEliminations(allActivities, s, today, frozen, yearly)),
      points: engine.calculatePointsForSeason(s, allActivities, today, frozen, bonusesCache, seasonBonusesCache),
      rescape: engine.calculateRescapePointsForSeason(s, frozen),
      rescapeByRound: Object.fromEntries(roundsOfSeason.map(r => [r, engine.getRescapeInfoForRound(r, frozen)])),
      gauge: engine.calculateGaugePointsForSeason(s, frozen),
      eliminatedChallengeCached: (engine.getCachedEliminatedChallengeRanking(s, frozen) || null)?.map(e => ({
        id: String(e.participant?.id ?? e.id),
        position: e.position,
        points: e.points,
        totalElevation: e.totalElevation
      })) ?? null
    };
  }

  // ---- Page stats : graphe « Évolution des points » (stats.js:1798-1816) ----
  const endOfSeason = {};
  for (const s of seasonNumbers) {
    const rounds = Object.values(frozen.rounds || {})
      .filter(r => r && Number(r.seasonNumber) === s && r.frozen)
      .sort((a, b) => (a.roundInSeason || 0) - (b.roundInSeason || 0));
    const finale = rounds[rounds.length - 1];
    if (!finale?.dates?.end) continue;
    endOfSeason[s] = {
      snapshotDate: finale.dates.end,
      standings: slim(engine.computeFinalStandings({
        activities: statsActivities,
        currentDate: new Date(finale.dates.end),
        frozenResults: frozen,
        bonuses: bonusesCache
      }))
    };
  }
  const statsFinalAtDate = engine.computeFinalStandings({
    activities: statsActivities,
    currentDate: today,
    frozenResults: frozen,
    bonuses: bonusesCache
  });

  // ---- Calendrier ----
  const roundInSeason = config.getRoundInSeason(today, frozen);
  const roundDates = {};
  for (let r = 1; r <= currentRoundNumber + 2; r++) roundDates[r] = config.getRoundDates(r);

  return {
    at: today.toISOString(),
    context: {
      currentSeasonNumber,
      currentRoundNumber,
      roundInSeason,
      isFinale: config.isFinaleRound(roundInSeason, currentSeasonNumber, frozen),
      specialRule: config.getSpecialRuleForRound(currentRoundNumber),
      seasonType: currentSeasonType?.id ?? null,
      totalSeasons: config.getTotalSeasons(),
      roundsPerSeason: config.getRoundsPerSeason()
    },
    inputs: {
      participants: config.PARTICIPANTS.map(p => ({ ...p })),
      activitiesIndex: allActivities.length,
      activitiesStats: statsActivities.length,
      bonuses: bonusesCache.length
    },
    index: {
      seasonData: summarizeSimulation(seasonData),
      yearlyStandings: slim(yearly),
      finalStandings: slim(finalStandings),
      frozenPoints,
      frozenPointsAtDate: engine.calculatePointsFromFrozenResults(frozen, today),
      liveRanking,
      liveGauge
    },
    seasons,
    stats: {
      finalAtDate: slim(statsFinalAtDate),
      endOfSeason
    },
    calendar: { roundDates },
    // Forme envoyée au backend par app.js (POST /api/standings/snapshot), pour
    // le contrôle de fidélité avec le snapshot présent dans la fixture.
    snapshotCompact: handlers.compactSnapshot(yearly)
  };
}

/** Simulation d'une saison, sans recopier les classements déjà figés (entrées, pas résultats). */
function summarizeSimulation(sim) {
  const out = slim(sim);
  out.roundResults = (out.roundResults || []).map(r => (r.frozen
    ? { ...r, ranking: '(round figé)', teams: r.teams ? '(round figé)' : undefined }
    : r));
  return out;
}

function summarizeCalls(calls) {
  const byPath = {};
  for (const c of calls) {
    const key = `${c.status} ${c.path}`;
    byPath[key] = (byPath[key] || 0) + 1;
  }
  return byPath;
}

function memoryStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; }
  };
}
