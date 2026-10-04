#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - HARNAIS : CRÉATION D'UNE FIXTURE
 * ============================================
 * Copie figée et anonymisée des données d'une ligue, point de départ de toutes
 * les comparaisons avant/après.
 *
 * Utilisation (serveur ou poste local) :
 *   node backend/scripts/regression/make-fixture.mjs \
 *     --from <dossier data>            # ex. /opt/versant-api/backend/data
 *     --out <dossier fixture>          # HORS du dépôt git (données personnelles)
 *     [--league versant-2026]
 *     [--round-configs <fichier>]      # si round_configs.json n'est pas dans --from
 *     [--special-rules <fichier>]
 *
 * Anonymisation :
 *   - athletes.json : seuls id, name, league_id, active, registered_at,
 *     active_from_round et active_from_season sont conservés (ni e-mail, ni
 *     hash, ni tokens Strava, ni profil) ;
 *   - activités : suppression des traces, coordonnées, lieux et fréquences
 *     cardiaques, que le calcul n'utilise pas.
 * Les autres fichiers sont copiés tels quels (données de jeu).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activitiesPath, OPTIONAL_FILES, REQUIRED_FILES } from './lib/fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const ATHLETE_KEYS = ['id', 'name', 'league_id', 'active', 'registered_at', 'active_from_round', 'active_from_season'];
const ACTIVITY_DROPPED_KEYS = [
  'map', 'start_latlng', 'end_latlng',
  'location_city', 'location_state', 'location_country',
  'average_heartrate', 'max_heartrate', 'heartrate_opt_out', 'display_hide_heartrate_option',
  'gear_id', 'device_name', 'external_id', 'upload_id', 'upload_id_str', 'photos'
];
const WEATHER_DROPPED_KEYS = ['lat', 'lon'];

const args = parseArgs(process.argv.slice(2));
const from = resolve(required(args.from, '--from'));
const out = resolve(required(args.out, '--out'));
const leagueId = args.league || 'versant-2026';

if (isInside(out, REPO_ROOT) && !args['allow-in-repo']) {
  fail(`--out pointe dans le dépôt git (${out}). Une fixture contient des données personnelles : choisis un dossier hors du dépôt.`);
}
if (existsSync(join(out, 'fixture.json'))) fail(`Une fixture existe déjà dans ${out}. Choisis un autre dossier.`);

const sources = {};
for (const file of REQUIRED_FILES) {
  const override = file === 'round_configs.json' ? args['round-configs'] : null;
  const p = override ? resolve(override) : join(from, file);
  if (!existsSync(p)) {
    const hint = file === 'round_configs.json'
      ? ' (absent de la sauvegarde versant-data : le passer avec --round-configs)'
      : '';
    fail(`${file} introuvable : ${p}${hint}`);
  }
  sources[file] = p;
}
for (const file of OPTIONAL_FILES) {
  const override = file === 'special_rules.json' ? args['special-rules'] : null;
  const p = override ? resolve(override) : join(from, file);
  if (existsSync(p)) sources[file] = p;
}
const actRel = activitiesPath(leagueId);
sources[actRel] = join(from, actRel);
if (!existsSync(sources[actRel])) fail(`Activités introuvables : ${sources[actRel]}`);

const outData = join(out, 'data');
mkdirSync(join(outData, 'leagues'), { recursive: true });

const written = {};
for (const [rel, src] of Object.entries(sources)) {
  let text = readFileSync(src, 'utf8');
  if (rel === 'athletes.json') text = JSON.stringify(anonymizeAthletes(JSON.parse(text)), null, 2);
  if (rel === actRel) text = JSON.stringify(anonymizeActivities(JSON.parse(text)), null, 2);
  JSON.parse(text); // tout fichier copié doit être un JSON valide
  writeFileSync(join(outData, rel), text);
  written[rel.split(sep).join('/')] = sha256(text);
}

const frozen = JSON.parse(readFileSync(join(outData, 'frozen_results.json'), 'utf8'));
const activities = JSON.parse(readFileSync(join(outData, actRel), 'utf8'));
const latestActivityEnd = activities
  .map(a => new Date(a.start_date).getTime() + (a.elapsed_time || 0) * 1000)
  .filter(Number.isFinite)
  .reduce((max, t) => Math.max(max, t), 0);

// Instant de référence : celui du snapshot de classement envoyé par un
// navigateur s'il existe (il sert au contrôle de fidélité), sinon le plus
// récent des horodatages connus.
const capturedAt = frozen.yearlyStandingsSnapshot?.updatedAt
  || new Date(Math.max(Date.parse(frozen.lastUpdated || 0) || 0, latestActivityEnd)).toISOString();

const meta = {
  format: 1,
  leagueId,
  createdAt: new Date().toISOString(),
  source: from,
  roundConfigsSource: args['round-configs'] ? resolve(args['round-configs']) : join(from, 'round_configs.json'),
  capturedAt,
  anonymization: {
    athletesKeptKeys: ATHLETE_KEYS,
    activitiesDroppedKeys: ACTIVITY_DROPPED_KEYS,
    weatherDroppedKeys: WEATHER_DROPPED_KEYS
  },
  files: written
};
writeFileSync(join(out, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');

console.log(`✅ Fixture créée : ${out}`);
console.log(`   ligue ${leagueId}, instant de référence ${capturedAt}`);
console.log(`   ${Object.keys(frozen.rounds || {}).length} rounds figés, ${activities.length} activités`);
for (const [rel, hash] of Object.entries(written)) console.log(`   ${hash.slice(0, 12)}  ${rel}`);

function anonymizeAthletes(list) {
  if (!Array.isArray(list)) fail('athletes.json : tableau attendu');
  return list.map(a => Object.fromEntries(ATHLETE_KEYS.filter(k => k in a).map(k => [k, a[k]])));
}

function anonymizeActivities(list) {
  if (!Array.isArray(list)) fail('activités : tableau attendu');
  return list.map(a => {
    const copy = { ...a };
    for (const k of ACTIVITY_DROPPED_KEYS) delete copy[k];
    if (copy.weather && typeof copy.weather === 'object') {
      copy.weather = { ...copy.weather };
      for (const k of WEATHER_DROPPED_KEYS) delete copy.weather[k];
    }
    return copy;
  });
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
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
  if (!value || value === true) fail(`Option ${name} obligatoire`);
  return value;
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}
