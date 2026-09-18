/**
 * ============================================
 * VERSANT - MÉTÉO DES ACTIVITÉS (Open-Meteo)
 * ============================================
 *
 * Seul endroit du projet qui parle à une API météo. Aucune clé API, aucun compte,
 * aucune variable d'environnement à ajouter.
 *
 * Principe : pour une activité, on croise son point de départ (start_latlng) et sa
 * fenêtre temporelle [start_date, start_date + elapsed_time] avec l'historique
 * météo, et on en tire de quoi décider si elle s'est déroulée "sous la pluie"
 * (règle spéciale de round `pluie_qui_mouille`).
 *
 * API : Open-Meteo Historical Forecast (historical-forecast-api.open-meteo.com).
 * Choisie plutôt que l'archive ERA5 car :
 *   - résolution ~2-11 km au lieu de 9 km, ce qui compte en montagne ;
 *   - pas de délai de 5 jours (données disponibles le jour même) ;
 *   - résolution minutely_15, testée disponible y compris hors Europe.
 * ⚠️ L'offre gratuite Open-Meteo est réservée à un usage NON COMMERCIAL.
 *
 * On stocke les MESURES BRUTES (mm, minutes, intensité, codes WMO) et pas
 * seulement le booléen : le seuil peut ainsi être retouché plus tard sans
 * refrapper l'API (cf. scripts/backfill-weather.js --force).
 */

const axios = require('axios');

const OPEN_METEO_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

// Politesse réseau — même motif que scripts/backfill-polyline.js
const REQUEST_TIMEOUT_MS = 20000;
const DELAY_BETWEEN_CALLS_MS = 250;
const RATE_LIMIT_WAIT_MS = 60000;

// Une donnée météo n'est verrouillée (plus jamais recalculée) qu'une fois
// l'activité suffisamment ancienne : pour l'heure en cours, Open-Meteo sert
// encore une sortie de modèle de prévision, révisable a posteriori. Sans ce
// verrou, un athlète pourrait voir son bonus apparaître puis disparaître.
const LOCK_AFTER_MS = 24 * 3600 * 1000;

// Seuil au-delà duquel un créneau est considéré comme pluvieux (mm sur le créneau).
// 0,05 mm filtre le bruit numérique du modèle sans rater une bruine réelle.
const WET_SLOT_MM = 0.05;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cache par (lat arrondie, lon arrondie, plage de dates). Mesuré sur données
// réelles : 142 appels au lieu de 173. Deux athlètes sortis ensemble ne coûtent
// qu'un seul appel.
const _cache = new Map();

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function hasGeo(activity) {
  return Array.isArray(activity?.start_latlng)
    && activity.start_latlng.length === 2
    && Number.isFinite(activity.start_latlng[0])
    && Number.isFinite(activity.start_latlng[1]);
}

/**
 * Fenêtre temporelle de l'activité, en millisecondes epoch.
 * On utilise elapsed_time (et non moving_time) : c'est le temps réellement passé
 * dehors, donc exposé à la pluie. Cohérent avec getActivityEndTime() côté frontend.
 */
function activityWindow(activity) {
  const start = new Date(activity.start_date).getTime();
  const end = start + (activity.elapsed_time || 0) * 1000;
  return { start, end };
}

/**
 * Agrège une série temporelle Open-Meteo sur la fenêtre de l'activité.
 *
 * Convention Open-Meteo : la valeur horodatée T est la somme de l'intervalle
 * PRÉCÉDENT, soit (T - step, T]. On pondère chaque intervalle par sa fraction
 * de recouvrement avec la sortie, pour ne pas compter une averse tombée avant
 * le départ ou après l'arrivée.
 */
function accumulate(times, values, stepMs, windowStart, windowEnd) {
  let total = 0;
  let wetSlots = 0;
  let slots = 0;
  let maxRate = 0;

  times.forEach((t, i) => {
    const slotEnd = new Date(`${t}Z`).getTime();
    const slotStart = slotEnd - stepMs;
    const overlap = Math.max(0, Math.min(windowEnd, slotEnd) - Math.max(windowStart, slotStart));
    if (overlap <= 0) return;

    const value = values[i] || 0;
    slots++;
    total += value * (overlap / stepMs);
    if (value > WET_SLOT_MM) wetSlots++;
    if (value > maxRate) maxRate = value;
  });

  return { total, wetSlots, slots, maxRate, stepMinutes: stepMs / 60000 };
}

async function fetchOpenMeteo(lat, lon, startDate, endDate) {
  const key = `${lat.toFixed(2)}|${lon.toFixed(2)}|${startDate}|${endDate}`;
  if (_cache.has(key)) return _cache.get(key);

  const params = {
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: startDate,
    end_date: endDate,
    hourly: 'rain,snowfall,precipitation,weather_code',
    minutely_15: 'rain,precipitation',
    timezone: 'UTC'
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(DELAY_BETWEEN_CALLS_MS);
      const response = await axios.get(OPEN_METEO_URL, { params, timeout: REQUEST_TIMEOUT_MS });
      _cache.set(key, response.data);
      return response.data;
    } catch (error) {
      lastError = error;
      if (error.response?.status === 429) {
        console.log(`   ⏳ Open-Meteo rate limit, attente ${RATE_LIMIT_WAIT_MS / 1000}s...`);
        await sleep(RATE_LIMIT_WAIT_MS);
      } else if (attempt < 3) {
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastError || new Error('open-meteo unreachable');
}

/**
 * Calcule la météo d'une activité.
 *
 * @returns {object} toujours un objet, jamais null — `status` porte l'échec :
 *   - 'ok'     : mesures exploitables
 *   - 'no_geo' : activité sans coordonnées (indoor, home trainer, saisie manuelle)
 *   - 'error'  : API injoignable ou réponse inexploitable
 */
async function fetchActivityWeather(activity) {
  const base = {
    provider: 'open-meteo',
    model: 'historical-forecast',
    fetched_at: new Date().toISOString()
  };

  if (!hasGeo(activity)) {
    return { ...base, status: 'no_geo', locked: true };
  }

  const [lat, lon] = activity.start_latlng;
  const { start, end } = activityWindow(activity);

  let data;
  try {
    data = await fetchOpenMeteo(lat, lon, isoDate(start), isoDate(end));
  } catch (error) {
    return { ...base, status: 'error', error: error.message, locked: false };
  }

  if (!data?.hourly?.time) {
    return { ...base, status: 'error', error: 'no_hourly_data', locked: false };
  }

  // minutely_15 quand disponible (créneaux de 15 min = détection fine d'une
  // averse sur une sortie d'une heure), repli horaire sinon.
  const useMinutely = Array.isArray(data.minutely_15?.time)
    && Array.isArray(data.minutely_15?.rain);

  const rain = useMinutely
    ? accumulate(data.minutely_15.time, data.minutely_15.rain, 900000, start, end)
    : accumulate(data.hourly.time, data.hourly.rain, 3600000, start, end);

  // Neige et intensité max restent lus à l'heure : seule la pluie a besoin de finesse.
  const snow = accumulate(data.hourly.time, data.hourly.snowfall, 3600000, start, end);
  const hourlyRain = accumulate(data.hourly.time, data.hourly.rain, 3600000, start, end);

  const codes = data.hourly.time
    .map((t, i) => {
      const slotEnd = new Date(`${t}Z`).getTime();
      return (slotEnd > start && slotEnd - 3600000 < end) ? data.hourly.weather_code[i] : null;
    })
    .filter(c => c !== null && c !== undefined);

  const activityEnd = end;
  const locked = Date.now() >= activityEnd + LOCK_AFTER_MS;

  return {
    ...base,
    status: 'ok',
    resolution: useMinutely ? 'minutely_15' : 'hourly',
    rain_mm: Math.round(rain.total * 100) / 100,
    rain_minutes: rain.wetSlots * rain.stepMinutes,
    max_rain_rate: hourlyRain.maxRate,
    snowfall_cm: Math.round(snow.total * 100) / 100,
    weather_codes: [...new Set(codes)],
    lat: data.latitude,
    lon: data.longitude,
    locked
  };
}

/**
 * Une activité doit-elle être (re)calculée ?
 * On recalcule tant que la donnée n'est pas verrouillée, pour rattraper les
 * révisions du modèle sur les heures récentes.
 */
function needsWeather(activity, { force = false } = {}) {
  if (force) return true;
  if (!activity.weather) return true;
  return activity.weather.locked !== true;
}

/**
 * Enrichit une liste d'activités en place.
 *
 * @param {Array} activities - modifiées en place (champ `weather` ajouté/mis à jour)
 * @param {object} options
 * @param {boolean} options.force  - recalcule même les données verrouillées
 * @param {number}  options.limit  - plafonne le nombre d'activités traitées
 * @param {function} options.onProgress - callback(activity, weather, index, total)
 * @returns {{processed:number, ok:number, noGeo:number, errors:number, rainy:number, changed:boolean}}
 */
async function enrichActivities(activities, options = {}) {
  const { force = false, limit = null, onProgress = null } = options;

  const todo = activities.filter(a => needsWeather(a, { force }));
  const batch = limit ? todo.slice(0, limit) : todo;

  const stats = { processed: 0, ok: 0, noGeo: 0, errors: 0, rainy: 0, changed: false };

  for (let i = 0; i < batch.length; i++) {
    const activity = batch[i];
    const weather = await fetchActivityWeather(activity);

    activity.weather = weather;
    stats.processed++;
    stats.changed = true;

    if (weather.status === 'ok') {
      stats.ok++;
      if ((weather.rain_minutes || 0) > 0) stats.rainy++;
    } else if (weather.status === 'no_geo') {
      stats.noGeo++;
    } else {
      stats.errors++;
    }

    if (onProgress) onProgress(activity, weather, i, batch.length);
  }

  return stats;
}

function clearCache() {
  _cache.clear();
}

module.exports = {
  fetchActivityWeather,
  enrichActivities,
  needsWeather,
  hasGeo,
  activityWindow,
  clearCache,
  OPEN_METEO_URL
};
