#!/usr/bin/env node
/**
 * Corrections ponctuelles de frozen_results.json, relevées par l'audit des
 * points du classement général (15/10/2026). Idempotent, sauvegarde avant écriture.
 *
 *  - R44 (finale de fait de la S7) : Leo B, seul survivant après les 2
 *    éliminations, n'avait ni points de vainqueur ni flag isWinner (le gel ne
 *    les attribuait qu'aux finales prévues). Le total du classement général
 *    les comptait déjà ; les colonnes par saison et la page Stats non.
 *  - R48 : Mariana S, rescapée au R47 puis au R48, était enregistrée avec
 *    « consécutif : 1 » au lieu de 2 (+2 pts). Le total les comptait déjà ;
 *    l'historique du round affichait « 1er jeton ».
 *
 * Usage (racine du projet) : node backend/scripts/fix-points-s7-s8.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'frozen_results.json');
const dryRun = process.argv.includes('--dry-run');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const changes = [];

// --- Leo B, vainqueur de la S7 (R44) ---
const LEO = '100399073';
const r44 = data.rounds?.['44'];
if (!r44 || Number(r44.seasonNumber) !== 7) throw new Error('R44 introuvable ou pas en saison 7');
const leo = r44.ranking.find(e => String(e.id) === LEO);
if (!leo) throw new Error('Leo B absent du classement du R44');
if (r44.eliminations.some(e => String(e.id) === LEO)) throw new Error('Leo B est éliminé au R44 : correction non applicable');
if (leo.mainPoints !== 24 || leo.isWinner !== true) {
  changes.push(`R44 Leo B : mainPoints ${leo.mainPoints ?? '∅'} → 24, isWinner ${leo.isWinner ?? '∅'} → true`);
  leo.mainPoints = 24;
  leo.isWinner = true;
}
if (r44.rescapeInfo) {
  changes.push(`R44 : rescapeInfo (${r44.rescapeInfo.athleteName}) retiré, le dernier survivant est le vainqueur`);
  r44.rescapeInfo = null;
}

// --- Mariana S, rescapée 2 rounds de suite (R47, R48) ---
const MARIANA = '1841009';
const r47 = data.rounds?.['47'];
const r48 = data.rounds?.['48'];
if (String(r47?.rescapeInfo?.athleteId) === MARIANA && String(r48?.rescapeInfo?.athleteId) === MARIANA
    && Number(r47.seasonNumber) === Number(r48.seasonNumber)) {
  const expected = (r47.rescapeInfo.consecutive || 1) + 1;
  if (r48.rescapeInfo.consecutive !== expected || r48.rescapeInfo.points !== 2) {
    changes.push(`R48 Mariana S : rescapé consécutif ${r48.rescapeInfo.consecutive} → ${expected}, points ${r48.rescapeInfo.points} → 2`);
    r48.rescapeInfo.consecutive = expected;
    r48.rescapeInfo.points = 2;
  }
} else {
  console.warn('⚠️ R47/R48 : rescapé attendu (Mariana S) non trouvé, correction ignorée');
}

if (changes.length === 0) {
  console.log('Rien à corriger (déjà appliqué).');
  process.exit(0);
}
changes.forEach(c => console.log('  • ' + c));
if (dryRun) {
  console.log('--dry-run : rien écrit.');
  process.exit(0);
}
const backup = `${FILE}.bak-${Date.now()}`;
fs.copyFileSync(FILE, backup);
data.lastUpdated = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log(`✅ Corrigé (sauvegarde : ${path.basename(backup)})`);
