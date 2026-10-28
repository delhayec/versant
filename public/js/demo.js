/**
 * ============================================
 * VERSANT - DATE COURANTE
 * ============================================
 * Date utilisée par les pages : la date réelle, ou une date simulée posée à la
 * main (window.versant.setSimulatedDate dans la console, pour tester une date
 * donnée). Le curseur de dates et le menu « aller à une date » de l'ancienne
 * démo 2025 ont été retirés (L52 : démo animée, demo-tour.js).
 */

// ============================================
// GESTION DE LA DATE SIMULÉE
// ============================================
let simulatedDate = null;

/**
 * Définit la date simulée
 * @param {Date|string|null} date - Date à simuler ou null pour la date réelle
 */
export function setSimulatedDate(date) {
  simulatedDate = date ? new Date(date) : null;
}

/**
 * Récupère la date courante (simulée ou réelle)
 * @returns {Date}
 */
export function getCurrentDate() {
  return simulatedDate ? new Date(simulatedDate) : new Date();
}

/**
 * Vérifie si on est en mode démo (date simulée active)
 */
export function isDemoMode() {
  return simulatedDate !== null;
}

/**
 * Réinitialise à la date réelle
 */
export function resetToRealDate() {
  simulatedDate = null;
}
