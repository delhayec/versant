/**
 * ============================================
 * VERSANT - DÉMO ANIMÉE
 * ============================================
 * Trois tableaux animés, aux couleurs des vrais classements, pour expliquer
 * les règles principales à un nouveau joueur :
 *   1. une activité Strava fait grimper un compteur et remonte un joueur ;
 *   2. fin du round : les 2 derniers sortent, les compteurs repartent de zéro ;
 *   3. challenge des éliminés : nouveaux arrivants, compteurs, cadeaux ;
 *   4. finale, points de la saison au classement général, nouvelle saison.
 * Le joueur suivi (« Toi ») est Sarah, d'une scène à l'autre.
 * Joueurs et chiffres fictifs, aucun appel au serveur. Chaque scène est une
 * suite d'étapes de durée fixe (les chapitres de la barre de progression) et
 * tourne en boucle tant qu'elle est visible à l'écran.
 */
(function () {
  'use strict';

  // « Réduire les animations » : compteurs et déplacements conservés (ils
  // expliquent les règles), sans zoom ni effets décoratifs
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LIFT_SCALE = REDUCED ? 1 : 1.025;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => Math.round(n).toLocaleString('fr-FR');
  const easeInOut = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const ELIM_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
  const ME = 'sarah';

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

  // Interpolation sur `ms` millisecondes : onFrame(k), k de 0 à 1
  function tween(ms, onFrame) {
    return new Promise(done => {
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / ms);
        onFrame(k);
        if (k < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- Compteur à rouleaux ----------
  // Chaque chiffre est une bande 0-9 (+ un 0 pour boucler) qui défile ; un
  // rang ne bascule que lorsque le rang inférieur passe de 9 à 0.
  class Odometer {
    constructor(el, value) {
      this.el = el;
      this.el.classList.add('odo');
      this.cols = [];
      this.set(value);
    }

    ensure(count) {
      while (this.cols.length < count) {
        const k = this.cols.length;
        const col = document.createElement('span');
        col.className = 'odo-col';
        col.innerHTML = `<span class="odo-strip">${'01234567890'.split('').map(d => `<span>${d}</span>`).join('')}</span>`;
        col.strip = col.firstChild;
        if (k % 3 === 0 && k > 0) {
          col.sep = document.createElement('span');
          col.sep.className = 'odo-sep';
          this.el.prepend(col.sep);
        }
        this.el.prepend(col);
        this.cols.push(col);
      }
    }

    set(value) {
      const v = Math.max(0, value);
      const digits = Math.max(1, String(Math.floor(v)).length);
      this.ensure(digits);
      this.cols.forEach((col, k) => {
        const shown = k < digits;
        col.style.display = shown ? '' : 'none';
        if (col.sep) col.sep.style.display = shown ? '' : 'none';
        const p = Math.pow(10, k);
        const roll = k === 0 ? 0 : Math.max(0, (v % p) - (p - 1));
        const pos = k === 0 ? v % 10 : (Math.floor(v / p) % 10) + roll;
        col.strip.style.transform = `translateY(${(-pos * 100) / 11}%)`;
      });
    }
  }

  // ---------- Tableau ----------
  class Table {
    constructor(el, { header, points = false, medals = true, dangerCount = 0, unit = 'm' }) {
      this.el = el;
      this.unit = unit;
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
      row.className = 'ranking-row tour-row' + (id === ME ? ' tour-me' : '');
      row.innerHTML = `
        <div class="ranking-position"></div>
        <div class="ranking-athlete">
          <div class="athlete-avatar" style="background:linear-gradient(135deg,${p.color},${p.color}88)">${initials(p.name)}</div>
          <div class="athlete-info">
            <span class="athlete-name">${p.name}${id === ME ? '<span class="tour-me-tag">Toi</span>' : ''}<span class="tour-gift" hidden></span></span>
            <span class="athlete-status danger" hidden>⚠️<span class="long"> Zone danger</span></span>
          </div>
        </div>
        <div class="ranking-elevation"><span class="tour-num"></span> <span class="elevation-unit">${this.unit}</span></div>
        ${this.points ? '<div class="ranking-points"><span class="points-badge"></span></div>' : ''}`;
      row.dataset.elev = elev;
      row.odo = new Odometer(row.querySelector('.tour-num'), elev);
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
    refresh(order = [...this.body.children]) {
      order.forEach((row, i) => {
        const pos = row.querySelector('.ranking-position');
        pos.className = 'ranking-position' + (this.medals && i < 3 ? ` ${['gold', 'silver', 'bronze'][i]}` : '');
        pos.textContent = this.medals && i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);
        const danger = this.dangerCount > 0 && i >= order.length - this.dangerCount;
        row.classList.toggle('danger-zone', danger);
        row.querySelector('.athlete-status.danger').hidden = !danger;
        const badge = row.querySelector('.points-badge');
        if (badge) badge.textContent = `${ELIM_POINTS[i] ?? 0} pts`;
      });
    }

    // Compteur seul (sans changement de place) : remise à zéro par exemple
    async count(id, target, ms = 1200) {
      const row = this.rows.get(id);
      const start = Number(row.dataset.elev);
      row.dataset.elev = target;
      row.classList.add('tour-counting');
      await tween(ms, k => row.odo.set(k < 1 ? start + (target - start) * easeInOut(k) : target));
      row.classList.remove('tour-counting');
    }

    // Bulle après le nom (activité Strava, bonus ou points gagnés)
    bubble(id, html, kind = 'activity') {
      const row = this.rows.get(id);
      const b = document.createElement('span');
      b.className = `tour-bubble tour-bubble-${kind}`;
      b.innerHTML = html;
      row.querySelector('.athlete-info').appendChild(b);
      setTimeout(() => b.remove(), 2600);
    }

    /**
     * Gain de D+ : le compteur défile et, dès qu'il dépasse celui d'un joueur
     * placé au-dessus, la ligne (détachée, en surbrillance) glisse à sa place
     * et repousse ce joueur vers le bas.
     */
    async gain(id, amount, [icon, label], kind, ms = 2800) {
      const row = this.rows.get(id);
      this.bubble(id, `${icon} <span class="long">${label} · </span>+${fmt(amount)} m<span class="long"> D+</span>`, kind);
      await sleep(400);

      const start = Number(row.dataset.elev);
      const target = start + amount;
      row.dataset.elev = target;
      const order = [...this.body.children];
      const above = order.slice(0, order.indexOf(row));
      const below = order.slice(order.indexOf(row) + 1);
      const height = row.offsetHeight;
      const passed = new Set();
      const currentOrder = () => [...above.filter(r => !passed.has(r)), row, ...above.filter(r => passed.has(r)), ...below];
      const pass = v => {
        let changed = false;
        for (const r of above) {
          if (!passed.has(r) && v > Number(r.dataset.elev)) {
            passed.add(r);
            r.style.transform = `translateY(${height}px)`; // repoussé vers le bas
            changed = true;
          }
        }
        if (changed) this.refresh(currentOrder());
      };
      const targetY = () => -above.filter(r => passed.has(r)).reduce((sum, r) => sum + r.offsetHeight, 0);

      above.forEach(r => r.classList.add('tour-magnet'));
      row.classList.add('tour-lifted', 'tour-counting');
      let y = 0;
      let scale = 1;
      await new Promise(done => {
        const t0 = performance.now();
        let last = t0;
        const frame = now => {
          const k = Math.min(1, (now - t0) / ms);
          const v = k < 1 ? start + amount * easeInOut(k) : target;
          row.odo.set(v);
          pass(v);
          const dt = Math.min(64, now - last);
          last = now;
          const ty = targetY();
          const ease = 1 - Math.pow(0.93, dt / 16); // glisse lentement vers sa place
          y += (ty - y) * ease;
          scale += ((k < 1 ? LIFT_SCALE : 1) - scale) * ease;
          row.style.transform = `translateY(${y}px) scale(${scale})`;
          if (k < 1 || Math.abs(ty - y) > 0.5 || scale > 1.001) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      });

      // Nouvel ordre dans la page, sans saut visuel
      const final = currentOrder();
      for (const r of final) {
        r.style.transition = 'none';
        r.style.transform = '';
        r.classList.remove('tour-magnet');
      }
      final.forEach(r => this.body.appendChild(r));
      this.body.offsetHeight;
      for (const r of final) r.style.transition = '';
      row.classList.remove('tour-lifted', 'tour-counting');
      this.refresh();
    }

    /**
     * Tout le monde marque en même temps : bulles et compteurs ensemble,
     * puis le classement se remet en ordre, les lignes qui montent détachées.
     */
    async gainAll(gains, ms = 2000) {
      for (const [id, amount] of Object.entries(gains)) this.bubble(id, `+${fmt(amount)} ${this.unit}`, 'points');
      await sleep(400);
      await Promise.all(Object.entries(gains).map(([id, amount]) => this.count(id, this.elev(id) + amount, ms)));
      const order = [...this.body.children];
      const before = new Map(order.map(r => [r, r.getBoundingClientRect().top]));
      order.sort((a, b) => Number(b.dataset.elev) - Number(a.dataset.elev)).forEach(r => this.body.appendChild(r));
      const risers = [];
      for (const r of order) {
        const dy = before.get(r) - r.getBoundingClientRect().top;
        r.style.transition = 'none';
        r.style.transform = `translateY(${dy}px)`;
        if (dy > 0) { risers.push(r); r.classList.add('tour-lifted'); }
      }
      this.body.offsetHeight;
      for (const r of order) {
        r.style.transition = 'transform 1.6s cubic-bezier(0.45, 0, 0.2, 1), background 0.3s ease, box-shadow 0.3s ease';
        r.style.transform = '';
      }
      this.refresh();
      await sleep(1700);
      for (const r of order) r.style.transition = '';
      risers.forEach(r => r.classList.remove('tour-lifted'));
    }

    gift(id, emoji = '🎁') {
      const g = this.rows.get(id).querySelector('.tour-gift');
      g.textContent = ` ${emoji}`;
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
    el.classList.remove('tour-caption-in');
    el.offsetHeight;
    el.textContent = text;
    el.classList.add('tour-caption-in');
  };

  /*
   * Une scène : setup() remet le tableau à l'état de départ, puis chaque
   * étape [durée, légende, action] dure exactement sa durée (un chapitre de
   * la barre de progression).
   */

  // ---------- Scène 1 : une activité, un compteur, une remontée ----------
  function sceneActivity(root) {
    const table = new Table(root.querySelector('.tour-table'), { header: ['Pos.', 'Athlète', 'D+ du round'], dangerCount: 2 });
    return {
      setup: () => table.reset([['lea', 1840], ['hugo', 1520], ['sarah', 1210], ['tom', 980], ['ines', 760]]),
      steps: [
        [2800, 'Round en cours. Toi, c\'est Sarah : 3ᵉ, juste au-dessus de la zone danger.'],
        [3800, 'Léa enregistre une sortie trail sur Strava : son compteur grimpe.',
          () => table.gain('lea', 564, ['🏃', 'Trail'], 'activity', 2200)],
        [5600, 'Inès, en zone danger, part à vélo : +612 m. Elle remonte…',
          () => table.gain('ines', 612, ['🚴', 'Vélo'], 'activity', 3600)],
        [3800, 'Inès t\'a doublée : te voilà en zone danger avec Tom. Il reste du temps pour réagir !']
      ]
    };
  }

  // ---------- Scène 2 : fin du round ----------
  function sceneRoundEnd(root) {
    const table = new Table(root.querySelector('.tour-table'), { header: ['Pos.', 'Athlète', 'D+ du round'], dangerCount: 2 });
    const timer = root.querySelector('.banner-countdown-timer');
    const nums = root.querySelectorAll('.countdown-num');
    const field = name => root.querySelector(`[data-tour="${name}"]`);
    const setTimer = values => values.forEach((v, i) => { nums[i].textContent = String(v).padStart(2, '0'); });
    return {
      setup: () => {
        table.dangerCount = 2;
        table.reset([['lea', 2404], ['hugo', 1520], ['ines', 1372], ['sarah', 1210], ['tom', 980]]);
        timer.classList.remove('countdown-ended');
        setTimer([0, 0, 0, 5]);
        field('round').textContent = '1';
        field('day').textContent = 'J5/5';
        field('active').textContent = '5';
        field('out').textContent = '0';
      },
      steps: [
        [5400, 'Dernières secondes du round…', async () => {
          for (let s = 4; s >= 0; s--) { await sleep(1000); setTimer([0, 0, 0, s]); }
        }],
        [2600, 'Fin du round : les 2 derniers sont éliminés. Tom et toi sortez.', async () => {
          timer.classList.add('countdown-ended');
          root.classList.add('tour-flash');
          await sleep(700);
          root.classList.remove('tour-flash');
          await Promise.all([table.remove('tom'), sleep(150).then(() => table.remove('sarah'))]);
          field('active').textContent = '3';
          field('out').textContent = '2';
          table.dangerCount = 0;
          table.refresh();
        }],
        [4800, 'Nouveau round : tout le monde repart de zéro.', async () => {
          field('round').textContent = '2';
          field('day').textContent = 'J1/5';
          timer.classList.remove('countdown-ended');
          setTimer([4, 23, 59, 59]);
          await Promise.all(['lea', 'hugo', 'ines'].map(id => table.count(id, 0, 1600)));
        }]
      ]
    };
  }

  // ---------- Scène 3 : challenge des éliminés ----------
  function sceneEliminated(root) {
    const table = new Table(root.querySelector('.tour-table'), { header: ['Pos.', 'Éliminé', 'D+ cumulé', 'Points'], points: true, medals: false });
    const count = root.querySelector('[data-tour="count"]');
    return {
      setup: () => {
        table.reset([['paul', 640], ['zoe', 380]]);
        count.textContent = '2';
      },
      steps: [
        [2600, 'Les éliminés de la saison continuent dans leur propre challenge.'],
        [2400, 'Tom et toi venez d\'être éliminés : vous rejoignez le challenge.', async () => {
          table.add('sarah', 0, { from: 'left' });
          await sleep(200);
          table.add('tom', 0, { from: 'left' });
          table.refresh();
          count.textContent = '4';
          count.parentElement.classList.remove('tour-pop');
          count.parentElement.offsetHeight;
          count.parentElement.classList.add('tour-pop');
        }],
        [4600, 'Tom part en VTT : +720 m, il prend la tête.',
          () => table.gain('tom', 720, ['🚵', 'VTT'], 'activity', 3400)],
        [2200, '🎁 Meilleur éliminé du round : Tom gagne un bonus.', () => table.gift('tom')],
        [4000, 'Tu sors courir : +410 m, tu doubles Zoé.',
          () => table.gain('sarah', 410, ['🏃', 'Course'], 'activity', 2800)],
        [4000, 'Zoé joue son bonus : une embuscade, 150 m volés à un joueur encore en course. Elle te repasse devant !',
          () => { table.gift('zoe'); return table.gain('zoe', 150, ['🏹', 'Embuscade'], 'bonus', 2400); }],
        [3600, 'Les points des éliminés comptent aussi au classement général.']
      ]
    };
  }

  // ---------- Scène 4 : finale, points de la saison, nouvelle saison ----------
  // Points de la saison = place au challenge principal (24, 21, 18, 15, 12,
  // 10, 8) + place au challenge des éliminés (10, 8, 6, 5, 4), vrai barème.
  function sceneSeason(root) {
    const screens = {
      main: root.querySelectorAll('[data-screen="main"]'),
      general: root.querySelectorAll('[data-screen="general"]')
    };
    const main = new Table(root.querySelector('[data-screen="main"] .tour-table'), { header: ['Pos.', 'Athlète', 'D+ du round'] });
    const general = new Table(root.querySelector('[data-screen="general"] .tour-table'), { header: ['Pos.', 'Athlète', 'Général'], unit: 'pts' });
    const label = root.querySelector('[data-tour="label"]');
    const active = root.querySelector('[data-tour="active"]');
    const show = name => {
      for (const [key, els] of Object.entries(screens)) {
        for (const el of els) {
          el.hidden = key !== name;
          if (key === name) { el.classList.remove('tour-caption-in'); el.offsetHeight; el.classList.add('tour-caption-in'); }
        }
      }
    };
    return {
      setup: () => {
        main.reset([['lea', 1650], ['ines', 1480]]);
        general.reset([['hugo', 58], ['paul', 51], ['sarah', 50], ['lea', 47], ['zoe', 45], ['tom', 40], ['ines', 36]]);
        label.textContent = 'Saison 1 · Finale';
        active.textContent = '2';
        show('main');
      },
      steps: [
        [2600, 'Finale de la saison : il ne reste que Léa et Inès.'],
        [5000, 'Dernier jour : Inès sort une grosse rando et passe devant !',
          () => main.gain('ines', 320, ['🥾', 'Rando'], 'activity', 3200)],
        [2600, 'Fin de la finale : Inès remporte la saison 👑', () => main.gift('ines', '👑')],
        [3000, 'Fin de saison : chacun marque des points selon sa place, au challenge principal et chez les éliminés.', () => {
          label.textContent = 'Classement général';
          show('general');
        }],
        [4800, 'Championne 24 pts, finaliste 21, puis 18, 15… et les points du challenge des éliminés en plus.',
          () => general.gainAll({ ines: 24, lea: 21, hugo: 22, sarah: 20, tom: 22, paul: 18, zoe: 14 })],
        [4000, 'Toi : 15 pts (4ᵉ du principal) + 5 pts (4ᵉ des éliminés) = +20. Tu doubles Paul : 2ᵉ du général !'],
        [4600, 'Nouvelle saison : tout le monde revient en course, compteurs à zéro. Le général, lui, continue de cumuler.', async () => {
          label.textContent = 'Saison 2 · Round 1';
          main.reset([]);
          show('main');
          active.textContent = '7';
          for (const id of ['lea', 'hugo', 'sarah', 'tom', 'ines', 'paul', 'zoe']) {
            main.add(id, 0, { from: 'left' });
            main.refresh();
            await sleep(120);
          }
        }]
      ]
    };
  }

  // ---------- Barre de progression, un chapitre par étape ----------
  function progressBar(root, steps) {
    const total = steps.reduce((sum, [ms]) => sum + ms, 0);
    const bar = document.createElement('div');
    bar.className = 'tour-progress';
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = steps.map(([ms]) => `<span class="tour-chapter" style="flex:${ms / total}"><span class="tour-fill"></span></span>`).join('');
    root.querySelector('.tour-caption').before(bar);
    const fills = [...bar.querySelectorAll('.tour-fill')];
    return {
      start(index, ms) {
        fills.forEach((f, i) => {
          f.style.transition = 'none';
          f.style.width = i < index ? '100%' : '0%';
        });
        bar.offsetHeight;
        fills[index].style.transition = `width ${ms}ms linear`;
        fills[index].style.width = '100%';
      }
    };
  }

  // ---------- Lecture en boucle, seulement quand la scène est visible ----------
  function play(root, build) {
    const scene = build(root);
    const bar = progressBar(root, scene.steps);
    const cap = root.querySelector('.tour-caption');
    let visible = false;
    let running = false;
    const loop = async () => {
      if (running) return;
      running = true;
      try {
        do {
          scene.setup();
          for (let i = 0; i < scene.steps.length && visible; i++) {
            const [ms, text, action] = scene.steps[i];
            if (text) caption(cap, text);
            bar.start(i, ms);
            const pending = action ? action() : null;
            await sleep(ms);
            await pending;
          }
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
    const scenes = { activity: sceneActivity, 'round-end': sceneRoundEnd, eliminated: sceneEliminated, season: sceneSeason };
    document.querySelectorAll('[data-scene]').forEach(root => play(root, scenes[root.dataset.scene]));
    setupJoin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
