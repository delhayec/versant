#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - MIGRATION VERS L'ORGANISATION « EDITIONS » (L31)
 * ============================================
 * Usage (serveur ARRÊTÉ, données sauvegardées) :
 *   node backend/scripts/migrate-editions.js aller    [--data <dossier>] [--force]
 *   node backend/scripts/migrate-editions.js verifier [--data <dossier>]
 *   node backend/scripts/migrate-editions.js retour   [--data <dossier>]
 *
 * aller    : crée la nouvelle organisation à côté de l'ancienne (cf. store/editions.js).
 *            Ne supprime ni ne modifie aucun fichier existant. Vérifie ensuite que
 *            la vue reconstruite est identique, octet pour octet, à l'ancien fichier
 *            d'activités, et que les fichiers de l'édition sont des copies exactes.
 * verifier : compare les deux organisations (code de sortie 1 en cas d'écart).
 * retour   : réécrit les anciens fichiers à partir de la nouvelle organisation
 *            (après des écritures faites depuis la bascule) ; les fichiers écrasés
 *            sont d'abord copiés dans retour-sauvegarde-<date>/.
 *
 * Par défaut, --data est backend/data (ou VERSANT_DATA_DIR).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Édition historique : ligue « versant », édition « 2026 » (décision du 15/10)
const LEAGUE = { id: 'versant', name: 'Versant' };
const EDITION = { id: '2026', legacyId: 'versant-2026' };
const EDITION_FILES = [
  'frozen_results.json', 'jokers_usage.json', 'bonuses.json', 'pending_bonus_choices.json',
  'round_configs.json', 'season_teams.json', 'special_rules.json', 'season_planning.json'
];

const args = process.argv.slice(2);
const command = args[0];
const option = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const dataDir = path.resolve(option('data') || process.env.VERSANT_DATA_DIR || path.join(__dirname, '..', 'data'));
const force = args.includes('--force');

const legacyActivitiesFile = path.join(dataDir, 'leagues', `${EDITION.legacyId}_activities.json`);
const editionDir = path.join(dataDir, 'leagues', LEAGUE.id, 'editions', EDITION.id);
const activitiesDir = path.join(dataDir, 'activities');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

async function editionsView() {
  // Le stockage lit DATA_DIR au chargement : on le pointe sur le dossier traité
  process.env.VERSANT_DATA_DIR = dataDir;
  const { createEditionsStore } = require('../store/editions');
  return createEditionsStore({ dataDir }).readActivities(EDITION.legacyId);
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function compare() {
  const report = { activities: null, files: {} };
  const original = fs.readFileSync(legacyActivitiesFile, 'utf8');
  const rebuilt = JSON.stringify(await editionsView(), null, 2);
  report.activities = {
    identical: rebuilt === original,
    originalCanonical: JSON.stringify(JSON.parse(original), null, 2) === original,
    count: JSON.parse(original).length
  };
  for (const name of EDITION_FILES) {
    const flat = path.join(dataDir, name);
    const copy = path.join(editionDir, name);
    if (!fs.existsSync(flat) && !fs.existsSync(copy)) continue;
    report.files[name] = fs.existsSync(flat) && fs.existsSync(copy) && sha256(flat) === sha256(copy)
      ? 'identique'
      : 'DIFFÉRENT';
  }
  report.identical = report.activities.identical && Object.values(report.files).every(v => v === 'identique');
  return report;
}

function printReport(report) {
  const a = report.activities;
  console.log(`   activités : ${a.count}, vue reconstruite ${a.identical ? 'identique octet pour octet' : 'DIFFÉRENTE'} de l'ancien fichier`);
  if (!a.originalCanonical) console.log('   ⚠️ l\'ancien fichier n\'est pas au format JSON indenté habituel : comparaison stricte impossible');
  for (const [name, state] of Object.entries(report.files)) console.log(`   ${state === 'identique' ? '✓' : '✗'} ${name} : ${state}`);
}

async function aller() {
  if (!fs.existsSync(legacyActivitiesFile)) fail(`fichier d'activités introuvable : ${legacyActivitiesFile}`);
  if (!force && (fs.existsSync(editionDir) || fs.existsSync(activitiesDir))) {
    fail('la nouvelle organisation existe déjà (--force pour la recréer)');
  }

  // Règle 4 : jokers_usage.json doit rester un tableau plat
  const jokersFile = path.join(dataDir, 'jokers_usage.json');
  if (fs.existsSync(jokersFile) && !Array.isArray(readJSON(jokersFile))) fail('jokers_usage.json n\'est pas un tableau plat : migration refusée');

  const { splitExclusion, ownerOf } = require('../store/editions');
  const activities = readJSON(legacyActivitiesFile);
  const athletes = fs.existsSync(path.join(dataDir, 'athletes.json')) ? readJSON(path.join(dataDir, 'athletes.json')) : [];
  const members = new Set(athletes.filter(a => a.league_id === EDITION.legacyId).map(a => String(a.id)));

  if (force) {
    fs.rmSync(editionDir, { recursive: true, force: true });
    fs.rmSync(activitiesDir, { recursive: true, force: true });
  }

  // Activités : une seule copie par utilisateur, seq = position dans l'ancien fichier
  const byUser = new Map();
  const exclusions = {};
  activities.forEach((activity, index) => {
    const { base, fields } = splitExclusion(activity);
    if (fields.length > 0) exclusions[String(activity.id)] = fields;
    const owner = ownerOf(activity);
    if (!byUser.has(owner)) byUser.set(owner, []);
    byUser.get(owner).push({ seq: index + 1, activity: base });
  });
  for (const [userId, entries] of byUser) writeJSON(path.join(activitiesDir, `${userId}.json`), entries);
  writeJSON(path.join(activitiesDir, '_seq.json'), { next: activities.length + 1 });

  // Ligue, édition et copie exacte de ses fichiers
  writeJSON(path.join(dataDir, 'leagues', LEAGUE.id, 'league.json'), LEAGUE);
  const formerParticipants = [...byUser.keys()].filter(id => !members.has(id)).sort();
  writeJSON(path.join(editionDir, 'edition.json'), {
    id: EDITION.id,
    legacyId: EDITION.legacyId,
    // Pas de bornes : la vue reprend tout l'ancien fichier (première activité avant le départ)
    activities: { from: null, to: null },
    formerParticipants
  });
  writeJSON(path.join(editionDir, 'exclusions.json'), exclusions);
  for (const name of EDITION_FILES) {
    const flat = path.join(dataDir, name);
    if (fs.existsSync(flat)) fs.copyFileSync(flat, path.join(editionDir, name));
  }

  console.log(`✅ Aller : ${activities.length} activités réparties sur ${byUser.size} utilisateurs, ${Object.keys(exclusions).length} exclusion(s)`);
  if (formerParticipants.length) console.log(`   anciens participants (absents d'athletes.json) : ${formerParticipants.join(', ')}`);
  const report = await compare();
  printReport(report);
  if (!report.identical) fail('vérification échouée : ne pas basculer');
  console.log('   ✅ vérification réussie');
}

async function verifier() {
  const report = await compare();
  printReport(report);
  if (!report.identical) process.exit(1);
  console.log('✅ Les deux organisations sont identiques');
}

async function retour() {
  if (!fs.existsSync(editionDir)) fail(`nouvelle organisation introuvable : ${editionDir}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, `retour-sauvegarde-${stamp}`);
  const changed = [];
  const backup = file => {
    if (!fs.existsSync(file)) return;
    const target = path.join(backupDir, path.relative(dataDir, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  };

  const view = JSON.stringify(await editionsView(), null, 2);
  const current = fs.existsSync(legacyActivitiesFile) ? fs.readFileSync(legacyActivitiesFile, 'utf8') : null;
  if (view !== current) {
    backup(legacyActivitiesFile);
    fs.mkdirSync(path.dirname(legacyActivitiesFile), { recursive: true });
    fs.writeFileSync(legacyActivitiesFile, view);
    changed.push(path.relative(dataDir, legacyActivitiesFile));
  }
  for (const name of EDITION_FILES) {
    const copy = path.join(editionDir, name);
    const flat = path.join(dataDir, name);
    if (!fs.existsSync(copy)) continue;
    if (fs.existsSync(flat) && sha256(flat) === sha256(copy)) continue;
    backup(flat);
    fs.copyFileSync(copy, flat);
    changed.push(name);
  }
  if (changed.length === 0) console.log('✅ Retour : les anciens fichiers étaient déjà à jour');
  else console.log(`✅ Retour : ${changed.length} fichier(s) réécrit(s) depuis la nouvelle organisation : ${changed.join(', ')}\n   anciennes versions : ${backupDir}`);
}

const commands = { aller, verifier, retour };
if (!commands[command]) {
  console.log('Usage : node backend/scripts/migrate-editions.js <aller|verifier|retour> [--data <dossier>] [--force]');
  process.exit(command ? 1 : 0);
}
console.log(`📁 Données : ${dataDir}`);
commands[command]().catch(error => fail(error.stack || error.message));
