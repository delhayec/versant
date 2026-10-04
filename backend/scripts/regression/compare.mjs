#!/usr/bin/env node
/**
 * ============================================
 * VERSANT - HARNAIS DE NON-RÉGRESSION : COMPARAISON
 * ============================================
 * Compare deux captures de snapshot.mjs. Le bloc `meta` (date de génération,
 * commit, version de Node) est ignoré : seul le résultat compte.
 *
 * Utilisation :
 *   node backend/scripts/regression/compare.mjs <reference.json> <nouvelle.json>
 *     [--ignore <préfixe de chemin>]...   # écarts ATTENDUS, à lister dans le livrable
 *     [--max 50]                          # nombre d'écarts affichés
 *
 * Code de sortie : 0 si identique, 1 sinon.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = [];
const ignores = [];
let max = 50;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ignore') ignores.push(argv[++i]);
  else if (argv[i] === '--max') max = Number(argv[++i]);
  else files.push(argv[i]);
}
if (files.length !== 2) {
  console.error('Utilisation : compare.mjs <reference.json> <nouvelle.json> [--ignore <chemin>]... [--max N]');
  process.exit(2);
}

const [refPath, newPath] = files;
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const cur = JSON.parse(readFileSync(newPath, 'utf8'));
delete ref.meta;
delete cur.meta;

const diffs = [];
walk(ref, cur, '');

const ignored = diffs.filter(d => ignores.some(p => d.path === p || d.path.startsWith(`${p}.`) || d.path.startsWith(`${p}[`)));
const real = diffs.filter(d => !ignored.includes(d));

if (real.length === 0) {
  console.log(`✅ Identique${ignored.length ? ` (${ignored.length} écart(s) attendu(s) ignoré(s))` : ''}`);
  process.exit(0);
}

console.log(`❌ ${real.length} écart(s)${ignored.length ? `, plus ${ignored.length} attendu(s) ignoré(s)` : ''} :`);
for (const d of real.slice(0, max)) {
  console.log(`  ${d.path || '(racine)'}`);
  console.log(`    référence : ${preview(d.ref)}`);
  console.log(`    nouvelle  : ${preview(d.cur)}`);
}
if (real.length > max) console.log(`  … ${real.length - max} autre(s) écart(s) non affiché(s) (--max pour en voir plus)`);
process.exit(1);

function walk(a, b, path) {
  if (Object.is(a, b)) return;
  const typeA = kind(a);
  const typeB = kind(b);
  if (typeA !== typeB) { diffs.push({ path, ref: a, cur: b }); return; }
  if (typeA === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) diffs.push({ path: `${path}[${i}]`, ref: a[i], cur: b[i] });
      else walk(a[i], b[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeA === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const sub = path ? `${path}.${k}` : k;
      if (!(k in a) || !(k in b)) diffs.push({ path: sub, ref: a[k], cur: b[k] });
      else walk(a[k], b[k], sub);
    }
    return;
  }
  diffs.push({ path, ref: a, cur: b });
}

function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function preview(v) {
  if (v === undefined) return '(absent)';
  const text = JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
