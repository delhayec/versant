/**
 * ============================================
 * VERSANT - APPLICATION DÉMO (2025)
 * ============================================
 * Version de démonstration utilisant les données 2025
 * avec slider de navigation temporelle
 */

// Import de l'application principale
import * as app from './app.js';

// Configuration spécifique démo
const DEMO_CONFIG = {
  dataFile: 'data/all_activities_2025.json',
  year: 2025,
  enableDateSlider: true,
  defaultDate: '2025-12-31' // Affiche la fin de l'année par défaut
};

// Initialisation en mode démo
console.log('🎬 Mode Démonstration - Challenge 2025');

// L'application principale sera chargée avec les données 2025
// Le slider de date est automatiquement activé via le DOM
