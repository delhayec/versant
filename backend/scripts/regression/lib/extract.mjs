/**
 * ============================================
 * VERSANT - HARNAIS : EXTRACTION DE CODE RÉEL
 * ============================================
 * Certaines étapes de calcul vivent dans du code qu'on ne peut pas importer
 * dans Node : app.js et stats.js manipulent le DOM dès leur chargement, et
 * server.js démarre le serveur. Plutôt que de recopier ces étapes dans le
 * harnais (copie qui finirait par diverger), on extrait leur source à chaque
 * exécution et on l'évalue avec ses dépendances injectées.
 *
 * Si un repère n'est plus trouvé, l'extraction échoue bruyamment : le harnais
 * doit alors être mis à jour, dans un commit séparé (cf. README).
 */

import { readFileSync } from 'node:fs';

export function readSource(path) {
  return readFileSync(path, 'utf8');
}

/** Index de l'accolade fermante correspondant à src[openIdx] === '{'. */
export function findMatchingBrace(src, openIdx) {
  if (src[openIdx] !== '{') throw new Error(`extraction : '{' attendue à l'index ${openIdx}`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('extraction : accolade fermante introuvable');
}

function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('extraction : parenthèse fermante introuvable');
}

function skipQuoted(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j;
    if (src[j] === '\n') throw new Error(`extraction : chaîne non terminée à l'index ${i}`);
  }
  throw new Error('extraction : chaîne non terminée');
}

function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j;
    if (src[j] === '$' && src[j + 1] === '{') j = findMatchingBrace(src, j + 1);
  }
  throw new Error('extraction : gabarit non terminé');
}

/** Source d'une fonction déclarée en début de ligne (`function nom(` ou `async function nom(`). */
export function extractFunction(src, name, file) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const match = re.exec(src);
  if (!match) throw new Error(`${file} : fonction ${name} introuvable — le harnais doit être mis à jour`);
  const parenOpen = match.index + match[0].length - 1;
  const parenClose = findMatchingParen(src, parenOpen);
  const braceOpen = src.indexOf('{', parenClose);
  const braceClose = findMatchingBrace(src, braceOpen);
  return src.slice(match.index, braceClose + 1).replace(/^export\s+/, '');
}

/** Déclaration `const NOM = … ;` tenant sur une ligne, en début de ligne. */
export function extractConst(src, name, file) {
  const re = new RegExp(`^const\\s+${name}\\s*=[^\\n]*;[ \\t]*$`, 'm');
  const match = re.exec(src);
  if (!match) throw new Error(`${file} : constante ${name} introuvable — le harnais doit être mis à jour`);
  return match[0];
}

/** Texte compris entre deux repères (inclus). Le repère de début doit être unique. */
export function extractBetween(src, startMarker, endMarker, file) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`${file} : repère introuvable — ${startMarker}`);
  if (src.indexOf(startMarker, start + 1) >= 0) throw new Error(`${file} : repère non unique — ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`${file} : repère de fin introuvable — ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

/**
 * Évalue un extrait en mode strict (comme un module ES), ses dépendances étant
 * injectées par nom, et renvoie la valeur de `returnExpr`.
 */
export function compile(code, returnExpr, deps = {}) {
  const names = Object.keys(deps);
  const factory = new Function(...names, `"use strict";\n${code}\nreturn (${returnExpr});`);
  return factory(...names.map(n => deps[n]));
}

/** Variante asynchrone : l'extrait peut contenir des `await`. */
export function compileAsync(code, returnExpr, deps = {}) {
  const names = Object.keys(deps);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const factory = new AsyncFunction(...names, `"use strict";\n${code}\nreturn (${returnExpr});`);
  return factory(...names.map(n => deps[n]));
}
