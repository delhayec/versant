/**
 * ============================================
 * VERSANT - DÉMO ANIMÉE
 * ============================================
 * Trois tableaux animés, aux couleurs des vrais classements, pour expliquer
 * les règles principales à un nouveau joueur :
 *   1. une activité Strava fait grimper un compteur et remonte un joueur ;
 *   2. fin du round : les 2 derniers sortent, les compteurs repartent de zéro ;
 *   3. challenge des éliminés : nouveaux arrivants, compteurs, cadeaux.
 * Joueurs et chiffres fictifs, aucun appel au serveur. Chaque scène tourne en
 * boucle tant qu'elle est visible à l'écran.
 */
(function () {
  'use strict';

  // « Réduire les animations » : mêmes étapes et légendes, sans mouvement
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => Math.round(n).toLocaleString('fr-FR');
  const ELIM_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

  const PLAYERS = {
    lea: { name: 'Léa M.', color: '#f97316' },
    hugo: { name: 'Hugo B.', color: '#22d3ee' },
    sarah: { name: 'Sarah K.', color: '#a855f7' },
    tom: { name: 'Tom R.', color: '#10b981' },
    ines: { name: 'Inès D.', color: '#fbbf24' },
    paul: { name: 'Paul V.', color: '#ec4899' },
    zoe: { name: 'Zoé L.', color: '#60a5fa' }
  };
  const initials = name => name.split(/[\s.]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  // ---------- Tableau ----------
  class Table {
    constructor(el, { header, points = false, medals = true, dangerCount = 0 }) {
      this.el = el;
      this.points = points;
      this.medals = medals;
      this.dangerCount = dangerCount;
      this.el.innerHTML = `<div class="ranking-header">${header.map(h => `<div>${h}</div>`).join('')}</div><div class="tour-rows"></div>`;
      this.body = this.el.querySelector('.tour-rows');
      this.rows = new Map();
    }

    reset(entries) {
      this.body.innerHTML = '';
      this.rows.clear();
      for (const [id, elev] of entries) this.add(id, elev);
      this.refresh();
    }

    add(id, elev, { from } = {}) {
      const p = PLAYERS[id];
      const row = document.createElement('div');
      row.className = 'ranking-row tour-row';
      row.innerHTML = `
        <div class="ranking-position"></div>
        <div class="ranking-athlete">
          <div class="athlete-avatar" style="background:linear-gradient(135deg,${p.color},${p.color}88)">${initials(p.name)}</div>
          <div class="athlete-info">
            <span class="athlete-name">${p.name}<span class="tour-gift" hidden> 🎁</span></span>
            <span class="athlete-status danger" hidden>⚠️ Zone danger</span>
          </div>
        </div>
        <div class="ranking-elevation"><span class="tour-num">${fmt(elev)}</span> <span class="elevation-unit">m</span></div>
        ${this.points ? '<div class="ranking-points"><span class="points-badge"></span></div>' : ''}`;
      row.dataset.elev = elev;
      if (from) row.classList.add(`tour-enter-${from}`);
      this.body.appendChild(row);
      this.rows.set(id, row);
      if (from) {
        row.offsetHeight; // point de départ de la transition
        row.classList.remove(`tour-enter-${from}`);
      }
      return row;
    }

    elev(id) { return Number(this.rows.get(id).dataset.elev); }

    // Positions, médailles, zone danger et points selon l'ordre affiché
    refresh() {
      const rows = [...this.body.children];
      rows.forEach((row, i) => {
        const pos = row.querySelector('.ranking-position');
        pos.className = 'ranking-position' + (this.medals ? ['gold', 'silver', 'bronze'].map(c => ' ' + c)[i] || '' : '');
        pos.textContent = this.medals && i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
        const danger = this.dangerCount > 0 && i >= rows.length - this.dangerCount;
        row.classList.toggle('danger-zone', danger);
        row.querySelector('.athlete-status.danger').hidden = !danger;
        const badge = row.querySelector('.points-badge');
        if (badge) badge.textContent = `${ELIM_POINTS[i] ?? 0} pts`;
      });
    }

    // Tri par D+ décroissant, lignes déplacées en douceur (technique FLIP)
    sort() {
      const rows = [...this.body.children];
      const before = new Map(rows.map(r => [r, r.getBoundingClientRect().top]));
      rows.sort((a, b) => Number(b.dataset.elev) - Number(a.dataset.elev)).forEach(r => this.body.appendChild(r));
      for (const r of rows) {
        const dy = before.get(r) - r.getBoundingClientRect().top;
        if (!dy) continue;
        r.style.transition = 'none';
        r.style.transform = `translateY(${dy}px)`;
        r.style.zIndex = dy > 0 ? 2 : 1;
        r.offsetHeight;
        r.style.transition = '';
        r.style.transform = '';
        setTimeout(() => { r.style.zIndex = ''; }, 900);
      }
      this.refresh();
    }

    // Compteur qui grimpe (ou descend) jusqu'à la valeur cible
    async count(id, target, ms = 1200) {
      const row = this.rows.get(id);
      const num = row.querySelector('.tour-num');
      const start = Number(row.dataset.elev);
      row.dataset.elev = target;
      if (REDUCED) { num.textContent = fmt(target); return; }
      row.classList.add('tour-counting');
      const t0 = performance.now();
      await new Promise(done => {
        const step = now => {
          const k = Math.min(1, (now - t0) / ms);
          const eased = 1 - Math.pow(1 - k, 3);
          num.textContent = fmt(start + (target - start) * eased);
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
      row.classList.remove('tour-counting');
    }

    // Bulle « activité Strava » après le nom : [icône, sport, gain]
    bubble(id, [icon, label, gain], kind = 'activity') {
      const row = this.rows.get(id);
      const b = document.createElement('span');
      b.className = `tour-bubble tour-bubble-${kind}`;
      b.innerHTML = `${icon} <span class="long">${label} · </span>+${gain} m<span class="long"> D+</span>`;
      row.querySelector('.athlete-info').appendChild(b);
      setTimeout(() => b.remove(), 2600);
    }

    async gain(id, amount, [icon, label], kind) {
      this.bubble(id, [icon, label, fmt(amount)], kind);
      await sleep(500);
      await this.count(id, this.elev(id) + amount);
      this.sort();
      await sleep(900);
    }

    gift(id) {
      const g = this.rows.get(id).querySelector('.tour-gift');
      g.hidden = false;
      g.classList.remove('tour-pop');
      g.offsetHeight;
      g.classList.add('tour-pop');
    }

    async remove(id, to = 'right') {
      const row = this.rows.get(id);
      row.style.height = `${row.offsetHeight}px`;
      row.classList.add(`tour-leave-${to}`);
      await sleep(700);
      row.classList.add('tour-collapse'); // la place libérée se referme
      await sleep(450);
      row.remove();
      this.rows.delete(id);
    }
  }

  const caption = (el, text) => {
    if (!el) return;
    el.classList.remove('tour-caption-in');
    el.offsetHeight;
    el.textContent = text;
    el.classList.add('tour-caption-in');
  };

  // ---------- Scène 1 : une activité, un compteur, une remontée ----------
  async function sceneActivity(root, alive) {
    const table = root.table || (root.table = new Table(root.querySelector('.tour-table'), {
      header: ['Pos.', 'Athlète', 'D+ du round'], dangerCount: 2
    }));
    const cap = root.querySelector('.tour-caption');
    table.reset([['lea', 1840], ['hugo', 1520], ['sarah', 1210], ['tom', 980], ['ines', 760]]);
    caption(cap, 'Round en cours : les 2 derniers sont en zone danger.');
    await sleep(2200); if (!alive()) return;
    caption(cap, 'Léa enregistre une sortie trail sur Strava : son compteur grimpe.');
    await table.gain('lea', 564, ['🏃', 'Trail']);
    await sleep(1200); if (!alive()) return;
    caption(cap, 'Inès, en zone danger, part à vélo : +612 m, elle remonte à la 3ᵉ place !');
    await table.gain('ines', 612, ['🚴', 'Vélo']);
    caption(cap, 'Sarah et Tom passent en zone danger. Il reste du temps pour réagir.');
    await sleep(3500);
  }

  // ---------- Scène 2 : fin du round ----------
  function setTimer(root, [d, h, m, s]) {
    const nums = root.querySelectorAll('.countdown-num');
    [d, h, m, s].forEach((v, i) => { nums[i].textContent = String(v).padStart(2, '0'); });
  }

  async function sceneRoundEnd(root, alive) {
    const table = root.table || (root.table = new Table(root.querySelector('.tour-table'), {
      header: ['Pos.', 'Athlète', 'D+ du round'], dangerCount: 2
    }));
    const cap = root.querySelector('.tour-caption');
    const timer = root.querySelector('.banner-countdown-timer');
    const round = root.querySelector('[data-tour="round"]');
    const day = root.querySelector('[data-tour="day"]');
    const active = root.querySelector('[data-tour="active"]');
    const out = root.querySelector('[data-tour="out"]');

    table.dangerCount = 2;
    table.reset([['lea', 2404], ['hugo', 1520], ['ines', 1372], ['sarah', 1210], ['tom', 980]]);
    timer.classList.remove('countdown-ended');
    round.textContent = '1'; day.textContent = 'J5/5'; active.textContent = '5'; out.textContent = '0';
    caption(cap, 'Dernières secondes du round…');
    for (let s = 5; s >= 0; s--) {
      setTimer(root, [0, 0, 0, s]);
      if (s) await sleep(1000);
      if (!alive()) return;
    }
    timer.classList.add('countdown-ended');
    root.classList.add('tour-flash');
    caption(cap, 'Fin du round : les 2 derniers sont éliminés.');
    await sleep(700);
    root.classList.remove('tour-flash');
    await Promise.all([table.remove('tom'), sleep(150).then(() => table.remove('sarah'))]);
    active.textContent = '3'; out.textContent = '2';
    table.dangerCount = 0;
    table.refresh();
    await sleep(700); if (!alive()) return;
    caption(cap, 'Nouveau round : tout le monde repart de zéro.');
    round.textContent = '2'; day.textContent = 'J1/5';
    timer.classList.remove('countdown-ended');
    setTimer(root, [4, 23, 59, 59]);
    await Promise.all(['lea', 'hugo', 'ines'].map(id => table.count(id, 0, 1000)));
    await sleep(3500);
  }

  // ---------- Scène 3 : challenge des éliminés ----------
  async function sceneEliminated(root, alive) {
    const table = root.table || (root.table = new Table(root.querySelector('.tour-table'), {
      header: ['Pos.', 'Éliminé', 'D+ cumulé', 'Points'], points: true, medals: false
    }));
    const cap = root.querySelector('.tour-caption');
    const count = root.querySelector('[data-tour="count"]');
    table.reset([['paul', 640], ['zoe', 380]]);
    count.textContent = '2';
    caption(cap, 'Les éliminés de la saison continuent dans leur propre challenge.');
    await sleep(2200); if (!alive()) return;
    caption(cap, 'Sarah et Tom viennent d\'être éliminés : ils rejoignent le challenge.');
    table.add('sarah', 0, { from: 'left' });
    await sleep(200);
    table.add('tom', 0, { from: 'left' });
    table.refresh();
    count.textContent = '4';
    count.parentElement.classList.remove('tour-pop'); count.parentElement.offsetHeight; count.parentElement.classList.add('tour-pop');
    await sleep(1800); if (!alive()) return;
    caption(cap, 'Tom part en VTT : +720 m, il prend la tête.');
    await table.gain('tom', 720, ['🚵', 'VTT']);
    caption(cap, '🎁 Meilleur éliminé du round : Tom gagne un bonus.');
    table.gift('tom');
    await sleep(2000); if (!alive()) return;
    caption(cap, 'Sarah sort courir : +410 m, elle double Zoé.');
    await table.gain('sarah', 410, ['🏃', 'Course']);
    await sleep(600); if (!alive()) return;
    caption(cap, 'Zoé joue son bonus : embuscade, 150 m volés à un joueur encore en course !');
    table.gift('zoe');
    await table.gain('zoe', 150, ['🏹', 'Embuscade'], 'bonus');
    caption(cap, 'Les points des éliminés comptent aussi au classement général.');
    await sleep(3500);
  }

  // ---------- Lecture en boucle, seulement quand la scène est visible ----------
  function play(root, scene) {
    let visible = false;
    let running = false;
    const loop = async () => {
      if (running) return;
      running = true;
      try {
        do {
          await scene(root, () => visible);
        } while (visible);
      } finally {
        running = false;
      }
    };
    if (!('IntersectionObserver' in window)) { visible = true; loop(); return; }
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) loop();
    }, { threshold: 0.35 }).observe(root);
  }

  // Lien d'inscription, avec le code de la ligue s'il est saisi
  function setupJoin() {
    const form = document.getElementById('joinForm');
    if (!form) return;
    form.addEventListener('submit', e => {
      e.preventDefault();
      const code = document.getElementById('joinCode').value.trim();
      window.location.href = code ? `inscription.html?invitation=${encodeURIComponent(code)}` : 'inscription.html';
    });
  }

  function init() {
    const scenes = { activity: sceneActivity, 'round-end': sceneRoundEnd, eliminated: sceneEliminated };
    document.querySelectorAll('[data-scene]').forEach(root => play(root, scenes[root.dataset.scene]));
    setupJoin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
