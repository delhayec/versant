#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - ENTRÉE EN JEU D'UN ATHLÈTE
 * ============================================
 *
 * Pose (ou retire) le champ `active_from_round` sur un athlète.
 *
 * Règle globale : un athlète inscrit en cours de jeu ATTEND la saison suivante.
 * Ce script sert à faire l'EXCEPTION : le faire entrer à un round précis, y
 * compris en milieu de saison. Il n'est alors pas protégé — il peut être
 * éliminé dès ce round comme n'importe qui.
 *
 * Utilisation :
 *   cd backend
 *   node scripts/set-athlete-entry.js --list             # rounds disponibles + athlètes
 *   node scripts/set-athlete-entry.js <athleteId> <round>
 *   node scripts/set-athlete-entry.js <athleteId> --clear
 *
 * Une sauvegarde horodatée de athletes.json est écrite avant toute modification.
 *
 * ⚠️  Le serveur lit athletes.json à chaque requête. Lancer ce script pendant
 *     qu'une inscription est en cours pourrait perdre l'une des deux écritures.
 *     À exécuter de préférence serveur arrêté, ou à un moment calme.
 */

const path = require('path');
const fs = require('fs').promises;

process.chdir(path.join(__dirname, '..'));

const frozenResults = require('../frozen-results');
const { CHALLENGE_CONFIG, getRoundDates } = require('../shared-config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');

const args = process.argv.slice(2);
const wantList = args.includes('--list');
const wantClear = args.includes('--clear');
const positional = args.filter(a => !a.startsWith('--'));
const athleteId = positional[0];
const roundArg = positional[1];

/**
 * Date en AAAA-MM-JJ LOCAL. getRoundDates ancre les bornes à minuit local
 * (Europe/Paris) : toISOString() reculerait d'un jour.
 */
function fmt(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Premier round global de chaque saison, lu dans les rounds figés. */
function seasonStartRounds(frozenRoundsObj) {
  const byS = {};
  for (const r of Object.values(frozenRoundsObj || {})) {
    if (!r?.frozen) continue;
    const s = Number(r.seasonNumber);
    const rn = Number(r.roundNumber);
    if (isNaN(s) || isNaN(rn)) continue;
    if (byS[s] == null || rn < byS[s]) byS[s] = rn;
  }
  return byS;
}

async function printContext() {
  const data = await frozenResults.loadFrozenResultsRaw();
  const rounds = data?.rounds || {};
  const starts = seasonStartRounds(rounds);
  const frozenNums = Object.values(rounds)
    .filter(r => r?.frozen)
    .map(r => Number(r.roundNumber))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);
  const lastFrozen = frozenNums.length ? frozenNums[frozenNums.length - 1] : 0;

  console.log('');
  console.log('SAISONS (début lu dans les rounds figés)');
  for (const s of Object.keys(starts).sort((a, b) => Number(a) - Number(b))) {
    const rn = starts[s];
    console.log(`  Saison ${s} → commence au round global ${rn} (${fmt(getRoundDates(rn, CHALLENGE_CONFIG).start)})`);
  }

  console.log('');
  console.log('ROUNDS AUTOUR DU PRÉSENT');
  const now = Date.now();
  for (let r = Math.max(1, lastFrozen - 1); r <= lastFrozen + 3; r++) {
    const d = getRoundDates(r, CHALLENGE_CONFIG);
    const info = rounds[String(r)];
    let state;
    if (info?.frozen) state = `figé (saison ${info.seasonNumber}, round ${info.roundInSeason})`;
    else if (d.start.getTime() > now) state = 'à venir';
    else if (d.end.getTime() >= now) state = '◀ EN COURS';
    else state = 'terminé, non figé';
    console.log(`  Round ${String(r).padStart(3)} : ${fmt(d.start)} → ${fmt(d.end)}  ${state}`);
  }

  const athletes = await readJSON(ATHLETES_FILE, []);
  console.log('');
  console.log('ATHLÈTES');
  for (const a of athletes) {
    const entry = a.active_from_round != null ? `entrée forcée au round ${a.active_from_round}` : 'règle globale';
    console.log(`  ${String(a.id).padEnd(12)} ${String(a.name || '').padEnd(20)} inscrit ${a.registered_at || '?'}  [${entry}]`);
  }
  console.log('');
}

async function main() {
  if (wantList || !athleteId) {
    await printContext();
    if (!athleteId) {
      console.log('Usage: node scripts/set-athlete-entry.js <athleteId> <round>');
      console.log('       node scripts/set-athlete-entry.js <athleteId> --clear');
      console.log('');
    }
    return;
  }

  if (!wantClear && (roundArg == null || isNaN(Number(roundArg)))) {
    console.error('❌ Indiquez un round global (entier) ou --clear.');
    process.exit(1);
  }

  const athletes = await readJSON(ATHLETES_FILE, null);
  if (!Array.isArray(athletes)) {
    console.error(`❌ Impossible de lire ${ATHLETES_FILE}`);
    process.exit(1);
  }

  const idx = athletes.findIndex(a => String(a.id) === String(athleteId));
  if (idx < 0) {
    console.error(`❌ Athlète ${athleteId} introuvable.`);
    console.error(`   Connus : ${athletes.map(a => `${a.id} (${a.name})`).join(', ')}`);
    process.exit(1);
  }

  const athlete = athletes[idx];
  const before = athlete.active_from_round ?? null;
  const after = wantClear ? null : Number(roundArg);

  if (before === after) {
    console.log(`ℹ️  ${athlete.name} : déjà à ${after == null ? '(règle globale)' : `round ${after}`}. Rien à faire.`);
    return;
  }

  // Sauvegarde horodatée AVANT toute écriture
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(DATA_DIR, `athletes.backup-${stamp}.json`);
  await fs.writeFile(backup, JSON.stringify(athletes, null, 2));
  console.log(`💾 Sauvegarde : ${backup}`);

  if (after == null) {
    delete athletes[idx].active_from_round;
  } else {
    athletes[idx].active_from_round = after;
  }

  await fs.writeFile(ATHLETES_FILE, JSON.stringify(athletes, null, 2));

  console.log('');
  console.log(`✅ ${athlete.name} (${athlete.id})`);
  console.log(`   avant : ${before == null ? 'règle globale (entre à la saison suivante)' : `round ${before}`}`);
  console.log(`   après : ${after == null ? 'règle globale (entre à la saison suivante)' : `round ${after}`}`);
  if (after != null) {
    const d = getRoundDates(after, CHALLENGE_CONFIG);
    console.log(`   soit à partir du ${fmt(d.start)} — sans protection, éliminable dès ce round.`);
  }
  console.log('');
  console.log('   Pensez à rattraper ses activités :');
  console.log(`   node scripts/sync-activities.js ${CHALLENGE_CONFIG.leagueId} <début> <aujourd'hui>`);
  console.log('');
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
