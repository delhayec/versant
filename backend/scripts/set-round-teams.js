#!/usr/bin/env node
/**
 * Verrouille la compo d'un round de saison Équipes dans data/season_teams.json
 * (lue en priorité par /api/teams/round/:n ET par le gel du round).
 *
 * Usage (sur le serveur, depuis la racine du projet) :
 *   node backend/scripts/set-round-teams.js backend/scripts/data/teams_S9_R52.json
 *   node backend/scripts/set-round-teams.js <fichier> --force   # remplace une compo déjà verrouillée
 *
 * Le fichier porte le D+ d'équilibrage SANS correction : les corrections
 * (teamSettings[saison].elevationAdjustments de data/season_planning.json) sont
 * ajoutées ici, pour afficher le même D+ que le tirage d'origine.
 *
 * Redémarrer le serveur ensuite n'est pas nécessaire : /api/teams relit le
 * fichier à chaque requête (cache de 30 s).
 */
const fs = require('fs');
const path = require('path');

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node backend/scripts/set-round-teams.js <fichier.json> [--force]');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEASON_TEAMS_FILE = path.join(DATA_DIR, 'season_teams.json');
const PLANNING_FILE = path.join(DATA_DIR, 'season_planning.json');

const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const { season, round } = input;
const teams = JSON.parse(JSON.stringify(input.teams));

let adjustments = {};
try {
  const planning = JSON.parse(fs.readFileSync(PLANNING_FILE, 'utf8'));
  adjustments = planning?.teamSettings?.[String(season)]?.elevationAdjustments || {};
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
for (const team of teams) {
  team.members.forEach(m => { m.points = Math.round((m.points || 0) + (Number(adjustments[m.id]) || 0)); });
  team.members.sort((a, b) => b.points - a.points);
  team.totalPoints = team.members.reduce((s, m) => s + m.points, 0);
}

const stored = fs.existsSync(SEASON_TEAMS_FILE) ? JSON.parse(fs.readFileSync(SEASON_TEAMS_FILE, 'utf8')) : {};
const seasonEntry = stored[String(season)] || (stored[String(season)] = {});
seasonEntry.rounds = seasonEntry.rounds || {};
const existing = seasonEntry.rounds[String(round)];
if (existing?.teams?.length && flag !== '--force') {
  console.error(`Une compo est déjà verrouillée pour S${season} R${round} (${existing.lockedAt || 'date inconnue'}). --force pour la remplacer.`);
  process.exit(1);
}

if (fs.existsSync(SEASON_TEAMS_FILE)) {
  fs.copyFileSync(SEASON_TEAMS_FILE, `${SEASON_TEAMS_FILE}.bak-${Date.now()}`);
}
seasonEntry.rounds[String(round)] = { teams, lockedAt: new Date().toISOString(), source: input.source || file };
fs.writeFileSync(SEASON_TEAMS_FILE, JSON.stringify(stored, null, 2));

console.log(`S${season} R${round} verrouillé :`);
teams.forEach(t => console.log(`   ${t.animal?.name || '?'} : ${t.members.map(m => `${m.name} (${m.points})`).join(', ')}`));
