#!/usr/bin/env node
/**
 * VERSANT - BACKFILL POLYLINE & CHAMPS MANQUANTS
 *
 * Les activités créées via webhook entre l'ouverture du challenge et le fix
 * du webhook ne contiennent pas les champs `map`, `start_latlng`, `average_speed`,
 * `heartrate`, etc. Ce script re-fetche chaque activité concernée via l'API
 * Strava pour remplir ces champs.
 *
 * Utilisation :
 *   cd backend
 *   node scripts/backfill-polyline.js [--league=versant-2026] [--dry-run] [--limit=N]
 *
 * Par défaut : on ne cible que les activités SANS `map` (qui proviennent
 * essentiellement du webhook buggé). Les activités dont le champ `map.summary_polyline`
 * est présent mais vide sont considérées normales (activités sans GPS, trainer, etc.).
 *
 * Attention : ce script fait des appels API Strava. Rate-limit Strava : 600 / 15 min,
 * 30000 / jour par application. Un délai est inséré entre chaque appel pour ne pas
 * saturer.
 */

const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

process.chdir(path.join(__dirname, '..'));

// --- Parse args ---
const args = process.argv.slice(2);
const opts = { league: 'versant-2026', dryRun: false, limit: null, delayMs: 500 };
for (const arg of args) {
  if (arg === '--dry-run') opts.dryRun = true;
  else if (arg.startsWith('--league=')) opts.league = arg.slice(9);
  else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.slice(8), 10);
  else if (arg.startsWith('--delay=')) opts.delayMs = parseInt(arg.slice(8), 10);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Refresh token util (réplique de server.js) ---
async function refreshStravaToken(athlete) {
  try {
    const response = await axios.post('https://www.strava.com/oauth/token', null, {
      params: {
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: athlete.tokens.refresh_token
      }
    });
    return { success: true, ...response.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

(async () => {
  console.log('=== Backfill polyline Versant ===');
  console.log('Options:', opts);

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    console.error('❌ STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET manquants dans env');
    process.exit(1);
  }

  const athletes = JSON.parse(await fs.readFile('data/athletes.json', 'utf8'));
  const activitiesFile = path.join('data/leagues', `${opts.league}_activities.json`);
  const activities = JSON.parse(await fs.readFile(activitiesFile, 'utf8'));

  // Identifier les activités sans map (= champ absent ou null)
  const incomplete = activities.filter(a => !a.map);
  console.log(`Total activités : ${activities.length}`);
  console.log(`Activités sans 'map' : ${incomplete.length}`);

  const toProcess = opts.limit ? incomplete.slice(0, opts.limit) : incomplete;
  console.log(`À traiter : ${toProcess.length}\n`);

  if (opts.dryRun) {
    console.log('--- DRY RUN ---');
    toProcess.forEach(a => {
      console.log(`  - ${a.id} / ${a.athlete_name} / ${a.name} (${a.sport_type || a.type})`);
    });
    process.exit(0);
  }

  // Regrouper par athlète (pour gérer les tokens)
  const byAthlete = new Map();
  for (const a of toProcess) {
    const key = String(a.athlete_id || a.athlete?.id);
    if (!byAthlete.has(key)) byAthlete.set(key, []);
    byAthlete.get(key).push(a);
  }

  let fixed = 0;
  let failed = 0;
  let skippedNoToken = 0;
  const athleteIndex = Object.fromEntries(athletes.map((a, i) => [String(a.id), i]));

  for (const [athleteId, acts] of byAthlete) {
    const idx = athleteIndex[athleteId];
    if (idx === undefined) {
      console.log(`⚠️  Athlète ${athleteId} inconnu, ${acts.length} activités sautées`);
      skippedNoToken += acts.length;
      continue;
    }
    let athlete = athletes[idx];
    let accessToken = athlete.tokens?.access_token;

    if (!accessToken) {
      console.log(`⚠️  Pas de token pour ${athlete.name}, ${acts.length} activités sautées`);
      skippedNoToken += acts.length;
      continue;
    }

    // Refresh si expiré
    const now = Date.now() / 1000;
    if (athlete.tokens.expires_at && athlete.tokens.expires_at < now + 60) {
      console.log(`🔄 Refresh token pour ${athlete.name}`);
      const result = await refreshStravaToken(athlete);
      if (!result.success) {
        console.log(`❌ Refresh échoué pour ${athlete.name} : ${result.error}`);
        skippedNoToken += acts.length;
        continue;
      }
      accessToken = result.access_token;
      athletes[idx].tokens = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at };
      await fs.writeFile('data/athletes.json', JSON.stringify(athletes, null, 2));
    }

    console.log(`\n📥 ${athlete.name} (${acts.length} activités)`);

    for (const a of acts) {
      try {
        const resp = await axios.get(`https://www.strava.com/api/v3/activities/${a.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 20000
        });
        const s = resp.data;

        // Retrouver l'index de l'activité dans la liste globale
        const localIdx = activities.findIndex(x => x.id === a.id);
        if (localIdx < 0) continue;

        activities[localIdx] = {
          ...activities[localIdx],
          map: s.map || null,
          start_latlng: s.start_latlng || null,
          end_latlng: s.end_latlng || null,
          average_speed: s.average_speed,
          max_speed: s.max_speed,
          average_heartrate: s.average_heartrate,
          max_heartrate: s.max_heartrate,
          has_heartrate: s.has_heartrate,
          elev_high: s.elev_high,
          elev_low: s.elev_low,
          trainer: s.trainer,
          manual: s.manual,
          commute: s.commute,
          timezone: s.timezone,
          utc_offset: s.utc_offset,
          location_city: s.location_city,
          location_state: s.location_state,
          location_country: s.location_country,
          backfilled_at: new Date().toISOString()
        };
        const hasPoly = s.map?.summary_polyline ? '✓ polyline' : '(pas de gps)';
        console.log(`   ✅ ${a.id} ${hasPoly}`);
        fixed++;
        await sleep(opts.delayMs);
      } catch (err) {
        const status = err.response?.status;
        const reason = status === 404 ? 'not found' : status === 429 ? 'rate limit' : err.message;
        console.log(`   ❌ ${a.id} : ${reason}`);
        failed++;
        if (status === 429) {
          console.log(`   ⏸️  Rate limit atteint, pause 60s...`);
          await sleep(60000);
        }
      }
    }

    // Sauvegarde intermédiaire après chaque athlète
    await fs.writeFile(activitiesFile, JSON.stringify(activities, null, 2));
  }

  console.log(`\n=== Terminé ===`);
  console.log(`Fixé : ${fixed}`);
  console.log(`Échec : ${failed}`);
  console.log(`Sauté (pas de token) : ${skippedNoToken}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});