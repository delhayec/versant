const API_BASE = '/api';
const LEAGUE_ID = 'versant-2026';
let adminPassword = null;
let allActivities = [];
let athletesCache = {}; // id -> athlète, pour résoudre les noms

// ============================================
// UTILITAIRES
// ============================================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('fr-FR') : '-';
}

/**
 * fetch vers l'API avec le mot de passe admin. Un 401 signifie que le mot de
 * passe stocké n'est plus valide : on renvoie vers l'écran de connexion.
 */
async function adminFetch(path, options = {}) {
  const headers = { 'X-Admin-Password': adminPassword, ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (response.status === 401) {
    logout();
    throw new Error('Session admin expirée, reconnectez-vous');
  }
  return response;
}

/** Comme adminFetch, mais renvoie le JSON et lève l'erreur renvoyée par le serveur. */
async function adminJson(path, options) {
  const response = await adminFetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
  return data;
}

async function downloadFrom(path, filename) {
  const response = await adminFetch(path);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Erreur téléchargement');
  }
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

function addLog(message) {
  const container = document.getElementById('logsContainer');
  if (container.dataset.empty !== 'false') {
    container.innerHTML = '';
    container.dataset.empty = 'false';
  }
  const time = new Date().toLocaleTimeString('fr-FR');
  const entry = document.createElement('div');
  entry.innerHTML = `<span class="muted">[${time}]</span> ${escapeHtml(message)}`;
  container.insertBefore(entry, container.firstChild);
}

// ============================================
// AUTHENTIFICATION
// ============================================
function checkAuth() {
  const stored = localStorage.getItem('versant_admin_password');
  if (stored) {
    try {
      adminPassword = atob(stored);
    } catch (e) {
      // Ancien format (en clair) : migration
      adminPassword = stored;
      localStorage.setItem('versant_admin_password', btoa(stored));
    }
  }
  if (adminPassword) showDashboard();
  else showLogin();
}

function showLogin() {
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('adminDashboard').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('adminDashboard').style.display = 'block';

  const today = new Date();
  const weekAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
  document.getElementById('syncEndDate').value = today.toISOString().split('T')[0];
  document.getElementById('syncStartDate').value = weekAgo.toISOString().split('T')[0];

  loadDashboardData();
}

function logout() {
  localStorage.removeItem('versant_admin_password');
  adminPassword = null;
  showLogin();
}

document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('adminPassword').value;
  const errorBox = document.getElementById('loginError');

  try {
    const response = await fetch(`${API_BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) throw new Error('Mot de passe incorrect');

    adminPassword = password;
    // base64 = simple obfuscation dans le localStorage, pas une protection
    localStorage.setItem('versant_admin_password', btoa(password));
    errorBox.style.display = 'none';
    showDashboard();
    addLog('✅ Connexion admin réussie');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', (e) => {
  e.preventDefault();
  logout();
});

// ============================================
// CHARGEMENT GLOBAL
// ============================================
async function loadDashboardData() {
  try {
    const [athletesRes, activitiesRes] = await Promise.all([
      fetch(`${API_BASE}/athletes/${LEAGUE_ID}`),
      fetch(`${API_BASE}/activities/${LEAGUE_ID}`)
    ]);
    const athletes = await athletesRes.json();
    allActivities = await activitiesRes.json();

    athletesCache = {};
    athletes.forEach(a => { athletesCache[String(a.id)] = a; });

    document.getElementById('statAthletes').textContent = athletes.length;
    document.getElementById('statActivities').textContent = allActivities.length;
    updateExcludedCount();

    renderAthletesList(athletes);
    renderResetPasswordOptions(athletes);
    renderActivitiesList();

    addLog(`📊 ${athletes.length} athlètes, ${allActivities.length} activités`);
  } catch (error) {
    console.error('Erreur chargement:', error);
    addLog(`❌ Erreur chargement: ${error.message}`);
  }

  loadSeasonVisualizer();
  loadSeasonPlanning();
  loadFrozenStatus();
  loadJokersData();
  loadBonusesAdmin();
}

function updateExcludedCount() {
  document.getElementById('statExcluded').textContent = allActivities.filter(a => a.excluded).length;
}

// ============================================
// SAISON EN COURS
// ============================================
const RULE_LABELS = {
  standard: 'Standard',
  handicap: 'Handicap',
  no_bonus: 'Sans bonus (D+ pur)',
  pluie_qui_mouille: 'La pluie qui mouille (D+ ×1,5 sous la pluie)'
};

const ROUND_TYPE_LABELS = {
  standard: 'Standard',
  finale: 'Finale',
  no_eliminations: 'Sans élimination'
};

const SEASON_TYPE_TAGS = {
  team: 'équipes',
  double_points: 'points ×2',
  deadline: 'deadline'
};

const STATUS_LABELS = {
  frozen: '<span class="ok">❄️ Figé</span>',
  pending_freeze: '<span class="err">⚠️ Terminé, à figer</span>',
  ongoing: '<span class="warn">⏳ En cours</span>',
  upcoming: '<span class="muted">📅 À venir</span>'
};

const ELIM_SOURCE_LABELS = {
  default: 'défaut',
  rule: 'règle spéciale',
  admin: 'config admin',
  finale: 'finale',
  team: 'équipe',
  frozen: ''
};

function renderOptions(labels, current) {
  const entries = Object.entries(labels);
  // Valeur héritée inconnue de la liste (ex: ancien type bonus_round) : on la montre
  if (current && !labels[current]) entries.push([current, current]);
  return entries.map(([value, label]) =>
    `<option value="${value}" ${current === value ? 'selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');
}

function renderWeatherCoverage(coverage) {
  if (!coverage) return '<div class="hint">🌧️ aucune activité</div>';
  const unusable = coverage.total - coverage.ok;
  const title = `${coverage.noGeo} sans GPS, ${coverage.missing} météo non calculée, ${coverage.error} en erreur`;
  return `<div class="hint ${unusable > 0 ? 'warn' : 'ok'}" title="${title}">
    🌧️ ${coverage.rainy}/${coverage.ok} sous la pluie${unusable > 0 ? ` · ⚠️ ${unusable} sans météo` : ''}
  </div>`;
}

async function loadSeasonVisualizer() {
  const container = document.getElementById('seasonVisualizerContent');
  container.innerHTML = '<p class="muted">Chargement...</p>';

  try {
    const plan = await adminJson(`/admin/season-plan?leagueId=${LEAGUE_ID}`);

    // Couverture météo : best-effort, sert à vérifier la règle « pluie qui mouille »
    // avant que le round ne soit figé.
    let weatherCoverage = {};
    try {
      const covRes = await fetch(`${API_BASE}/weather-coverage/${LEAGUE_ID}`);
      if (covRes.ok) weatherCoverage = await covRes.json();
    } catch (e) {
      console.warn('Couverture météo indisponible:', e.message);
    }

    container.innerHTML = renderSeasonPlan(plan, weatherCoverage);
  } catch (error) {
    console.error('Erreur visualisateur saison:', error);
    container.innerHTML = `<p class="err">❌ ${escapeHtml(error.message)}</p>`;
    addLog(`❌ Erreur visualisateur: ${error.message}`);
  }
}

function renderSeasonPlan(plan, weatherCoverage) {
  const finale = plan.rounds.find(r => r.isFinale);
  const pending = plan.rounds.filter(r => r.status === 'pending_freeze');
  const isTeam = plan.seasonType === 'team';

  let alerts = '';
  if (pending.length) {
    alerts += `<div class="alert">⚠️ ${pending.map(r => 'R' + r.roundNumber).join(', ')} terminé(s) mais pas encore figé(s) — gel auto à 00h15, ou bouton « Figer les rounds terminés ».</div>`;
  }
  if (!isTeam && finale && finale.status !== 'frozen' && finale.activeAtStart !== plan.finalistsCount) {
    alerts += `<div class="alert">ℹ️ Avec la config actuelle, la finale R${finale.roundNumber} se jouerait à ${finale.activeAtStart} au lieu de ${plan.finalistsCount}.</div>`;
  }
  if (!finale) {
    const last = plan.rounds[plan.rounds.length - 1];
    alerts += `<div class="alert">ℹ️ La saison se termine en R${last.roundNumber} faute de joueurs, sans round de finale.</div>`;
  }

  const rows = plan.rounds.map(r => {
    const editable = r.status !== 'frozen';
    const cfg = r.config || {};
    const duration = Math.round((new Date(r.end) - new Date(r.start)) / 86400000);
    const dates = `${formatDate(r.start)} → ${formatDate(r.end)} <span class="hint">(${duration} j)</span>`;
    const rowClass = r.status === 'frozen' ? 'is-frozen' : (r.status === 'ongoing' ? 'is-current' : '');

    const planned = cfg.source === 'deadline';
    let elimCell;
    if (!editable || planned) {
      elimCell = `<span>${r.eliminations}</span>`;
    } else if (isTeam) {
      elimCell = `<span title="Une équipe éliminée par round">${r.eliminations}</span>`;
    } else {
      const placeholder = `${r.eliminations}`;
      elimCell = `<input type="number" id="config-nbElim-${r.roundNumber}" min="0" max="30"
          value="${cfg.nbEliminations ?? ''}" placeholder="${placeholder}" style="width: 64px; text-align: center;"
          title="Vide = ${ELIM_SOURCE_LABELS[r.eliminationSource] || 'défaut'} (${placeholder})">
        <div class="hint">${escapeHtml(ELIM_SOURCE_LABELS[r.eliminationSource] || '')}</div>`;
    }

    const currentType = cfg.type || 'standard';
    const typeCell = planned
      ? `${r.isFinale ? '🏆 Finale' : 'Standard'}<div class="hint">planifié (deadline)</div>`
      : editable
      ? `<select id="config-type-${r.roundNumber}">${renderOptions(ROUND_TYPE_LABELS, currentType)}</select>
         ${r.isFinale && currentType !== 'finale' ? '<div class="hint info">finale (calculée)</div>' : ''}`
      : (r.isFinale ? '🏆 Finale' : 'Standard');

    const currentRule = cfg.specialRule || 'standard';
    const ruleCell = editable
      ? `<select id="config-rule-${r.roundNumber}">${renderOptions(RULE_LABELS, currentRule)}</select>`
      : escapeHtml(RULE_LABELS[r.specialRule] || r.specialRule || '—');
    const weather = currentRule === 'pluie_qui_mouille' || r.specialRule === 'pluie_qui_mouille'
      ? renderWeatherCoverage(weatherCoverage[String(r.roundNumber)])
      : '';

    const actions = editable
      ? `<button class="btn btn-primary btn-sm" onclick="saveRoundConfigFromUI(${r.roundNumber})" title="Enregistrer">💾</button>
         ${r.config ? `<button class="btn btn-danger btn-sm" onclick="deleteRoundConfigFromUI(${r.roundNumber})" title="Revenir au comportement par défaut">✕</button>` : ''}`
      : '<span class="hint">verrouillé</span>';

    return `
      <tr class="${rowClass}">
        <td><strong>R${r.roundNumber}</strong> <span class="hint">(${r.roundInSeason})</span></td>
        <td style="font-size: 12px;">${dates}</td>
        <td class="center">${STATUS_LABELS[r.status] || '—'}</td>
        <td class="center num">${r.activeAtStart}</td>
        <td class="center">${elimCell}</td>
        <td>${typeCell}</td>
        <td>${ruleCell}${weather}</td>
        <td class="center" style="white-space: nowrap;">${actions}</td>
      </tr>`;
  }).join('');

  return `
    <div class="season-summary">
      <div>Saison <strong>${plan.seasonNumber}</strong>${plan.seasonType !== 'standard' ? ` <span class="tag">${escapeHtml(SEASON_TYPE_TAGS[plan.seasonType] || plan.seasonType)}</span>` : ''}</div>
      <div>Rounds <strong>R${plan.startRound} → R${plan.endRound}</strong></div>
      <div>Joueurs au départ <strong>${plan.totalParticipants}</strong></div>
      ${isTeam ? '' : `<div>Finalistes visés <strong>${plan.finalistsCount}</strong></div>`}
      <div>Élim. par défaut <strong>${plan.eliminationsPerRound}</strong></div>
      ${plan.deadline ? `<div>Deadline <strong>${formatDate(plan.deadline + 'T12:00:00')}</strong></div>` : ''}
    </div>
    ${alerts}
    <table class="admin-table">
      <thead>
        <tr>
          <th>Round</th><th>Dates</th><th class="center">Statut</th><th class="center">Actifs<br>début</th>
          <th class="center">Nb élim</th><th>Type</th><th>Règle spéciale</th><th class="center">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">Projection minimale : au-delà du R7, si ≥2 joueurs finissent à 0 D+, ils sont tous éliminés.</p>`;
}

async function saveRoundConfigFromUI(roundNumber) {
  const rawElim = document.getElementById(`config-nbElim-${roundNumber}`)?.value ?? '';
  const type = document.getElementById(`config-type-${roundNumber}`)?.value || 'standard';
  const specialRule = document.getElementById(`config-rule-${roundNumber}`)?.value || 'standard';

  const body = { type, specialRule };
  // Round planifié (saison Deadline) : seule la règle spéciale est modifiable
  if (!document.getElementById(`config-type-${roundNumber}`)) delete body.type;
  if (rawElim !== '') {
    const nbElim = parseInt(rawElim, 10);
    if (isNaN(nbElim) || nbElim < 0) {
      alert('Nombre d\'éliminations invalide');
      return;
    }
    body.nbEliminations = nbElim;
  }

  try {
    await adminJson(`/admin/round-configs/${roundNumber}`, { method: 'POST', body });
    addLog(`💾 Config R${roundNumber} : type=${type}, règle=${specialRule}, élim=${body.nbEliminations ?? 'défaut'}`);
    loadSeasonVisualizer();
  } catch (error) {
    addLog(`❌ Erreur sauvegarde config: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

async function deleteRoundConfigFromUI(roundNumber) {
  if (!confirm(`Supprimer la config personnalisée du R${roundNumber} ?`)) return;
  try {
    await adminJson(`/admin/round-configs/${roundNumber}`, { method: 'DELETE' });
    addLog(`🗑️ Config R${roundNumber} supprimée`);
    loadSeasonVisualizer();
  } catch (error) {
    addLog(`❌ Erreur suppression config: ${error.message}`);
  }
}

window.saveRoundConfigFromUI = saveRoundConfigFromUI;
window.deleteRoundConfigFromUI = deleteRoundConfigFromUI;
document.getElementById('refreshSeasonVisualizerBtn').addEventListener('click', loadSeasonVisualizer);

// ============================================
// PLANNING DES SAISONS
// ============================================
const SEASON_STATUS_LABELS = {
  closed: '<span class="muted">✔️ Terminée</span>',
  current: '<span class="warn">⏳ En cours</span>',
  upcoming: '<span class="info">📅 À venir</span>'
};

function renderDeadlinePlan(rounds) {
  return rounds.map(r => r.isFinale
    ? `<span class="tag">${r.durationDays} j · finale</span>`
    : `<span class="tag">${r.durationDays} j · ${r.nbEliminations} élim</span>`).join(' ');
}

async function loadSeasonPlanning() {
  const container = document.getElementById('seasonPlanningContent');
  try {
    const { seasons, types } = await adminJson('/admin/season-planning');
    const typeLabel = id => types.find(t => t.id === id)?.name || id;
    const deadlineTypes = new Set(types.filter(t => t.hasDeadline).map(t => t.id));

    container.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Saison</th><th>Statut</th><th>Type</th><th>Détail</th></tr></thead>
        <tbody>${seasons.map(s => {
          const editable = !s.hasFrozenRounds && s.status !== 'closed';
          // La deadline d'une saison Deadline en cours reste ajustable
          const deadlineEditable = editable || (s.status === 'current' && deadlineTypes.has(s.type));
          const typeCell = editable
            ? `<select id="season-type-${s.seasonNumber}" onchange="onSeasonTypeChange(${s.seasonNumber})">
                 ${types.map(t => `<option value="${t.id}" ${t.id === s.type ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
               </select>`
            : `${s.type === 'team' ? '👥 ' : ''}${escapeHtml(typeLabel(s.type))}`;

          const showDeadline = deadlineTypes.has(s.type);
          const deadlineInput = deadlineEditable
            ? `<span id="season-deadline-wrap-${s.seasonNumber}" style="${showDeadline ? '' : 'display: none;'}">
                 Fin le <input type="date" id="season-deadline-${s.seasonNumber}" value="${s.deadline || ''}">
               </span>`
            : (s.deadline ? `Fin le ${formatDate(s.deadline + 'T12:00:00')}` : '');
          const saveBtn = editable || deadlineEditable
            ? ` <button class="btn btn-primary btn-sm" onclick="saveSeasonType(${s.seasonNumber})">💾</button>`
            : '';

          let detail = deadlineInput;
          if (s.preview) {
            detail += `<div class="hint">Aperçu (${seasons.length && s.startRound ? `dès R${s.startRound}, ` : ''}estimé avec tous les joueurs actifs) :<br>${renderDeadlinePlan(s.preview.rounds)}</div>`;
            if (s.preview.warning) detail += `<div class="hint warn">⚠️ ${escapeHtml(s.preview.warning)}</div>`;
          }
          if (s.type === 'double_points') detail += '<span class="hint">Points du challenge principal ×2</span>';

          return `
            <tr class="${s.status === 'closed' ? 'is-frozen' : (s.status === 'current' ? 'is-current' : '')}">
              <td><strong>Saison ${s.seasonNumber}</strong>${s.startRound ? ` <span class="hint">(R${s.startRound})</span>` : ''}</td>
              <td>${SEASON_STATUS_LABELS[s.status] || ''}</td>
              <td>${typeCell}${saveBtn}</td>
              <td>${detail}</td>
            </tr>`;
        }).join('')}</tbody>
      </table>
      <p class="hint">Saison Deadline : rounds de 3 à 7 jours et 1 à 4 éliminations, recalculés après chaque gel pour finir le jour choisi.</p>`;
    container.dataset.deadlineTypes = [...deadlineTypes].join(',');
  } catch (error) {
    container.innerHTML = `<p class="err">❌ ${escapeHtml(error.message)}</p>`;
    addLog(`❌ Erreur planning saisons: ${error.message}`);
  }
}

function onSeasonTypeChange(seasonNumber) {
  const type = document.getElementById(`season-type-${seasonNumber}`).value;
  const deadlineTypes = (document.getElementById('seasonPlanningContent').dataset.deadlineTypes || '').split(',');
  const wrap = document.getElementById(`season-deadline-wrap-${seasonNumber}`);
  if (wrap) wrap.style.display = deadlineTypes.includes(type) ? '' : 'none';
}

async function saveSeasonType(seasonNumber) {
  const select = document.getElementById(`season-type-${seasonNumber}`);
  const deadlineInput = document.getElementById(`season-deadline-${seasonNumber}`);
  const deadlineTypes = (document.getElementById('seasonPlanningContent').dataset.deadlineTypes || '').split(',');
  // Saison en cours non modifiable : seul le champ deadline est présent
  const type = select ? select.value : 'deadline';
  const label = select ? select.selectedOptions[0].textContent : 'Deadline';
  const body = { type };
  if (deadlineTypes.includes(type)) {
    if (!deadlineInput?.value) {
      alert('Choisis la date de fin de la saison');
      return;
    }
    body.deadline = deadlineInput.value;
  }

  const summary = body.deadline ? ` avec fin le ${formatDate(body.deadline + 'T12:00:00')}` : '';
  if (!confirm(`Saison ${seasonNumber} en mode « ${label} »${summary} ?`)) {
    loadSeasonPlanning();
    return;
  }
  try {
    const result = await adminJson(`/admin/season-planning/${seasonNumber}`, { method: 'POST', body });
    addLog(`🗓️ Saison ${seasonNumber} → ${label}${summary}`);
    if (result.replan?.planned && result.replan.seasonNumber === seasonNumber) {
      addLog(`⏳ Rounds replanifiés R${result.replan.fromRound}→R${result.replan.toRound}${result.replan.warning ? ` (⚠️ ${result.replan.warning})` : ''}`);
    }
    loadSeasonPlanning();
    loadSeasonVisualizer();
  } catch (error) {
    addLog(`❌ Erreur planning saison ${seasonNumber}: ${error.message}`);
    alert('Erreur: ' + error.message);
    loadSeasonPlanning();
  }
}

window.onSeasonTypeChange = onSeasonTypeChange;
window.saveSeasonType = saveSeasonType;

// ============================================
// SYNCHRONISATION
// ============================================
document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const result = document.getElementById('syncResult');
  const startDate = document.getElementById('syncStartDate').value;
  const endDate = document.getElementById('syncEndDate').value;

  btn.disabled = true;
  btn.textContent = 'Synchronisation...';
  result.innerHTML = '<span class="warn">⏳ En cours...</span>';

  try {
    const data = await adminJson(`/sync/${LEAGUE_ID}`, { method: 'POST', body: { startDate, endDate } });
    const newCount = data.totalNew || 0;
    const updatedCount = data.totalUpdated || 0;
    const errorCount = data.errors?.length || 0;

    let message = newCount || updatedCount
      ? `✅ ${newCount} nouvelle(s), ${updatedCount} mise(s) à jour`
      : '✓ Aucune modification';
    if (errorCount) message += ` · ⚠️ ${errorCount} erreur(s)`;

    result.innerHTML = `<span class="${errorCount ? 'warn' : 'ok'}">${message}</span>`;
    addLog(`🔄 Sync: ${newCount} nouvelles, ${updatedCount} MAJ, ${errorCount} erreurs`);
    loadDashboardData();
  } catch (error) {
    result.innerHTML = `<span class="err">❌ ${escapeHtml(error.message)}</span>`;
    addLog(`❌ Sync erreur: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lancer la synchronisation';
  }
});

// ============================================
// RÉSULTATS FIGÉS
// ============================================
async function loadFrozenStatus() {
  const statusDiv = document.getElementById('frozenStatus');
  try {
    const response = await fetch(`${API_BASE}/frozen-results`);
    const data = await response.json();
    const rounds = Object.keys(data.rounds || {})
      .filter(k => data.rounds[k]?.frozen)
      .map(Number)
      .sort((a, b) => a - b);

    document.getElementById('statFrozen').textContent = rounds.length;
    statusDiv.innerHTML = rounds.length
      ? `<div class="info">❄️ ${rounds.length} round(s) figé(s), dernier : R${rounds[rounds.length - 1]}</div>
         ${data.lastUpdated ? `<div class="hint">Mis à jour le ${new Date(data.lastUpdated).toLocaleString('fr-FR')}</div>` : ''}`
      : '<span class="warn">⚠️ Aucun round figé</span>';
  } catch (error) {
    statusDiv.innerHTML = '<span class="err">❌ Erreur chargement</span>';
  }
}

function refreshAfterFreezeChange() {
  loadFrozenStatus();
  loadSeasonVisualizer();
  loadJokersData();
  loadBonusesAdmin();
}

function getRoundInput() {
  const roundNumber = parseInt(document.getElementById('freezeRoundNumber').value, 10);
  if (!roundNumber || roundNumber < 1) {
    alert('Veuillez entrer un numéro de round valide');
    return null;
  }
  return roundNumber;
}

document.getElementById('autoFreezeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('autoFreezeBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Figement en cours...';

  try {
    const data = await adminJson('/admin/auto-freeze', { method: 'POST', body: { leagueId: LEAGUE_ID } });
    const count = data.frozenCount || 0;
    addLog(`❄️ Auto-freeze: ${count} round(s) figé(s)`);
    alert(count ? `✅ ${count} round(s) figé(s)` : 'ℹ️ Aucun round terminé à figer.');
    refreshAfterFreezeChange();
  } catch (error) {
    addLog(`❌ Erreur auto-freeze: ${error.message}`);
    alert('Erreur: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

document.getElementById('freezeRoundBtn').addEventListener('click', async () => {
  const roundNumber = getRoundInput();
  if (!roundNumber) return;
  if (!confirm(`Figer le round ${roundNumber} avec les données actuelles ?`)) return;

  try {
    const data = await adminJson(`/admin/freeze-round/${roundNumber}`, { method: 'POST', body: { leagueId: LEAGUE_ID } });
    addLog(`❄️ Round ${roundNumber} figé: ${data.round?.eliminations?.length || 0} éliminé(s)`);
    alert(`✅ Round ${roundNumber} figé`);
    refreshAfterFreezeChange();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
});

document.getElementById('unfreezeRoundBtn').addEventListener('click', async () => {
  const roundNumber = getRoundInput();
  if (!roundNumber) return;
  if (!confirm(`⚠️ Défiger le round ${roundNumber} ?\n\nIl sera recalculé au prochain gel.`)) return;

  try {
    const data = await adminJson(`/admin/unfreeze-round/${roundNumber}`, { method: 'POST' });
    if (!data.success) throw new Error(`Le round ${roundNumber} n'était pas figé`);
    addLog(`🔓 Round ${roundNumber} défigé`);
    alert(`✅ Round ${roundNumber} défigé`);
    refreshAfterFreezeChange();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
});

document.getElementById('resetFrozenBtn').addEventListener('click', async () => {
  if (!confirm('⚠️ Réinitialiser TOUS les résultats figés ?\n\nCette action est IRRÉVERSIBLE.')) return;
  if (!confirm('🚨 DERNIÈRE CONFIRMATION\n\nTous les résultats seront perdus. Continuer ?')) return;

  try {
    await adminJson('/admin/reset-frozen', { method: 'POST' });
    addLog('🗑️ Tous les résultats figés supprimés');
    alert('✅ Tous les résultats ont été réinitialisés');
    refreshAfterFreezeChange();
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
});

document.getElementById('importFrozenBtn').addEventListener('click', () => {
  document.getElementById('importFrozenFile').click();
});

document.getElementById('importFrozenFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    if (!data.rounds || typeof data.rounds !== 'object') {
      throw new Error('Format invalide : le fichier doit contenir un objet "rounds"');
    }

    const roundCount = Object.keys(data.rounds).length;
    const mode = document.getElementById('importMode').value;
    const effect = mode === 'replace' ? 'ÉCRASER toutes les données existantes' : 'ajouter les rounds manquants';
    if (!confirm(`📥 Importer ${roundCount} round(s) ?\n\nCette action va ${effect}.`)) return;

    const result = await adminJson('/admin/import-frozen-results', {
      method: 'POST',
      body: { data, merge: mode === 'merge' }
    });

    addLog(`✅ Import: ${result.imported} importé(s), ${result.skipped} ignoré(s)`);
    alert(`✅ Import réussi\n\n• ${result.imported} round(s) importé(s)\n• ${result.skipped} ignoré(s) (déjà existants)\n• Total : ${result.totalRounds} round(s)`);
    refreshAfterFreezeChange();
  } catch (error) {
    addLog(`❌ Erreur import: ${error.message}`);
    alert('❌ Erreur: ' + error.message);
  } finally {
    e.target.value = '';
  }
});

// ============================================
// TÉLÉCHARGEMENTS
// ============================================
const DOWNLOADS = {
  ranking: () => [`/admin/ranking/${LEAGUE_ID}/export`, `classement-${LEAGUE_ID}-${new Date().toISOString().split('T')[0]}.json`],
  athletes: () => ['/admin/athletes/download', 'athletes.json'],
  activities: () => [`/admin/activities/${LEAGUE_ID}/download`, `${LEAGUE_ID}_activities.json`],
  jokers: () => ['/admin/jokers/download', 'jokers_usage.json'],
  frozen: () => ['/frozen-results', 'frozen_results.json']
};

document.querySelectorAll('.download-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const [path, filename] = DOWNLOADS[btn.dataset.file]();
    try {
      await downloadFrom(path, filename);
      addLog(`📥 ${filename} téléchargé`);
    } catch (error) {
      addLog(`❌ ${filename}: ${error.message}`);
      alert('Erreur: ' + error.message);
    }
  });
});

// ============================================
// RESET MOT DE PASSE
// ============================================
function renderResetPasswordOptions(athletes) {
  const select = document.getElementById('resetPasswordAthlete');
  const sorted = [...athletes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  select.innerHTML = '<option value="">-- Choisir un athlète --</option>' + sorted.map(a =>
    `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.email || 'pas d\'email')})</option>`
  ).join('');
}

document.getElementById('resetPasswordBtn').addEventListener('click', async () => {
  const select = document.getElementById('resetPasswordAthlete');
  const athleteId = select.value;
  const newPassword = document.getElementById('resetPasswordNew').value;
  const resultDiv = document.getElementById('resetPasswordResult');

  if (!athleteId) {
    resultDiv.innerHTML = '<span class="err">❌ Veuillez sélectionner un athlète</span>';
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    resultDiv.innerHTML = '<span class="err">❌ Le mot de passe doit contenir au moins 6 caractères</span>';
    return;
  }

  const athleteName = athletesCache[athleteId]?.name || athleteId;
  if (!confirm(`⚠️ Réinitialiser le mot de passe de ${athleteName} ?\n\nNouveau mot de passe : ${newPassword}`)) return;

  try {
    const data = await adminJson('/admin/reset-password', { method: 'POST', body: { athleteId, newPassword } });
    resultDiv.innerHTML = `<span class="ok">✅ ${escapeHtml(data.message)}</span>`;
    addLog(`🔑 Mot de passe réinitialisé pour ${athleteName}`);
    document.getElementById('resetPasswordNew').value = '';
    select.value = '';
  } catch (error) {
    resultDiv.innerHTML = `<span class="err">❌ ${escapeHtml(error.message)}</span>`;
    addLog(`❌ Erreur reset password: ${error.message}`);
  }
});

// ============================================
// ATHLÈTES
// ============================================
function renderAthletesList(athletes) {
  const container = document.getElementById('athletesList');
  if (athletes.length === 0) {
    container.innerHTML = '<p class="muted">Aucun athlète inscrit</p>';
    return;
  }

  const sorted = [...athletes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  container.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Nom</th><th>Email</th><th>ID Strava</th><th>Inscrit le</th><th>Entrée en jeu</th></tr></thead>
      <tbody>
        ${sorted.map(a => `
          <tr>
            <td style="font-weight: 500;">${escapeHtml(a.name)}</td>
            <td class="muted">${escapeHtml(a.email || '-')}</td>
            <td style="font-family: 'Space Mono', monospace;">${escapeHtml(a.id)}</td>
            <td class="muted">${formatDate(a.registered_at)}</td>
            <td>${a.active_from_round ? `R${a.active_from_round}` : '<span class="muted">saison suivant l\'inscription</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ============================================
// ACTIVITÉS
// ============================================
function getAthleteName(activity) {
  if (activity.athlete_name) return activity.athlete_name;
  const a = athletesCache[String(activity.athlete_id)];
  return a?.name || `#${activity.athlete_id}`;
}

function renderActivitiesList() {
  const container = document.getElementById('activitiesList');
  const search = document.getElementById('activitySearch').value.toLowerCase();
  const filter = document.getElementById('activityFilter').value;

  let filtered = allActivities;
  if (search) {
    filtered = filtered.filter(a =>
      (a.name || '').toLowerCase().includes(search) ||
      getAthleteName(a).toLowerCase().includes(search)
    );
  }
  if (filter === 'active') filtered = filtered.filter(a => !a.excluded);
  else if (filter === 'excluded') filtered = filtered.filter(a => a.excluded);

  filtered = [...filtered].sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

  if (filtered.length === 0) {
    container.innerHTML = '<p class="muted">Aucune activité trouvée</p>';
    return;
  }

  container.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Date</th><th>Athlète</th><th>Activité</th><th class="num">Distance</th><th class="num">D+</th>
          <th class="center">Statut</th><th class="center">Action</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.slice(0, 100).map(a => `
          <tr style="${a.excluded ? 'opacity: 0.5;' : ''}">
            <td>${formatDate(a.start_date)}</td>
            <td style="font-weight: 500;">${escapeHtml(getAthleteName(a))}</td>
            <td><a href="https://www.strava.com/activities/${encodeURIComponent(a.id)}" target="_blank" rel="noopener" style="color: #22d3ee; text-decoration: none;">${escapeHtml(a.name || 'Sans nom')}</a>
              <span class="hint">${escapeHtml(a.sport_type || a.type || '')}</span></td>
            <td class="num">${((a.distance || 0) / 1000).toFixed(2)} km</td>
            <td class="num">+${Math.round(a.total_elevation_gain || 0)} m</td>
            <td class="center">${a.excluded ? '<span class="err">❌ Exclue</span>' : '<span class="ok">✅ Active</span>'}</td>
            <td class="center">
              <button class="btn btn-sm ${a.excluded ? 'btn-success' : 'btn-danger'}"
                onclick="toggleActivityExclusion('${escapeHtml(a.id)}', ${!a.excluded})">
                ${a.excluded ? '↩️ Réintégrer' : '🚫 Exclure'}
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${filtered.length > 100 ? `<p class="hint" style="text-align: center;">Affichage limité à 100 activités sur ${filtered.length}</p>` : ''}`;
}

async function toggleActivityExclusion(activityId, exclude) {
  try {
    const data = await adminJson(`/admin/activities/${LEAGUE_ID}/${activityId}/exclude`, {
      method: 'POST',
      body: { exclude }
    });

    const index = allActivities.findIndex(a => String(a.id) === String(activityId));
    if (index >= 0) allActivities[index] = data.activity || { ...allActivities[index], excluded: exclude };

    renderActivitiesList();
    updateExcludedCount();
    addLog(`${exclude ? '🚫' : '↩️'} Activité ${activityId}: ${exclude ? 'exclue' : 'réintégrée'}`);
  } catch (error) {
    addLog(`❌ Erreur: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
}

window.toggleActivityExclusion = toggleActivityExclusion;
document.getElementById('activitySearch').addEventListener('input', renderActivitiesList);
document.getElementById('activityFilter').addEventListener('change', renderActivitiesList);
document.getElementById('refreshActivitiesBtn').addEventListener('click', loadDashboardData);

// ============================================
// JOKERS
// ============================================
const JOKER_DISPLAY = {
  voleur: { icon: '🦹', label: 'Voleur' },
  multiplicateur: { icon: '✖️', label: '×1.5' },
  bouclier: { icon: '🛡️', label: 'Bouclier' },
  sabotage: { icon: '💣', label: 'Sabotage' }
};
const JOKER_MAX_STOCK = 5; // même plafond que le backend
let jokerIds = Object.keys(JOKER_DISPLAY);

async function loadJokersData() {
  const container = document.getElementById('jokersManagementTable');
  try {
    const data = await adminJson(`/admin/jokers/${LEAGUE_ID}`);
    // La liste des jokers vient du backend (JOKER_CONFIG)
    if (data.config) jokerIds = Object.keys(data.config);
    renderJokersManagement(data.athletes || []);
  } catch (error) {
    container.innerHTML = `<p class="err">❌ ${escapeHtml(error.message)}</p>`;
    addLog(`❌ Erreur jokers: ${error.message}`);
  }
}

function renderJokersManagement(athletes) {
  const container = document.getElementById('jokersManagementTable');
  if (athletes.length === 0) {
    container.innerHTML = '<p class="muted">Aucun athlète trouvé</p>';
    return;
  }

  const sorted = [...athletes].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  container.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Athlète</th>
          ${jokerIds.map(id => {
            const d = JOKER_DISPLAY[id] || { icon: '🃏', label: id };
            return `<th class="center">${d.icon} ${escapeHtml(d.label)}</th>`;
          }).join('')}
        </tr>
      </thead>
      <tbody>
        ${sorted.map(athlete => `
          <tr>
            <td>
              <div style="font-weight: 600;">${escapeHtml(athlete.name || `${athlete.firstname} ${athlete.lastname}`)}</div>
              <div class="hint" style="margin: 0;">ID: ${escapeHtml(athlete.id)}</div>
            </td>
            ${jokerIds.map(id => {
              const value = athlete.jokerStock?.[id] ?? 0;
              return `
                <td class="center">
                  <div class="joker-cell">
                    <button class="minus" onclick="adjustJoker('${escapeHtml(athlete.id)}', '${id}', -1)">−</button>
                    <span id="joker-${escapeHtml(athlete.id)}-${id}" class="${value > 0 ? 'info' : 'err'}">${value}</span>
                    <button class="plus" onclick="adjustJoker('${escapeHtml(athlete.id)}', '${id}', 1)">+</button>
                  </div>
                </td>`;
            }).join('')}
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function adjustJoker(athleteId, jokerType, delta) {
  const span = document.getElementById(`joker-${athleteId}-${jokerType}`);
  if (!span) return;

  const currentValue = parseInt(span.textContent, 10) || 0;
  const newValue = Math.max(0, Math.min(JOKER_MAX_STOCK, currentValue + delta));
  if (newValue === currentValue) return;

  const setValue = (value) => {
    span.textContent = value;
    span.className = value > 0 ? 'info' : 'err';
  };
  setValue(newValue);

  // On n'envoie que le joker modifié : le backend ne touche pas aux autres
  try {
    await adminJson(`/admin/jokers/${athleteId}`, {
      method: 'PUT',
      body: { jokerStock: { [jokerType]: newValue } }
    });
    const name = athletesCache[athleteId]?.name || athleteId;
    addLog(`🃏 ${jokerType} ${delta > 0 ? '+1' : '-1'} pour ${name} (stock: ${newValue})`);
    span.style.transform = 'scale(1.3)';
    setTimeout(() => { span.style.transform = ''; }, 200);
  } catch (error) {
    setValue(currentValue);
    addLog(`❌ Erreur jokers: ${error.message}`);
  }
}

window.adjustJoker = adjustJoker;

document.getElementById('resetAllJokersBtn').addEventListener('click', async () => {
  if (!confirm('⚠️ Remettre le stock de jokers de TOUS les athlètes à sa valeur de départ ?\n\nLes jokers en attente sur le round en cours sont annulés. Action irréversible.')) return;

  try {
    const data = await adminJson(`/admin/jokers/reset/${LEAGUE_ID}`, { method: 'POST' });
    addLog(`🔄 Jokers réinitialisés pour ${data.count} athlètes (${data.refundsAdded || 0} usages figés compensés)`);
    loadJokersData();
  } catch (error) {
    addLog(`❌ Erreur reset jokers: ${error.message}`);
    alert('Erreur: ' + error.message);
  }
});

// ============================================
// BONUS ÉPHÉMÈRES
// ============================================
const BONUS_STATUS_LABELS = {
  available: '<span class="info">À utiliser</span>',
  active: '<span class="warn">Actif</span>',
  used: '<span class="ok">Utilisé</span>',
  expired: '<span class="muted">Expiré</span>'
};

function describeBonusResult(bonus) {
  const r = bonus.effect_result;
  if (!r) return '<span class="muted">—</span>';
  if (bonus.bonus_id === 'marquage') return r.targetEliminated ? '<span class="ok">✅ cible éliminée (+1 pt)</span>' : 'cible sauvée';
  if (bonus.bonus_id === 'duel' && r.won !== undefined) return r.won ? '<span class="ok">✅ gagné (+1 pt)</span>' : 'perdu / égalité';
  if (r.amount) return `${r.amount > 0 ? '+' : ''}${Math.round(r.amount)} m`;
  if (r.stolenElevation) return `${Math.round(r.stolenElevation)} m`;
  return escapeHtml(r.error || (r.noEffect ? 'sans effet' : '—'));
}

async function loadBonusesAdmin() {
  const container = document.getElementById('bonusesAdmin');
  try {
    const data = await adminJson('/admin/bonuses');
    const pending = Object.entries(data.pending || {})
      .sort((a, b) => Number(b[1].elimination_round) - Number(a[1].elimination_round));
    const current = (data.bonuses || [])
      .filter(b => !b.season_number)
      .sort((a, b) => Number(b.elimination_round) - Number(a.elimination_round));

    const pendingHtml = pending.length
      ? `<table class="admin-table">
          <thead><tr><th>Athlète</th><th>Éliminé au</th><th>Choix proposés</th><th>Généré le</th></tr></thead>
          <tbody>${pending.map(([id, p]) => `
            <tr>
              <td>${escapeHtml(p.athlete_name || athletesCache[id]?.name || id)}</td>
              <td>R${escapeHtml(p.elimination_round)}</td>
              <td>${(p.choices || []).map(escapeHtml).join(' / ')}</td>
              <td class="muted">${formatDate(p.created_at)}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<p class="muted">Aucun choix en attente.</p>';

    const currentHtml = current.length
      ? `<table class="admin-table">
          <thead><tr><th>Athlète</th><th>Bonus</th><th>Éliminé au</th><th>Statut</th><th>Utilisé au</th><th>Cible</th><th>Résultat</th></tr></thead>
          <tbody>${current.map(b => `
            <tr>
              <td>${escapeHtml(b.athlete_name)}</td>
              <td>${escapeHtml(b.bonus_id)}</td>
              <td>R${escapeHtml(b.elimination_round)}</td>
              <td>${BONUS_STATUS_LABELS[b.status] || escapeHtml(b.status)}</td>
              <td>${b.used_in_round ? `R${escapeHtml(b.used_in_round)}` : '<span class="muted">—</span>'}</td>
              <td>${escapeHtml(b.target_athlete_name || '—')}</td>
              <td>${describeBonusResult(b)}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<p class="muted">Aucun bonus choisi sur la saison en cours.</p>';

    container.innerHTML = `
      <h4 style="margin: 0 0 8px;">⏳ Choix en attente (${pending.length})</h4>
      ${pendingHtml}
      <h4 style="margin: 20px 0 8px;">🎁 Bonus de la saison en cours (${current.length})</h4>
      ${currentHtml}`;
  } catch (error) {
    container.innerHTML = `<p class="err">❌ ${escapeHtml(error.message)}</p>`;
    addLog(`❌ Erreur bonus: ${error.message}`);
  }
}

// ============================================
// INIT
// ============================================
checkAuth();
