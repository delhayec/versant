#!/usr/bin/env node
/**
 * VERSANT - BACKFILL MÉTÉO DES ACTIVITÉS
 *
 * Renseigne le champ `weather` de chaque activité (règle spéciale de round
 * "la pluie qui mouille" : D+ ×1,5 sur les sorties effectuées sous la pluie).
 *
 * Utilisation :
 *   cd backend
 *   node scripts/backfill-weather.js [--league=versant-2026] [--dry-run]
 *                                    [--limit=N] [--force] [--athlete=<id>]
 *                                    [--report]
 *
 * Options :
 *   --dry-run        n'écrit pas le fichier d'activités
 *   --limit=N        ne traite que les N premières activités éligibles
 *   --force          recalcule même les météos déjà verrouillées
 *   --athlete=<id>   restreint à un athlète (id Strava)
 *   --report         affiche le tableau détaillé des activités analysées
 *
 * Prérequis : les activités doivent avoir des coordonnées (`start_latlng`).
 * Celles qui n'en ont pas (indoor, home trainer, saisie manuelle, ou webhook
 * antérieur au fix du 23/04/2026) sont marquées `status: "no_geo"` et ne
 * peuvent pas bénéficier du bonus. Pour rattraper l'historique :
 *   node scripts/backfill-polyline.js
 *
 * L'API Open-Meteo est gratuite et sans clé, mais réservée à un usage NON
 * COMMERCIAL. Un cache par (lat, lon, date) évite les appels redondants :
 * mesuré 142 appels pour 173 activités.
 */

const path = require('path');
const fs = require('fs').promises;

process.chdir(path.join(__dirname, '..'));

const weather = require('../weather');
const { WEATHER_RULE, isRainyActivity, getActivityElevation } = require('../shared-config');

// --- Parse args ---
const opts = { league: 'versant-2026', dryRun: false, limit: null, force: false, athlete: null, report: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--force') opts.force = true;
  else if (arg === '--report') opts.report = true;
  else if (arg.startsWith('--league=')) opts.league = arg.slice(9);
  else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.slice(8), 10);
  else if (arg.startsWith('--athlete=')) opts.athlete = String(arg.slice(10));
  else { console.error(`Option inconnue: ${arg}`); process.exit(1); }
}

const pad = (v, n) => String(v).padStart(n);
const padEnd = (v, n) => String(v).padEnd(n);
const athleteIdOf = a => String(a.athlete?.id || a.athlete_id);

(async () => {
  console.log('=== Backfill météo Versant ===');
  console.log('Options:', opts);
  console.log(`Règle: D+ ×${WEATHER_RULE.multiplier} si ≥ ${WEATHER_RULE.minRainMinutes} min de pluie (neige exclue)\n`);

  const activitiesFile = path.join('data/leagues', `${opts.league}_activities.json`);
  const all = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));

  // Sous-ensemble ciblé (les objets restent des références dans `all`,
  // donc l'enrichissement les modifie bien en place avant réécriture).
  const scope = opts.athlete ? all.filter(a => athleteIdOf(a) === opts.athlete) : all;

  const withGeo = scope.filter(weather.hasGeo).length;
  const todo = scope.filter(a => weather.needsWeather(a, { force: opts.force }));

  console.log(`Activités dans le périmètre : ${scope.length}`);
  console.log(`  dont géolocalisées        : ${withGeo}`);
  console.log(`  à traiter                 : ${todo.length}${opts.limit ? ` (plafonné à ${opts.limit})` : ''}\n`);

  if (todo.length === 0) {
    console.log('Rien à faire.');
  } else if (opts.dryRun) {
    console.log('--- DRY RUN : aucun appel API, aucune écriture ---');
    todo.slice(0, opts.limit || 20).forEach(a => {
      console.log(`  ${a.start_date?.slice(0, 16)} ${padEnd(a.athlete_name, 14)} ${padEnd(a.sport_type || a.type, 16)} ${weather.hasGeo(a) ? 'GPS ok' : 'sans GPS'}`);
    });
  } else {
    let done = 0;
    const stats = await weather.enrichActivities(scope, {
      force: opts.force,
      limit: opts.limit,
      onProgress: (activity, wx, i, total) => {
        done++;
        if (done % 25 === 0 || done === total) console.log(`   ... ${done}/${total}`);
      }
    });

    console.log(`\n✅ ${stats.processed} traitée(s) — ${stats.ok} ok, ${stats.rainy} avec pluie, ${stats.noGeo} sans GPS, ${stats.errors} erreur(s)`);

    if (!opts.dryRun && stats.changed) {
      await fs.writeFile(activitiesFile, JSON.stringify(all, null, 2));
      console.log(`💾 ${activitiesFile} mis à jour`);
    }
  }

  if (opts.report) {
    const analysed = scope
      .filter(a => a.weather?.status === 'ok')
      .sort((x, y) => new Date(x.start_date) - new Date(y.start_date));

    console.log('\n--- Rapport ---');
    console.log('date             | athlète        | sport            | dur | D+   | pluie mm | min pluie | neige cm | codes | pluie?');
    for (const a of analysed) {
      const w = a.weather;
      console.log(
        `${a.start_date.slice(0, 16).replace('T', ' ')} | ${padEnd(a.athlete_name || '', 14)} | ` +
        `${padEnd(a.sport_type || a.type || '', 16)} | ${pad(Math.round((a.elapsed_time || 0) / 60), 3)} | ` +
        `${pad(a.total_elevation_gain, 4)} | ${pad(w.rain_mm, 8)} | ${pad(w.rain_minutes, 9)} | ` +
        `${pad(w.snowfall_cm, 8)} | ${padEnd((w.weather_codes || []).join(','), 5)} | ${isRainyActivity(a) ? 'OUI' : ''}`
      );
    }

    const rainy = analysed.filter(isRainyActivity);
    const raw = analysed.reduce((s, a) => s + getActivityElevation(a, null), 0);
    const wet = analysed.reduce((s, a) => s + getActivityElevation(a, 'pluie_qui_mouille'), 0);
    const snowy = analysed.filter(a => (a.weather.snowfall_cm || 0) > 0.1);

    console.log(`\n${rainy.length}/${analysed.length} activité(s) sous la pluie (${(100 * rainy.length / (analysed.length || 1)).toFixed(1)} %)`);
    console.log(`${snowy.length} activité(s) sous la neige (non éligibles : la règle ne compte que la pluie liquide)`);
    console.log(`D+ cumulé — sans la règle : ${Math.round(raw)} m | avec la règle : ${Math.round(wet)} m (+${Math.round(wet - raw)} m)`);
    console.log(`Sans météo exploitable : ${scope.filter(a => a.weather && a.weather.status !== 'ok').length}`);
  }
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
