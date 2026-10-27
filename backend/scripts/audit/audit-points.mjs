// Audit des points du classement général.
// A = recalcul indépendant depuis les données figées (frozen_results.json, bonuses.json)
// B = moteur du navigateur (public/js/standings-engine.js) exécuté sur l'API locale
// Usage : node audit.mjs <baseUrl> <publicDir> <dataDir>
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const [baseUrl, publicDir, dataDir] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const read = f => JSON.parse(fs.readFileSync(join(dataDir, f), 'utf8'));

// ---------- A. Recalcul indépendant ----------
const frozen = read('frozen_results.json');
const bonusesFile = read('bonuses.json');
const bonusesAll = Array.isArray(bonusesFile) ? bonusesFile : (bonusesFile.bonuses || []);
const athletes = read('athletes.json').filter(a => a.league_id === 'versant-2026' && a.active);
const nameOf = id => athletes.find(a => String(a.id) === String(id))?.name || `#${id}`;

const roundsBySeason = {};
for (const [k, r] of Object.entries(frozen.rounds || {})) {
  if (!r?.frozen) continue;
  (roundsBySeason[r.seasonNumber] ||= []).push({ n: Number(k), ...r });
}
for (const s in roundsBySeason) roundsBySeason[s].sort((a, b) => a.n - b.n);
const seasons = Object.keys(roundsBySeason).map(Number).sort((a, b) => a - b);

const A = {}; // A[id][s] = { main, elim, rescape, gauge, bonus, notes[] }
const cell = (id, s) => ((A[id] ||= {})[s] ||= { main: 0, elim: 0, rescape: 0, gauge: 0, bonus: 0, notes: [] });
const seasonComplete = s => !!frozen.eliminatedChallengeRankings?.[String(s)];

for (const s of seasons) {
  const rounds = roundsBySeason[s];
  const eliminated = new Set();
  for (const r of rounds) {
    for (const e of r.ranking || []) if (e.mainPoints > 0) cell(String(e.id), s).main += e.mainPoints;
    for (const e of r.eliminations || []) eliminated.add(String(e.id));
    if (r.rescapeInfo?.athleteId && r.rescapeInfo.points > 0) cell(String(r.rescapeInfo.athleteId), s).rescape += r.rescapeInfo.points;
    const g = r.elevationGauge;
    if (g?.points && Array.isArray(g.beneficiaries)) for (const id of g.beneficiaries) cell(String(id), s).gauge += g.points;
  }
  // Vainqueur sans points enregistrés (saison terminée par élimination naturelle)
  const last = rounds[rounds.length - 1];
  const survivors = (last.activeParticipants || []).map(String).filter(id => !eliminated.has(id));
  if (seasonComplete(s) && survivors.length === 1) {
    const id = survivors[0];
    const entry = (last.ranking || []).find(e => String(e.id) === id);
    if (!(entry?.mainPoints > 0)) cell(id, s).notes.push('vainqueur sans points figés');
  }
  const er = frozen.eliminatedChallengeRankings?.[String(s)];
  for (const e of (Array.isArray(er) ? er : er?.ranking || [])) {
    if (e.points) cell(String(e.participant?.id ?? e.id), s).elim += e.points;
  }
  // Bonus +1 (marquage dont la cible est éliminée, duel gagné)
  const roundSet = new Set(rounds.map(r => r.n));
  const seen = new Set();
  const cands = [...(frozen.seasonBonuses?.[String(s)] || []), ...rounds.flatMap(r => r.bonusesUsed || []),
    ...bonusesAll.filter(b => roundSet.has(Number(b.elimination_round)))];
  for (const b of cands) {
    const key = b.id || `${b.bonus_id}_${b.athlete_id}_${b.elimination_round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = b.effect_result;
    let pts = 0;
    if (b.bonus_id === 'marquage' && res?.targetEliminated === true) pts = res.pointsAwarded || 1;
    if (b.bonus_id === 'duel' && res?.won === true) pts = res.pointsAwarded || 1;
    if (pts) cell(String(b.athlete_id), s).bonus += pts;
  }
}

// ---------- B. Moteur du navigateur ----------
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() }; };
globalThis.window = { location: { pathname: '/index.html', search: '', href: `${baseUrl}/index.html` }, TeamFormation: require(join(publicDir, 'shared', 'team-formation.js')) };
globalThis.localStorage = mem();
globalThis.sessionStorage = mem();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(new URL(typeof input === 'string' ? input : input.url, baseUrl), init);
const load = f => import(pathToFileURL(join(publicDir, 'js', f)).href);

const config = await load('config.js');
const jokers = await load('jokers.js');
const engine = await load('standings-engine.js');
await config.loadParticipants();
const frozenApi = await (await fetch('/api/frozen-results')).json();
config.setFrozenCache(frozenApi);
await config.loadSpecialRulesOverrides();
const bonusesApi = await (await fetch('/api/bonuses/all')).json();
await jokers.initializeJokersState();
const raw = await (await fetch(`/api/activities/${config.CHALLENGE_CONFIG.leagueId}`)).json();
const parse = engine.parseActivitiesData || (d => (Array.isArray(d) ? d : d.activities || []));
const activities = parse(raw);
const now = new Date();
const final = engine.computeFinalStandings({ activities, currentDate: now, frozenResults: frozenApi, bonuses: bonusesApi });
const perSeasonB = {};
for (const s of [...seasons, Math.max(...seasons) + 1]) {
  perSeasonB[s] = engine.calculatePointsForSeason(s, activities, now, frozenApi, bonusesApi, frozenApi.seasonBonuses || {});
}

// ---------- Comparaison ----------
const out = { seasons, players: [] };
const ids = new Set([...Object.keys(A), ...final.map(e => String(e.participant.id))]);
for (const id of ids) {
  const e = final.find(x => String(x.participant.id) === id);
  const per = [];
  let totA = 0;
  for (const s of seasons) {
    const c = A[id]?.[s] || { main: 0, elim: 0, rescape: 0, gauge: 0, bonus: 0, notes: [] };
    const winnerGap = c.notes.includes('vainqueur sans points figés') ? 24 : 0;
    const a = c.main + winnerGap + c.elim + c.rescape + c.gauge + c.bonus;
    totA += a;
    const b = perSeasonB[s]?.[id] || perSeasonB[s]?.[Number(id)];
    per.push({ s, A: { ...c, winnerGap, total: a }, B: b ? { main: b.mainPoints, elim: b.elimPoints, rescape: b.rescapePoints, gauge: b.gaugePoints, total: b.total } : null });
  }
  out.players.push({
    id, name: nameOf(id), totalA: totA,
    B: e ? { total: e.totalPoints, main: e.totalMainPoints, elim: e.totalEliminatedPoints, rescape: e.totalRescapePoints, gauge: e.totalGaugePoints, bonus: e.bonusPoints, wins: e.wins, prev: e.previousSeasonTotal, currMain: e.currentSeasonMain, currElim: e.currentSeasonElim } : null,
    snapshot: frozen.yearlyStandingsSnapshot?.standings?.find(x => String(x.id) === id)?.totalPoints ?? null,
    per
  });
}
out.players.sort((a, b) => (b.B?.total || 0) - (a.B?.total || 0));
fs.writeFileSync(process.argv[5] || 'audit-result.json', JSON.stringify(out, null, 2));

console.log('Joueur'.padEnd(14), 'A(indép.)', 'B(moteur)', 'snapshot', 'écart');
for (const p of out.players) {
  const d = (p.B?.total ?? 0) - p.totalA;
  console.log(p.name.padEnd(14), String(p.totalA).padStart(9), String(p.B?.total ?? '-').padStart(9), String(p.snapshot ?? '-').padStart(8), d ? `  ${d > 0 ? '+' : ''}${d}` : '');
}
console.log('\nÉcarts par saison (A indépendant vs B colonnes par saison du moteur) :');
for (const p of out.players) {
  for (const x of p.per) {
    if (!x.B) continue;
    const diffs = ['main', 'elim', 'rescape', 'gauge'].filter(k => (k === 'main' ? x.A.main + x.A.winnerGap : x.A[k]) !== x.B[k]);
    if (diffs.length || x.A.notes.length) {
      console.log(`  ${p.name} S${x.s}: ` + diffs.map(k => `${k} A=${k === 'main' ? x.A.main + x.A.winnerGap : x.A[k]} B=${x.B[k]}`).join(', ') + (x.A.bonus ? ` (bonus +${x.A.bonus} hors colonnes)` : '') + (x.A.notes.length ? ` [${x.A.notes.join('; ')}]` : ''));
    }
  }
}
process.exit(0);
