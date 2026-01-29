/**
 * ============================================
 * VERSANT - FONCTIONS DE RENDU UI
 * ============================================
 * Toutes les fonctions qui génèrent du HTML.
 * AUCUNE logique métier ici.
 */

import { 
  CHALLENGE_CONFIG, JOKER_TYPES, ROUND_RULES, PARTICIPANTS,
  getSeasonDates, getRoundDates, getRoundInSeason, getParticipantById,
  getAthleteColor, getAthleteInitials, getRoundInfo
} from './config.js';

import { getJokerStock, getJokerStatusForRound, getActiveJokersForRound, getPendingJokersForNextRound } from './jokers.js';

// ============================================
// UTILITAIRES DE FORMATAGE
// ============================================

export function formatDate(date, opts = {}) {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...opts
  });
}

export function formatDateShort(date) {
  return formatDate(date, { month: 'short', year: undefined });
}

export function formatElevation(value, showUnit = true) {
  const rounded = Math.round(value);
  const formatted = rounded.toLocaleString('fr-FR');
  return showUnit ? `${formatted} m` : formatted;
}

export function formatPosition(pos) {
  return `${pos}${pos === 1 ? 'er' : 'e'}`;
}

export function formatDateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (s.getMonth() === e.getMonth()) {
    return `${s.getDate()} - ${formatDate(e, { day: 'numeric', month: 'long', year: undefined })}`;
  }
  return `${formatDateShort(s)} - ${formatDateShort(e)}`;
}

// ============================================
// RENDU DU BANNER SAISON/ROUND
// ============================================

export function renderCombinedBanner(container, data) {
  const { currentSeasonNumber, currentRoundNumber, seasonData, currentDate } = data;
  
  const seasonDates = getSeasonDates(currentSeasonNumber);
  const roundDates = getRoundDates(currentRoundNumber);
  const roundInSeason = getRoundInSeason(currentDate);
  
  const seasonProgress = Math.min(100, Math.max(0, 
    (currentDate - seasonDates.start) / (seasonDates.end - seasonDates.start) * 100
  ));
  const isRoundActive = currentDate >= roundDates.start && currentDate <= roundDates.end;
  const daysLeft = Math.max(0, Math.ceil((roundDates.end - currentDate) / 86400000));
  
  container.innerHTML = `
    <div class="banner-left">
      <div class="banner-season">
        <span class="banner-label">Saison ${currentSeasonNumber}</span>
        <span class="banner-dates">${formatDateRange(seasonDates.start, seasonDates.end)}</span>
      </div>
      <div class="banner-stats">
        <span class="stat-item"><strong>${seasonData?.active?.length || 0}</strong> en course</span>
        <span class="stat-item"><strong>${seasonData?.eliminated?.length || 0}</strong> éliminés</span>
      </div>
    </div>

    <div class="banner-center">
      <div class="banner-round">
        <span class="round-number">Round ${roundInSeason}</span>
      </div>
      <div class="round-dates">${formatDateRange(roundDates.start, roundDates.end)}</div>
      ${isRoundActive ? `
        <div class="round-countdown">
          <span class="countdown-value">${daysLeft}</span> jour${daysLeft > 1 ? 's' : ''} restant${daysLeft > 1 ? 's' : ''}
        </div>
      ` : ''}
    </div>

    <div class="banner-right">
      <div class="season-progress-container">
        <div class="progress-label">Progression saison</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${seasonProgress}%"></div>
        </div>
        <div class="progress-percent">${Math.round(seasonProgress)}%</div>
      </div>
    </div>
  `;
}

// ============================================
// RENDU DES JOKERS ACTIFS
// ============================================

export function renderActiveJokersSection(container, data) {
  const { currentRoundNumber, ranking } = data;
  
  const activeJokers = getActiveJokersForRound(currentRoundNumber);
  const pendingJokers = getPendingJokersForNextRound(currentRoundNumber);
  
  if (activeJokers.length === 0 && pendingJokers.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  
  let html = '<h3 class="section-title">🃏 Jokers en jeu ce round</h3><div class="jokers-grid">';
  
  activeJokers.forEach(joker => {
    const jokerType = JOKER_TYPES[joker.jokerId];
    if (!jokerType) return;
    
    let statusHtml = '';
    let statusClass = 'active';
    
    if (joker.jokerId === 'duel' && ranking) {
      const challenger = ranking.find(r => String(r.participant.id) === String(joker.participantId));
      const target = ranking.find(r => String(r.participant.id) === String(joker.targetId));
      
      if (challenger && target) {
        const challengerWins = challenger.totalElevation > target.totalElevation;
        statusClass = challengerWins ? 'winning' : 'losing';
        
        statusHtml = `
          <div class="duel-status">
            <div class="duel-competitor ${challengerWins ? 'winning' : 'losing'}">
              <span class="competitor-name">${joker.participantName}</span>
              <span class="competitor-elevation">${formatElevation(challenger.totalElevation)}</span>
              ${challengerWins ? '<span class="duel-badge">⚔️ EN TÊTE</span>' : ''}
            </div>
            <div class="duel-vs">VS</div>
            <div class="duel-competitor ${!challengerWins ? 'winning' : 'losing'}">
              <span class="competitor-name">${joker.targetName}</span>
              <span class="competitor-elevation">${formatElevation(target.totalElevation)}</span>
              ${!challengerWins ? '<span class="duel-badge">🎯 EN TÊTE</span>' : ''}
            </div>
          </div>
          <div class="duel-stakes">Enjeu : 25% du D+ du perdant</div>
        `;
      }
    } else if (joker.jokerId === 'multiplicateur') {
      statusHtml = `<div class="joker-effect">×1.5 sur tout le D+ de ${joker.participantName}</div>`;
    } else if (joker.jokerId === 'sabotage') {
      statusHtml = `<div class="joker-effect">-25% du D+ de ${joker.targetName}</div>`;
    } else if (joker.jokerId === 'bouclier') {
      statusHtml = `<div class="joker-effect">${joker.participantName} est protégé contre l'élimination</div>`;
    }
    
    html += `
      <div class="joker-card ${statusClass}">
        <div class="joker-card-header">
          <span class="joker-card-icon">${jokerType.icon}</span>
          <span class="joker-card-name">${jokerType.name}</span>
          <span class="joker-card-user">par ${joker.participantName}</span>
        </div>
        <div class="joker-card-body">${statusHtml}</div>
      </div>
    `;
  });
  
  // Jokers programmés pour le prochain round
  if (pendingJokers.length > 0) {
    const nextRound = getRoundInSeason(new Date()) + 1;
    html += `<div class="pending-jokers"><h4>⏰ Programmés pour le Round ${nextRound}</h4><div class="pending-list">`;
    
    pendingJokers.forEach(joker => {
      const jokerType = JOKER_TYPES[joker.jokerId];
      if (!jokerType) return;
      html += `<span class="pending-item">${jokerType.icon} ${joker.participantName}${joker.targetName ? ' → ' + joker.targetName : ''}</span>`;
    });
    
    html += '</div></div>';
  }
  
  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU DU CLASSEMENT
// ============================================

export function renderRanking(container, data) {
  const { ranking, seasonData, currentSeasonNumber, seasonStats, eliminationsCount } = data;
  
  if (seasonData?.seasonComplete) {
    container.innerHTML = `
      <div class="empty-state">
        <p>🏆 Saison terminée ! Champion : ${seasonData.winner?.name || 'N/A'}</p>
      </div>
    `;
    return;
  }
  
  if (!ranking || ranking.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Aucune donnée disponible</p></div>';
    return;
  }
  
  let html = `
    <div class="ranking-header">
      <div>Pos.</div>
      <div>Athlète</div>
      <div>D+ Round</div>
      <div>D+ Saison</div>
      <div>Jokers</div>
    </div>
  `;
  
  ranking.forEach((entry, i) => {
    const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rowClass = entry.isInDangerZone ? 'danger-zone' : (entry.isProtected ? 'protected' : '');
    const seasonElev = seasonStats?.[entry.participant.id]?.elevation || 0;
    const effects = entry.jokerEffects || { bonuses: {} };
    
    html += `
      <div class="ranking-row ${rowClass}" data-participant-id="${entry.participant.id}">
        <div class="position ${posClass}">
          ${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : entry.position}
        </div>
        <div class="athlete-info">
          <div class="athlete-avatar" style="background: ${getAthleteColor(entry.participant.id)}">
            ${getAthleteInitials(entry.participant.id)}
          </div>
          <div class="athlete-details">
            <span class="athlete-name">${entry.participant.name}</span>
            ${entry.isInDangerZone ? '<span class="athlete-status danger">⚠️ Zone danger</span>' : ''}
            ${entry.isProtected ? '<span class="athlete-status protected">🛡️ Protégé</span>' : ''}
          </div>
        </div>
        <div class="elevation-cell">
          ${renderElevationWithBonuses(entry.totalElevation, effects.bonuses)}
        </div>
        <div class="elevation-secondary">${formatElevation(seasonElev)}</div>
        <div class="jokers-cell">
          ${renderJokerBadges(entry.participant.id, data.currentRoundNumber)}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

// ============================================
// RENDU DES BADGES JOKERS
// ============================================

function renderJokerBadges(participantId, currentRoundNumber) {
  const status = getJokerStatusForRound(participantId, currentRoundNumber);
  const stock = status.stock;
  
  let html = '';
  
  Object.entries(JOKER_TYPES).forEach(([jokerId, jokerType]) => {
    const count = stock[jokerId] || 0;
    const isActive = status.active.some(j => j.jokerId === jokerId);
    const isPending = status.pending.some(j => j.jokerId === jokerId);
    
    let badgeClass = 'available';
    if (isActive) badgeClass = 'active';
    else if (isPending) badgeClass = 'pending';
    
    if (count > 0 || isActive || isPending) {
      html += `
        <span class="joker-badge ${badgeClass}" title="${jokerType.name}: ${count} restant(s)">
          ${jokerType.icon}${count > 0 ? `<sub>${count}</sub>` : ''}
        </span>
      `;
    }
  });
  
  return html || '<span class="no-jokers">-</span>';
}

// ============================================
// RENDU DU D+ AVEC BONUS
// ============================================

function renderElevationWithBonuses(totalElevation, bonuses = {}) {
  let html = `<span class="elevation-primary">${formatElevation(totalElevation)}</span>`;
  
  const tags = [];
  
  if (bonuses.multiplier) {
    tags.push(`<span class="bonus-tag multiplier">×1.5 +${formatElevation(bonuses.multiplier.amount, false)}</span>`);
  }
  if (bonuses.duelWon) {
    tags.push(`<span class="bonus-tag duel-won">⚔️ +${formatElevation(bonuses.duelWon.amount, false)}</span>`);
  }
  if (bonuses.duelLost) {
    tags.push(`<span class="bonus-tag duel-lost">⚔️ -${formatElevation(bonuses.duelLost.amount, false)}</span>`);
  }
  if (bonuses.sabotaged) {
    tags.push(`<span class="bonus-tag sabotage">💣 -${formatElevation(bonuses.sabotaged.amount, false)}</span>`);
  }
  if (bonuses.sabotageApplied) {
    tags.push(`<span class="bonus-tag sabotage-done">💣 → ${bonuses.sabotageApplied.to}</span>`);
  }
  
  if (tags.length > 0) {
    html += `<div class="elevation-bonuses">${tags.join('')}</div>`;
  }
  
  return html;
}

// ============================================
// RENDU DES PARTICIPANTS (CARDS)
// ============================================

export function renderParticipants(container, data) {
  const { participants, stats, currentRoundNumber } = data;
  
  let html = '<div class="participants-grid">';
  
  participants.forEach(p => {
    const pStats = stats?.[p.id] || { elevation: 0, activities: 0 };
    const stock = getJokerStock(p.id);
    
    html += `
      <div class="participant-card" data-participant-id="${p.id}">
        <div class="card-header">
          <div class="avatar" style="background: ${getAthleteColor(p.id)}">
            ${getAthleteInitials(p.id)}
          </div>
          <div class="info">
            <span class="name">${p.name}</span>
            <span class="stats">${pStats.activities} activités</span>
          </div>
        </div>
        <div class="card-body">
          <div class="elevation">${formatElevation(pStats.elevation)}</div>
          <div class="jokers-row">
            ${Object.entries(JOKER_TYPES).map(([id, j]) => 
              `<span class="mini-joker" title="${j.name}">${j.icon}${stock[id] || 0}</span>`
            ).join('')}
          </div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

// ============================================
// RENDU DU GUIDE DES JOKERS
// ============================================

export function renderJokersGuide(container) {
  let html = `
    <div class="jokers-guide-section">
      <h2 class="section-title">🃏 Guide des Jokers</h2>
      <p class="guide-intro">Chaque participant dispose de jokers stratégiques. Clic droit sur un athlète pour les utiliser.</p>
      
      <div class="jokers-guide-grid">
  `;
  
  Object.entries(JOKER_TYPES).forEach(([id, joker]) => {
    html += `
      <div class="joker-guide-card ${id}">
        <div class="joker-guide-icon">${joker.icon}</div>
        <div class="joker-guide-content">
          <h3>${joker.name}</h3>
          <div class="joker-effect-desc">${joker.description}</div>
          <div class="joker-details">${joker.effect}</div>
          ${!joker.usableInFinal ? '<div class="joker-warning">⚠️ Non utilisable en finale</div>' : ''}
        </div>
      </div>
    `;
  });
  
  html += `
      </div>
      
      <div class="joker-tips">
        <h4>💡 Conseils stratégiques</h4>
        <ul>
          <li>Les jokers s'activent au round suivant leur utilisation</li>
          <li>Le Duel peut retourner une situation défavorable</li>
          <li>Le Bouclier est précieux - gardez-le pour les moments critiques</li>
          <li>Combinez Multiplicateur et effort intense pour maximiser l'impact</li>
        </ul>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
}

// ============================================
// RENDU DES NOTIFICATIONS
// ============================================

let notificationTimeout = null;

export function showNotification(message, type = 'info') {
  let notification = document.getElementById('notification');
  
  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'notification';
    notification.className = 'notification';
    document.body.appendChild(notification);
  }
  
  notification.textContent = message;
  notification.className = `notification notification-${type} visible`;
  
  if (notificationTimeout) clearTimeout(notificationTimeout);
  notificationTimeout = setTimeout(() => {
    notification.classList.remove('visible');
  }, 3000);
}

// ============================================
// RENDU DU MENU CONTEXTUEL JOKERS
// ============================================

let contextMenu = null;

export function createContextMenu() {
  if (contextMenu) return contextMenu;
  
  contextMenu = document.createElement('div');
  contextMenu.className = 'joker-context-menu';
  contextMenu.innerHTML = `
    <div class="context-menu-header">🃏 Utiliser un Joker</div>
    <div class="context-menu-items"></div>
  `;
  document.body.appendChild(contextMenu);
  
  // Fermer au clic ailleurs
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });
  
  return contextMenu;
}

export function showContextMenu(e, participantId, participantName, options = {}) {
  e.preventDefault();
  const menu = createContextMenu();
  
  const stock = getJokerStock(participantId);
  const status = getJokerStatusForRound(participantId, options.currentRoundNumber || 1);
  const isAdmin = options.isAdmin || false;
  
  let itemsHtml = '';
  
  if (isAdmin) {
    itemsHtml += '<div class="context-menu-section">Modifier le stock :</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      itemsHtml += `
        <div class="context-menu-item admin-joker" data-joker="${jokerId}" data-participant="${participantId}">
          <span class="joker-icon">${joker.icon}</span>
          <span class="joker-name">${joker.name}</span>
          <span class="joker-controls">
            <button class="joker-minus" data-action="remove">−</button>
            <span class="joker-count">${count}</span>
            <button class="joker-plus" data-action="add">+</button>
          </span>
        </div>
      `;
    });
  } else {
    itemsHtml += '<div class="context-menu-info">⏰ Activé au prochain round</div>';
    Object.entries(JOKER_TYPES).forEach(([jokerId, joker]) => {
      const count = stock[jokerId] || 0;
      const alreadyPending = status.pending.some(j => j.jokerId === jokerId);
      const disabled = count <= 0 || alreadyPending;
      
      itemsHtml += `
        <div class="context-menu-item ${disabled ? 'disabled' : ''}" 
             data-joker="${jokerId}" 
             data-participant="${participantId}" 
             data-name="${participantName}">
          <span class="joker-icon">${joker.icon}</span>
          <span class="joker-name">${joker.name}</span>
          <span class="joker-count">${count}</span>
          <span class="joker-disabled-reason">
            ${alreadyPending ? '(programmé)' : count <= 0 ? '(épuisé)' : ''}
          </span>
        </div>
      `;
    });
  }
  
  itemsHtml += `
    <div class="context-menu-divider"></div>
    <div class="context-menu-item reset" data-action="reset" data-participant="${participantId}">
      <span class="joker-icon">🔄</span>
      <span class="joker-name">Reset jokers (démo)</span>
    </div>
  `;
  
  menu.querySelector('.context-menu-header').textContent = 
    '🃏 ' + (isAdmin ? 'Gérer' : 'Jokers de') + ' ' + participantName;
  menu.querySelector('.context-menu-items').innerHTML = itemsHtml;
  
  // Positionner le menu
  menu.style.left = Math.min(e.clientX, window.innerWidth - 280) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px';
  menu.classList.add('visible');
  
  return menu;
}

export function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.remove('visible');
  }
}

// ============================================
// MODALE DE SÉLECTION DE CIBLE (DUEL/SABOTAGE)
// ============================================

export function showTargetSelectionModal(options = {}) {
  const { participantId, jokerId, participants, onSelect, onCancel } = options;
  
  const jokerType = JOKER_TYPES[jokerId];
  const currentParticipant = getParticipantById(participantId);
  
  const modal = document.createElement('div');
  modal.className = 'joker-modal';
  modal.innerHTML = `
    <div class="joker-modal-content">
      <div class="joker-modal-header">
        <span>${jokerType.icon} ${jokerType.name} - Choisir une cible</span>
        <button class="joker-modal-close">&times;</button>
      </div>
      <div class="joker-modal-body">
        <p>Sélectionnez l'adversaire à cibler :</p>
        <div class="target-list">
          ${participants
            .filter(p => p.id !== participantId)
            .map(p => `
              <div class="target-option" data-target-id="${p.id}" data-target-name="${p.name}">
                <div class="target-avatar" style="background: ${getAthleteColor(p.id)}">
                  ${getAthleteInitials(p.id)}
                </div>
                <span class="target-name">${p.name}</span>
              </div>
            `).join('')}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Fermer
  modal.querySelector('.joker-modal-close').onclick = () => {
    document.body.removeChild(modal);
    if (onCancel) onCancel();
  };
  
  modal.onclick = (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
      if (onCancel) onCancel();
    }
  };
  
  // Sélection de cible
  modal.querySelectorAll('.target-option').forEach(option => {
    option.onclick = () => {
      const targetId = option.dataset.targetId;
      const targetName = option.dataset.targetName;
      document.body.removeChild(modal);
      if (onSelect) onSelect({ targetId, targetName });
    };
  });
  
  return modal;
}
