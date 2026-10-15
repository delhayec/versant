/**
 * ============================================
 * VERSANT - LECTURE / ÉCRITURE DES FICHIERS JSON
 * ============================================
 * Verrous en mémoire par chemin et écritures atomiques (fichier temporaire puis
 * renommage). Déplacé de server.js à l'identique (L30) : le serveur, la couche
 * de stockage (store/) et le gel partagent ainsi les mêmes verrous.
 */

const fs = require('fs').promises;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// FILE LOCKING
// ============================================
const fileLocks = new Map();

async function acquireLock(filePath, timeout = 15000) {
  const start = Date.now();
  while (fileLocks.get(filePath)) {
    if (Date.now() - start > timeout) {
      console.warn(`⚠️ Lock timeout: ${filePath}`);
      fileLocks.delete(filePath);
      break;
    }
    await sleep(50);
  }
  fileLocks.set(filePath, true);
}

function releaseLock(filePath) {
  fileLocks.delete(filePath);
}

async function safeReadJSON(filePath, defaultValue = []) {
  await acquireLock(filePath);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  } finally {
    releaseLock(filePath);
  }
}

async function safeWriteJSON(filePath, data) {
  await acquireLock(filePath);
  try {
    const tempPath = filePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.rename(tempPath, filePath);
  } finally {
    releaseLock(filePath);
  }
}

/**
 * Lecture-modification-écriture atomique.
 * Le lock est maintenu pendant tout le cycle, éliminant les race conditions.
 * @param {string} filePath - Chemin du fichier JSON
 * @param {Function} modifyFn - Fonction (data) => modifiedData
 * @param {*} defaultValue - Valeur par défaut si le fichier n'existe pas
 * @returns {*} Les données modifiées
 */
async function safeModifyJSON(filePath, modifyFn, defaultValue = []) {
  await acquireLock(filePath);
  try {
    let data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch {
      data = defaultValue;
    }

    const modified = await modifyFn(data);

    const tempPath = filePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(modified, null, 2));
    await fs.rename(tempPath, filePath);

    return modified;
  } finally {
    releaseLock(filePath);
  }
}

module.exports = { acquireLock, releaseLock, safeReadJSON, safeWriteJSON, safeModifyJSON };
