/**
 * ============================================
 * VERSANT - SIMULATEUR D'EFFETS (jokers + bonus)
 * ============================================
 *
 * Mode PREVIEW en lecture seule. Affiche l'effet des jokers et bonus
 * DÉJÀ POSÉS sur le round courant :
 *   - classement BRUT (D+ réel, sans effets)
 *   - classement AVEC EFFETS (vols, sabotages, multiplicateurs, boucliers, bonus éphémères)
 *   - mouvements de position (avant → après)
 *
 * NE FIGE RIEN. NE MODIFIE AUCUN FICHIER. Tout est en mémoire navigateur.
 * Disparaît au refresh.
 *
 * Réutilise les fonctions existantes :
 *   - calculateRanking (standings-engine)
 *   - applyJokerEffects (jokers.js)
 *   - getActiveJokersForRound (jokers.js)
 */

import { getRoundDates, getParticipantById } from './config.js';
import { filterByPeriod, calculateRanking } from './standings-engine.js';
import { applyJokerEffects, getActiveJokersForRound, getBonusesUsedInRound } from './jokers.js';
import { formatElevation } from './ui.js';

/**
 * Construit les données de simulation pour un round donné.
 * @returns {Object} { roundNumber, rows, hasEffects }
 */
function buildSimulation(roundNumber, allActivities, activeParticipants) {
  const roundDates = getRoundDates(roundNumber);
  const today = new Date();
  const endDate = today < new Date(roundDates.end) ? today : roundDates.end;
  const roundActivities = filterByPeriod(allActivities, roundDates.start, endDate);

  // 1. Classement BRUT (sans effets)
  const rawRanking = calculateRanking(roundActivities, activeParticipants);

  // Map id -> { position, elevation } pour le brut
  const rawById = {};
  rawRanking.forEach((entry, idx) => {
    rawById[String(entry.participant.id)] = {
      position: idx + 1,
      elevation: entry.totalElevation
    };
  });

  // 2. Classement AVEC EFFETS (jokers : voleur, sabotage, multiplicateur, bouclier)
  //    On passe bien roundActivities (sinon le voleur ne calcule rien).
  const baseForEffects = calculateRanking(roundActivities, activeParticipants);
  const withEffects = applyJokerEffects(baseForEffects, roundNumber, roundActivities);

  // 3. Bonus éphémères utilisés ce round (pour affichage informatif)
  let bonusesUsed = [];
  try {
    bonusesUsed = getBonusesUsedInRound(roundNumber) || [];
  } catch (e) {
    bonusesUsed = [];
  }
  const bonusByAthlete = {};
  bonusesUsed.forEach(b => {
    bonusByAthlete[String(b.athlete_id)] = b;
  });

  // 4. Construire les lignes du tableau
  const activeJokers = getActiveJokersForRound(roundNumber);
  const hasEffects = activeJokers.length > 0 || bonusesUsed.length > 0;

  const rows = withEffects.map((entry, idx) => {
    const id = String(entry.participant.id);
    const raw = rawById[id] || { position: idx + 1, elevation: entry.totalElevation };
    const finalPos = idx + 1;
    const movement = raw.position - finalPos; // >0 = monte, <0 = descend

    // Effets lisibles
    const effects = [];
    const je = entry.jokerEffects || {};
    const b = je.bonuses || {};

    // Volé (victime)
    if (b.stolen && b.stolen.amount > 0) {
      effects.push({
        icon: '🦹', type: 'loss',
        text: `Volé par ${b.stolen.by}`,
        amount: -b.stolen.amount
      });
    }
    // Vol réussi (voleur) : somme des gains
    if (Array.isArray(b.thief) && b.thief.length > 0) {
      const gained = b.thief.reduce((s, t) => s + t.amount, 0);
      const victims = b.thief.map(t => t.from).join(', ');
      effects.push({
        icon: '🦹', type: 'gain',
        text: `A volé ${victims}`,
        amount: gained
      });
    }
    // Saboté (victime)
    if (b.sabotaged && b.sabotaged.amount > 0) {
      effects.push({
        icon: '💥', type: 'loss',
        text: `Saboté par ${b.sabotaged.by}`,
        amount: -b.sabotaged.amount
      });
    }
    // Sabotage réussi (attaquant)
    if (Array.isArray(b.sabotageApplied) && b.sabotageApplied.length > 0) {
      const targets = b.sabotageApplied.map(s => s.to).join(', ');
      effects.push({
        icon: '💥', type: 'neutral',
        text: `A saboté ${targets}`,
        amount: 0
      });
    }
    // Multiplicateur
    if (b.multiplier && b.multiplier.amount > 0) {
      effects.push({
        icon: '✨', type: 'gain',
        text: `Multiplicateur ×${b.multiplier.factor}`,
        amount: b.multiplier.amount
      });
    }
    // Bouclier
    if (b.shield) {
      effects.push({
        icon: '🛡️', type: 'neutral',
        text: 'Bouclier (protégé)',
        amount: 0
      });
    }
    // Bonus éphémère utilisé ce round
    const bonus = bonusByAthlete[id];
    if (bonus) {
      effects.push({
        icon: bonus.bonusIcon || '🎁', type: 'neutral',
        text: `Bonus : ${bonus.bonusName}${bonus.targetName ? ' → ' + bonus.targetName : ''}`,
        amount: 0
      });
    }

    return {
      id,
      name: entry.participant.name,
      rawPosition: raw.position,
      finalPosition: finalPos,
      movement,
      rawElevation: Math.round(raw.elevation),
      finalElevation: Math.round(entry.totalElevation),
      effects
    };
  });

  return { roundNumber, rows, hasEffects };
}

/**
 * Génère le HTML du panneau de simulation.
 */
function renderSimulationHTML(sim) {
  const movementBadge = (mvt) => {
    if (mvt > 0) return `<span class="sim-mvt sim-mvt-up">▲ ${mvt}</span>`;
    if (mvt < 0) return `<span class="sim-mvt sim-mvt-down">▼ ${Math.abs(mvt)}</span>`;
    return `<span class="sim-mvt sim-mvt-same">=</span>`;
  };

  const effectsHTML = (effects) => {
    if (!effects.length) return '<span class="sim-no-effect">—</span>';
    return effects.map(e => {
      const amountStr = e.amount > 0
        ? `<span class="sim-eff-gain">+${formatElevation(e.amount, false)}</span>`
        : e.amount < 0
        ? `<span class="sim-eff-loss">−${formatElevation(Math.abs(e.amount), false)}</span>`
        : '';
      return `<div class="sim-effect">
        <span class="sim-eff-icon">${e.icon}</span>
        <span class="sim-eff-text">${e.text}</span>
        ${amountStr}
      </div>`;
    }).join('');
  };

  const deltaElev = (raw, final) => {
    const d = final - raw;
    if (d === 0) return '';
    const cls = d > 0 ? 'sim-delta-gain' : 'sim-delta-loss';
    const sign = d > 0 ? '+' : '−';
    return `<span class="sim-delta ${cls}">${sign}${formatElevation(Math.abs(d), false)}</span>`;
  };

  const rowsHTML = sim.rows.map(r => `
    <tr class="${r.movement !== 0 ? 'sim-row-moved' : ''}">
      <td class="sim-pos">
        <span class="sim-pos-final">${r.finalPosition}</span>
        ${movementBadge(r.movement)}
      </td>
      <td class="sim-name">${r.name}</td>
      <td class="sim-elev">
        <span class="sim-elev-final">${formatElevation(r.finalElevation, false)} m</span>
        ${deltaElev(r.rawElevation, r.finalElevation)}
      </td>
      <td class="sim-effects">${effectsHTML(r.effects)}</td>
    </tr>
  `).join('');

  return `
    <div class="sim-banner">
      🧪 <strong>SIMULATION</strong> — Aperçu des effets jokers &amp; bonus du round ${sim.roundNumber}.
      Aucune donnée n'est enregistrée.
    </div>
    ${!sim.hasEffects ? `
      <div class="sim-empty">Aucun joker ni bonus actif sur ce round pour le moment.</div>
    ` : `
      <table class="sim-table">
        <thead>
          <tr>
            <th>Pos.</th>
            <th>Joueur</th>
            <th>D+ final</th>
            <th>Effets appliqués</th>
          </tr>
        </thead>
        <tbody>${rowsHTML}</tbody>
      </table>
    `}
  `;
}

/**
 * Point d'entrée : ouvre/ferme le simulateur.
 * @param {number} roundNumber - round à simuler
 * @param {Array} allActivities - toutes les activités
 * @param {Array} activeParticipants - ids des participants actifs
 */
export function toggleSimulator(roundNumber, allActivities, activeParticipants) {
  const panel = document.getElementById('simulatorPanel');
  if (!panel) return;

  // Toggle : si déjà ouvert, fermer
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    panel.innerHTML = '';
    return;
  }

  try {
    const sim = buildSimulation(roundNumber, allActivities, activeParticipants || []);
    panel.innerHTML = renderSimulationHTML(sim);
    panel.classList.add('open');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.error('❌ Erreur simulation:', e);
    panel.innerHTML = `<div class="sim-banner sim-error">Erreur lors de la simulation : ${e.message}</div>`;
    panel.classList.add('open');
  }
}