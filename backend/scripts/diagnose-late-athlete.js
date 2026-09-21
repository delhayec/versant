#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - DIAGNOSTIC D'UN ATHLÈTE TARDIF
 * ============================================
 *
 * Vérifie si un athlète inscrit en cours de jeu a contaminé des données DÉJÀ
 * FIGÉES, c'est-à-dire des rounds terminés avant son entrée en jeu.
 *
 * Ce script est en LECTURE SEULE : il n'écrit rien, nulle part.
 *
 * Utilisation :
 *   cd backend
 *   node scripts/diagnose-late-athlete.js <athleteId>
 *   node scripts/diagnose-late-athlete.js --all      (tous les athlètes tardifs)
 */

const path = require('path');
const fs = require('fs').promises;

// Exécuter ce script depuis n'importe où — on force le cwd au dossier backend/
process.chdir(path.join(__dirname, '..'));

const frozenResults = require('../frozen-results');
const { CHALLENGE_CONFIG, getRoundDates } = require('../shared-config');

const ATHLETES_FILE = path.join(__dirname, '..', 'data', 'athletes.json');

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const targetId = args.find(a => !a.startsWith('--'));

if (!targetId && !wantAll) {
  console.error('Usage: node scripts/diagnose-late-athlete.js <athleteId> | --all');
  process.exit(1);
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Date en AAAA-MM-JJ LOCAL. getRoundDates ancre les bornes à minuit local
 * (Europe/Paris) : toISOString() reculerait d'un jour.
 */
function fmtLocal(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

/**
 * Round global à partir duquel l'athlète est réellement en jeu.
 * Reproduit la règle de frozen-results.js::isAthleteInRound.
 */
function resolveEntryRound(athlete, frozenRounds) {
  if (athlete.active_from_round != null) {
    return { round: Number(athlete.active_from_round), source: 'active_from_round (exception)' };
  }
  if (!athlete.registered_at) {
    return { round: 1, source: 'athlète historique (pas de registered_at)' };
  }

  // Règle globale : il entre au premier round d'une saison qui DÉBUTE après son
  // inscription. On cherche, parmi les rounds figés, le premier round de saison
  // dont la date de début est postérieure à registered_at.
  const registered = new Date(athlete.registered_at);
  const startRoundBySeason = {};
  for (const r of Object.values(frozenRounds)) {
    if (!r?.frozen) continue;
    const s = Number(r.seasonNumber);
    const rn = Number(r.roundNumber);
    if (isNaN(s) || isNaN(rn)) continue;
    if (startRoundBySeason[s] == null || rn < startRoundBySeason[s]) startRoundBySeason[s] = rn;
  }

  const candidates = Object.values(startRoundBySeason)
    .filter(rn => getRoundDates(rn, CHALLENGE_CONFIG).start > registered)
    .sort((a, b) => a - b);

  if (candidates.length > 0) {
    return { round: candidates[0], source: 'règle globale (1er round de la saison suivante, figé)' };
  }
  return { round: null, source: 'règle globale (la saison suivante n\'a pas encore de round figé)' };
}

function idIn(list, id) {
  return Array.isArray(list) && list.some(x => String(x?.id ?? x) === String(id));
}

async function diagnose(athlete, data) {
  const id = String(athlete.id);
  const rounds = data?.rounds || {};
  const { round: entryRound, source } = resolveEntryRound(athlete, rounds);

  console.log('');
  console.log('═'.repeat(70));
  console.log(`  ${athlete.name || '(sans nom)'}  —  id ${id}`);
  console.log('═'.repeat(70));
  console.log(`  registered_at      : ${athlete.registered_at || '(aucune)'}`);
  console.log(`  active_from_round  : ${athlete.active_from_round ?? '(non défini)'}`);
  console.log(`  entrée en jeu      : ${entryRound != null ? `round ${entryRound}` : 'indéterminée'}`);
  console.log(`  déduite de         : ${source}`);
  if (entryRound != null) {
    console.log(`  soit à partir du   : ${fmtLocal(getRoundDates(entryRound, CHALLENGE_CONFIG).start)}`);
  }

  const problems = [];
  let earliestAppearance = null;

  // 1. Rounds figés ANTÉRIEURS à son entrée où il apparaît.
  // Deux lectures possibles d'une telle présence :
  //   - contamination (freeze rétroactif l'ayant aspiré dans un round passé) ;
  //   - registered_at postérieur à sa vraie participation (compte recréé) — dans
  //     ce cas c'est registered_at qui ment, et il FAUT poser active_from_round
  //     sinon il perd ses points historiques.
  for (const key of Object.keys(rounds).sort((a, b) => Number(a) - Number(b))) {
    const r = rounds[key];
    if (!r?.frozen) continue;
    const rn = Number(r.roundNumber ?? key);

    const hits = [];
    if (idIn(r.activeParticipants, id)) hits.push('activeParticipants');
    if (idIn(r.ranking, id)) hits.push('ranking');
    if (idIn(r.eliminations, id)) hits.push('eliminations');
    if (Array.isArray(r.teams) && r.teams.some(t => idIn(t.members, id))) hits.push('teams');

    if (hits.length && earliestAppearance === null) earliestAppearance = rn;
    if (entryRound != null && rn >= entryRound) continue;

    if (hits.length) {
      problems.push(`Round ${rn} (saison ${r.seasonNumber}) figé le ${r.frozenAt || '?'} → présent dans : ${hits.join(', ')}`);
    }
  }

  // Incohérence majeure : il joue dans les rounds figés AVANT son entrée calculée.
  // Ses points de ces saisons seront ignorés par le classement général.
  if (earliestAppearance !== null && entryRound != null && earliestAppearance < entryRound) {
    problems.push(
      `⇒ INCOHÉRENCE : il apparaît dès le round ${earliestAppearance} mais son entrée calculée est le round ${entryRound}. ` +
      `Ses points des saisons antérieures seront IGNORÉS au classement général. ` +
      `Correction : node scripts/set-athlete-entry.js ${id} ${earliestAppearance}`
    );
  }

  // 2. Challenges éliminés de saisons TERMINÉES AVANT son entrée en jeu.
  // Une présence dans une saison qu'il a réellement jouée est normale — on ne
  // signale que les saisons antérieures à son entrée.
  const elimRankings = data?.eliminatedChallengeRankings || {};
  for (const season of Object.keys(elimRankings)) {
    const ranking = elimRankings[season]?.ranking || elimRankings[season];
    if (!Array.isArray(ranking)) continue;

    // Dernier round figé de cette saison : si elle s'est terminée avant son
    // entrée, il n'avait rien à y faire.
    const roundsOfSeason = Object.values(rounds)
      .filter(r => r?.frozen && Number(r.seasonNumber) === Number(season))
      .map(r => Number(r.roundNumber))
      .filter(n => !isNaN(n));
    if (roundsOfSeason.length === 0) continue;
    const lastRoundOfSeason = Math.max(...roundsOfSeason);
    if (entryRound == null || lastRoundOfSeason >= entryRound) continue;

    const entry = ranking.find(e => String(e.participant?.id ?? e.id) === id);
    if (entry) {
      problems.push(`Challenge éliminés saison ${season} (terminée au R${lastRoundOfSeason}, avant son entrée) → présent avec ${entry.points ?? '?'} pt(s)`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log('  ✅ Aucune contamination détectée dans les données figées.');
  } else {
    console.log(`  ⚠️  ${problems.length} anomalie(s) :`);
    problems.forEach(p => console.log(`     • ${p}`));
  }
  return problems.length;
}

async function main() {
  const athletes = await readJSON(ATHLETES_FILE, []);
  const data = await frozenResults.loadFrozenResultsRaw();

  if (!athletes.length) {
    console.error(`❌ Aucun athlète dans ${ATHLETES_FILE}`);
    process.exit(1);
  }

  let targets;
  if (wantAll) {
    targets = athletes.filter(a => a.active_from_round != null || a.registered_at);
  } else {
    targets = athletes.filter(a => String(a.id) === String(targetId));
    if (!targets.length) {
      console.error(`❌ Athlète ${targetId} introuvable.`);
      console.error(`   Athlètes connus : ${athletes.map(a => `${a.id} (${a.name})`).join(', ')}`);
      process.exit(1);
    }
  }

  let total = 0;
  for (const a of targets) total += await diagnose(a, data);

  console.log('');
  console.log('═'.repeat(70));
  console.log(total === 0
    ? '✅ Rien à réparer.'
    : `⚠️  ${total} anomalie(s) au total. Aucune donnée n'a été modifiée (script en lecture seule).`);
  console.log('');
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
