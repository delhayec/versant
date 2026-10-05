#!/usr/bin/env node

/**
 * Script de synchronisation manuelle des activités
 * Usage: ADMIN_PASSWORD=… node sync-activities.js [leagueId] [startDate] [endDate]
 *
 * La route de synchro est réservée à l'admin : le mot de passe est lu dans
 * la variable d'environnement ADMIN_PASSWORD.
 */

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';

async function syncActivities(leagueId, startDate, endDate) {
  console.log(`🔄 Synchronisation de la ligue: ${leagueId}`);
  console.log(`📅 Période: ${startDate} → ${endDate}`);
  
  try {
    const response = await axios.post(
      `${API_BASE}/sync/${leagueId}`,
      {
        startDate,
        endDate
      },
      { headers: { 'X-Admin-Password': process.env.ADMIN_PASSWORD || '' } }
    );
    
    const { activities_count, athletes_count, errors } = response.data;
    
    console.log(`✅ Synchronisation réussie!`);
    console.log(`   📊 ${activities_count} activités`);
    console.log(`   👥 ${athletes_count} athlètes`);
    
    if (errors && errors.length > 0) {
      console.log(`⚠️  ${errors.length} erreurs:`);
      errors.forEach(err => {
        console.log(`   - Athlète ${err.athlete_id}: ${err.error}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Erreur de synchronisation:', error.message);
    if (error.response) {
      console.error('   Détails:', error.response.data);
    }
    process.exit(1);
  }
}

// Parse arguments
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log('Usage: node sync-activities.js <leagueId> [startDate] [endDate]');
  console.log('');
  console.log('Exemples:');
  console.log('  node sync-activities.js versant-2026');
  console.log('  node sync-activities.js versant-2026 2026-02-02 2026-02-05');
  process.exit(1);
}

const leagueId = args[0];
const startDate = args[1] || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const endDate = args[2] || new Date().toISOString().split('T')[0];

syncActivities(leagueId, startDate, endDate);
