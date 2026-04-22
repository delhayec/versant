#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - BACKFILL CHALLENGE ÉLIMINÉS
 * ============================================
 *
 * Script de migration one-shot pour peupler `eliminatedChallengeRankings`
 * dans `frozen_results.json` pour les saisons déjà terminées (S1, S2, ...).
 *
 * Utilisation :
 *   cd backend
 *   node scripts/backfill-elim-challenge.js [--force] [--season=N] [--league=versant-2026]
 *
 * Options :
 *   --force         : écraser une valeur existante
 *   --season=N      : ne traiter qu'une saison spécifique (sinon : toutes les saisons
 *                     finalisées, détectées par la présence d'un round finale figé)
 *   --league=ID     : leagueId à utiliser pour charger les activités (défaut : versant-2026)
 *
 * Voir BACKEND_TODO.md Phase 2 pour le contexte complet.
 */

const path = require('path');

// Exécuter ce script depuis n'importe où — on force le cwd au dossier backend/
process.chdir(path.join(__dirname, '..'));

const frozenResults = require('../frozen-results');
const { CHALLENGE_CONFIG } = require('../shared-config');

// ============================================
// PARSING DES ARGS
// ============================================
const args = process.argv.slice(2);
const opts = { force: false, season: null, league: CHALLENGE_CONFIG.leagueId };
for (const arg of args) {
  if (arg === '--force') opts.force = true;
  else if (arg.startsWith('--season=')) opts.season = parseInt(arg.slice(9), 10);
  else if (arg.startsWith('--league=')) opts.league = arg.slice(9);
}

// ============================================
// DÉTECTION DES SAISONS FINALISÉES
// ============================================

/**
 * Détermine quelles saisons sont "finalisées" (finale figée) en inspectant les rounds
 * figés de frozen_results.json.
 */
async function detectFinishedSeasons() {
  const data = await frozenResults.getAllFrozenResults();
  const rounds = data.rounds || {};
  const bySeasonRounds = {};

  for (const [k, r] of Object.entries(rounds)) {
    if (!r || !r.frozen || !r.seasonNumber) continue;
    const s = Number(r.seasonNumber);
    if (!bySeasonRounds[s]) bySeasonRounds[s] = [];
    bySeasonRounds[s].push({ k: Number(k), r });
  }

  const finished = [];
  for (const [sStr, roundsArr] of Object.entries(bySeasonRounds)) {
    const s = Number(sStr);
    // Une saison est "finalisée" si elle a un round figé avec un gagnant
    // (ranking[0].isWinner === true), qui marque la finale.
    // On NE se fie PAS au nombre d'éliminations (certaines règles spéciales comme
    // le handicap remplacent 2 → 4 éliminations sans pour autant être une finale).
    const hasFinale = roundsArr.some(x =>
      Array.isArray(x.r.ranking) && x.r.ranking.some(e => e.isWinner)
    );
    if (hasFinale) {
      finished.push(s);
    }
  }
  return finished.sort((a, b) => a - b);
}

// ============================================
// RUN
// ============================================

(async () => {
  try {
    console.log('=== Backfill challenge éliminés ===');
    console.log('Options :', opts);

    let seasons;
    if (opts.season) {
      seasons = [opts.season];
    } else {
      seasons = await detectFinishedSeasons();
      console.log(`Saisons finalisées détectées : [${seasons.join(', ')}]`);
    }

    if (seasons.length === 0) {
      console.log('Aucune saison à traiter.');
      process.exit(0);
    }

    const results = [];
    for (const s of seasons) {
      console.log(`\n--- Saison ${s} ---`);
      const result = await frozenResults.freezeEliminatedChallengeForSeason(s, {
        leagueId: opts.league,
        force: opts.force
      });
      results.push({ season: s, ...result });

      if (result.success) {
        console.log(`✅ Saison ${s} : ${result.ranking.length} athlète(s) figé(s)`);
        // Afficher le podium pour vérification visuelle
        result.ranking.slice(0, 3).forEach(r => {
          console.log(
            `   ${r.position}. ${r.name} — ${r.totalElevation}m D+ (brut ${r.rawElevation}m, ` +
            `+${r.bonusEffects.gained}/-${r.bonusEffects.lost}) → ${r.points} pts`
          );
        });
      } else if (result.error === 'already_frozen') {
        console.log(`⏭️  Saison ${s} : déjà figée. Utiliser --force pour écraser.`);
      } else {
        console.log(`❌ Saison ${s} : ${result.error}`);
      }
    }

    console.log('\n=== Terminé ===');
    console.log(`${results.filter(r => r.success).length}/${results.length} saison(s) traitée(s) avec succès.`);
    process.exit(0);
  } catch (error) {
    console.error('FATAL:', error);
    process.exit(1);
  }
})();