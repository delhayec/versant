/**
 * DA « Atelier » : thème et décor. Présentation seulement, aucune donnée.
 * Chargé en synchrone dans <head> pour poser le thème avant le premier rendu.
 *
 * - ?da=off / ?da=on : désactive ou réactive la nouvelle DA (mémorisé),
 *   pour comparer avec l'ancienne.
 * - Thème : « light » ou « dark », mémorisé ; sans choix, celui du système.
 */
(function () {
  const root = document.documentElement;
  const KEY_DA = 'versant_da';
  const KEY_THEME = 'versant_theme';

  function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function write(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* stockage bloqué */ }
  }

  const flag = new URLSearchParams(location.search).get('da');
  if (flag === 'off') write(KEY_DA, 'off');
  if (flag === 'on') write(KEY_DA, null);
  if (read(KEY_DA) === 'off') { root.classList.remove('da-atelier'); return; }
  if (!root.classList.contains('da-atelier')) return;

  // Pictos : pack CoMiGo par défaut ; ?pictos=v1 remet l'ancien set (mémorisé), ?pictos=v2 revient
  const KEY_PICTOS = 'versant_pictos';
  const pictos = new URLSearchParams(location.search).get('pictos');
  if (pictos === 'v1') write(KEY_PICTOS, 'v1');
  if (pictos === 'v2') write(KEY_PICTOS, null);
  if (read(KEY_PICTOS) === 'v1') root.classList.add('pictos-v1');

  // Deux thèmes : clair et cyanotype. Sans choix mémorisé, on suit le système.
  const LABELS = { light: 'clair', dark: 'cyanotype' };
  const stored = read(KEY_THEME);
  const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  let theme = stored === 'light' || stored === 'dark' ? stored : (systemDark ? 'dark' : 'light');

  function apply() { root.setAttribute('data-theme', theme); }
  apply();

  // Le bouton montre le thème affiché : soleil (clair), lune (cyanotype)
  function buildButton(floating) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'da-theme-btn' + (floating ? ' da-theme-btn--floating' : '');
    const update = () => {
      const next = theme === 'light' ? 'dark' : 'light';
      btn.innerHTML = '<span class="da-theme-btn__picto da-theme-btn__picto--' + theme + '" aria-hidden="true"></span>';
      btn.setAttribute('aria-label', 'Thème ' + LABELS[theme] + ', passer en ' + LABELS[next]);
      btn.title = 'Passer en ' + LABELS[next];
    };
    btn.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      write(KEY_THEME, theme);
      const swap = () => { apply(); update(); };
      // Une nouvelle feuille vient se poser sur la page (base.css, ::view-transition) ;
      // sans View Transitions ou avec les animations réduites : changement direct
      const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (document.startViewTransition && !calm) document.startViewTransition(swap);
      else swap();
    });
    update();
    return btn;
  }

  function buildFrame() {
    const frame = document.createElement('div');
    frame.className = 'da-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML =
      '<div class="da-frame__cols">' + 'ABCDEF'.split('').map(c => '<span>' + c + '</span>').join('') + '</div>' +
      '<div class="da-frame__rows">' + '123456'.split('').map(c => '<span>' + c + '</span>').join('') + '</div>';
    return frame;
  }

  /* --- Marqueur B : silhouette fermée d'un feutre biseauté ---
     Calculée à la taille réelle (les bouts ne se déforment pas), posée en
     masque via la variable --da-mk ; la couleur vient du CSS. */
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function markerSVG(w, h, seed, dry) {
    const r = rng(seed);
    const slant = Math.min(h * 0.55, w * 0.08);
    const n = Math.max(4, Math.round(w / 40));
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const x = slant + (w - 2 * slant) * i / n;
      const bow = Math.sin(i / n * Math.PI) * h * 0.06;
      top.push([x, h * 0.08 + (r() - 0.5) * h * 0.12 - bow]);
      bot.push([x - slant * 0.15, h * 0.92 + (r() - 0.5) * h * 0.12 - bow]);
    }
    const p = pt => pt.map(v => v.toFixed(1)).join(' ');
    let d = 'M ' + p([0, h * 0.86]) + ' L ' + p(top[0]);
    for (let i = 1; i <= n; i++) {
      const a = top[i - 1], b = top[i];
      d += ' Q ' + p([(a[0] + b[0]) / 2, a[1] + (r() - 0.5) * h * 0.08]) + ' ' + p(b);
    }
    d += ' L ' + p([w, h * 0.12]) + ' L ' + p(bot[n]);
    for (let i = n - 1; i >= 0; i--) {
      const a = bot[i + 1], b = bot[i];
      d += ' Q ' + p([(a[0] + b[0]) / 2, a[1] + (r() - 0.5) * h * 0.08]) + ' ' + p(b);
    }
    d += ' Z';
    // Stries sèches en fin de trait : marquées sur les petits traits (onglet,
    // rature), à peine visibles sur la jauge (dry = 'light'), sinon elles
    // font une encoche au milieu d'un trait court sur téléphone.
    const long = dry === 'light';
    let streaks = '';
    for (let i = 0; i < (long ? 1 : 3); i++) {
      const y = h * (0.3 + 0.4 * r());
      const x0 = long ? w - Math.min(70, w * 0.06) * (0.6 + 0.4 * r()) : w * (0.6 + 0.2 * r());
      const op = long ? 0.12 + 0.08 * r() : 0.35 + 0.3 * r();
      const sw = Math.max(1, h * (long ? 0.05 : 0.08));
      streaks += '<path d="M ' + x0.toFixed(1) + ' ' + y.toFixed(1) + ' L ' + (w + 2) + ' ' + (y - h * 0.05).toFixed(1) +
        '" stroke="#000" stroke-opacity="' + op.toFixed(2) + '" stroke-width="' + sw.toFixed(1) + '" stroke-linecap="round"/>';
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<mask id="m" maskUnits="userSpaceOnUse"><rect x="-10" y="-10" width="' + (w + 20) + '" height="' + (h + 20) + '" fill="#fff"/>' + streaks + '</mask>' +
      '<path d="' + d + '" fill="#000" mask="url(#m)"/></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  // Le même feutre pour les dessins des pages (calendrier des Règles)
  window.daMarkerSVG = markerSVG;

  // Taille du marqueur selon l'élément qui le porte (doit suivre components.css).
  // fit : le trait se cale sur le texte (cellule plus large que son contenu).
  // reveal : le trait se dessine de droite à gauche quand il entre à l'écran.
  const MARKERS = [
    { selector: '.nav-link.active', size: el => [el.offsetWidth + 14, 12], dry: 'full' },
    { selector: '.da-round-gauge__fill', size: el => [el.offsetWidth, el.offsetHeight], dry: 'light', reveal: true },
    { selector: '.gauge-fill', size: el => [el.offsetWidth, el.offsetHeight], dry: 'light', reveal: true },
    { selector: '.standings-header + .standings-row .standings-total', fit: true, dry: 'light' },
    { selector: '.ranking-header + .ranking-row .elevation-primary', fit: true, dry: 'light' },
    // Historique : le champion, le 1er du challenge des éliminés, et les
    // libellés « Jokers : » / « Bonus éphémères : » quand il y en a eu
    { selector: '.history-champion-name', fit: true, dry: 'light' },
    { selector: '.eliminated-challenge-list > .history-ranking-row:first-child .history-name', fit: true, dry: 'light' },
    { selector: ':is(.history-jokers, .history-bonuses) > .history-label', fit: true, dry: 'light' },
    // Mots soulignés à la main dans les pages (règles, connexion…)
    // (dans un titre il se trace à l'apparition ; dans le texte, il est déjà posé)
    { selector: ':is(h1, h2, h3) .da-mk', fit: true, dry: 'light', reveal: true },
    { selector: '.da-mk', fit: true, dry: 'light' },
  ];
  // Boîte du texte dans l'élément : le surligneur couvre presque toute la hauteur
  function textBox(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect(), b = el.getBoundingClientRect();
    if (!t.width) return null;
    const h = Math.round(t.height * 0.8);
    return { x: t.left - b.left - 5, y: t.top - b.top + (t.height - h) / 2 + 1, w: t.width + 10, h };
  }
  const sized = new WeakMap();
  function paintMarker(el, m) {
    let w, h;
    if (m.fit) {
      const box = textBox(el);
      if (!box) return;
      ({ w, h } = box);
      el.classList.add('da-mk-fit');
      el.style.setProperty('--mk-x', box.x.toFixed(1) + 'px');
      el.style.setProperty('--mk-y', box.y.toFixed(1) + 'px');
      el.style.setProperty('--mk-w', Math.round(w) + 'px');
      el.style.setProperty('--mk-h', h + 'px');
      w = Math.round(w);
    } else {
      [w, h] = m.size(el).map(Math.round);
    }
    if (w < 4 || h < 2) return;
    const key = w + 'x' + h;
    if (sized.get(el) === key) return;
    sized.set(el, key);
    el.classList.add('da-mk-host');
    el.style.setProperty('--da-mk', markerSVG(w, h, hash(el.textContent.trim()), m.dry));
    if (m.reveal) revealOnView(el);
  }

  /* --- Tracé au surligneur : une fois, à la première apparition ---
     On attend la première action du joueur (défilement, toucher, clic,
     touche) : sinon le trait se dessine pendant le chargement et personne
     ne le voit. Sans action, il se trace quand même au bout de 5 s. */
  const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealed = new WeakSet();
  // La jauge collective se trace APRÈS la règle du temps du round : si elle
  // arrive à l'écran avant la fin de celle-ci, elle attend son tour.
  const MK_DURATION = 560;   // ms : 0,42 s de tracé + 0,1 s de délai (components.css)
  let roundDoneAt = 0;
  const afterRound = [];
  function reveal(el) {
    if (el.matches('.gauge-fill')) {
      const round = document.querySelector('.da-round-gauge__fill.da-mk-wait');
      if (round && !round.classList.contains('da-mk-in')) { afterRound.push(el); return; }
      setTimeout(() => el.classList.add('da-mk-in'), Math.max(0, roundDoneAt - Date.now()));
      return;
    }
    el.classList.add('da-mk-in');
    if (el.matches('.da-round-gauge__fill')) {
      roundDoneAt = Date.now() + MK_DURATION;
      setTimeout(() => afterRound.splice(0).forEach(g => g.classList.add('da-mk-in')), MK_DURATION);
    }
  }
  const io = !calm && 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      reveal(e.target);
    });
  }, { threshold: 0.6 }) : null;
  let awake = false;
  const waiting = [];
  function wake() {
    if (awake) return;
    awake = true;
    WAKE_EVENTS.forEach(t => window.removeEventListener(t, wake, true));
    waiting.splice(0).forEach(el => io.observe(el));
  }
  // Seulement des gestes du joueur : un « scroll » peut venir du navigateur
  // (position restaurée au rechargement, page recalée quand les données arrivent)
  const WAKE_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  if (io) {
    WAKE_EVENTS.forEach(t => window.addEventListener(t, wake, { capture: true, passive: true }));
    window.addEventListener('load', () => setTimeout(wake, 5000));
  }
  function revealOnView(el) {
    if (!io || revealed.has(el)) return;
    revealed.add(el);
    el.classList.add('da-mk-wait');
    if (awake) io.observe(el); else waiting.push(el);
  }

  /* --- Cercle au stylo autour de ton nom : jamais deux fois le même ---
     Il se trace une fois, à sa première apparition à l'écran, puis reste
     posé ; il « bout » au survol : trois versions à peine différentes alternent. */
  const CIRCLED = '.ranking-row.is-me .athlete-name, .standings-row.is-me .standings-athlete > span:first-of-type, .da-round-note--circled, .achievement-badge';
  function circlePoints(w, h) {
    const r = Math.random;
    const cx = w / 2, cy = h / 2, rx = w / 2 - 2, ry = h / 2 - 2;
    const start = Math.PI * (0.95 + r() * 0.2);        // départ à gauche, un peu en haut
    const sweep = Math.PI * 2 * (1.08 + r() * 0.06);   // on dépasse le point de départ
    const tilt = (r() - 0.5) * 0.06;
    const pts = [];
    const n = 36;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = start + sweep * t;
      const k = 1 + (r() - 0.5) * 0.04 - t * 0.07;      // la main resserre en fin de tour
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      pts.push([x + (y - cy) * tilt, y - (x - cx) * tilt]);
    }
    return pts;
  }
  const jitter = pts => pts.map(([x, y]) => [x + (Math.random() - 0.5) * 1.6, y + (Math.random() - 0.5) * 1.6]);
  function pathOf(pts) {
    let d = 'M ' + pts[0].map(v => v.toFixed(1)).join(' ');
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ' Q ' + pts[i].map(v => v.toFixed(1)).join(' ') + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1);
    }
    return d;
  }
  // mode : 'still' (posé), 'draw' (se trace), 'none' (pas encore tracé)
  let nonce = 0;
  function circleSVG(w, h, d, mode) {
    const anim = mode === 'draw'
      ? ' pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" from="1" to="0" begin="0.05s" dur="0.55s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.4 0.1 0.3 1"/></path>'
      : '/>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" data-n="' + (nonce++) + '">' +
      (mode === 'none' ? '' : '<path d="' + d + '" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"' + anim) + '</svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }
  const circled = new WeakMap();   // élément -> { key, w, h, pts, visible }
  const CIRCLE_DELAY = 1500;
  const circleIO = !calm && 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(e => {
      const c = circled.get(e.target);
      if (!c || !e.isIntersecting) return;
      circleIO.unobserve(e.target);   // tracé une seule fois, ensuite il reste posé
      // 1,5 s après l'apparition du nom (le temps de poser les yeux sur la page)
      const el = e.target;
      setTimeout(() => {
        const cur = circled.get(el);
        cur.visible = true;
        el.style.setProperty('--da-circle', circleSVG(cur.w, cur.h, pathOf(cur.pts), 'draw'));
      }, Math.max(300, c.born + CIRCLE_DELAY - performance.now()));
    });
  }, { threshold: 0.9 }) : null;
  function circleNames() {
    document.querySelectorAll(CIRCLED).forEach(el => {
      const w = Math.round(el.offsetWidth + 30), h = Math.round(el.offsetHeight + 20);
      const prev = circled.get(el);
      if (w < 20 || (prev && prev.key === w + 'x' + h)) return;
      const c = { key: w + 'x' + h, w, h, pts: circlePoints(w, h), visible: prev ? prev.visible : false, born: prev ? prev.born : performance.now() };
      circled.set(el, c);
      el.classList.add('da-circled');
      // Nouveau cercle : invisible jusqu'à son entrée à l'écran ; redimensionné : posé tel quel
      const mode = !circleIO || (prev && c.visible) ? 'still' : 'none';
      el.style.setProperty('--da-circle', circleSVG(w, h, pathOf(c.pts), mode));
      if (circleIO && !prev) { circleIO.observe(el); watchBoil(el); }
    });
  }
  // Trait qui bout : seulement au survol de la souris
  const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  function watchBoil(el) {
    if (!canHover) return;
    const zone = el.closest('.ranking-row, .standings-row, .achievement-card') || el;
    let timer = null;
    zone.addEventListener('mouseenter', () => {
      const c = circled.get(el);
      if (!c || timer) return;
      const frames = [c.pts, jitter(c.pts), jitter(c.pts)].map(p => circleSVG(c.w, c.h, pathOf(p), 'still'));
      let i = 0;
      timer = setInterval(() => el.style.setProperty('--da-circle', frames[++i % 3]), 125);
    });
    zone.addEventListener('mouseleave', () => {
      clearInterval(timer);
      timer = null;
      const c = circled.get(el);
      if (c) el.style.setProperty('--da-circle', circleSVG(c.w, c.h, pathOf(c.pts), 'still'));
    });
  }

  /* --- Rature au stylo rouge ---
     1. Classements : la position qu'avait chaque ligne à ta dernière visite
        est barrée à côté de la nouvelle (mémorisée dans ce navigateur).
     2. Historique : le nom des éliminés est barré ; la rature se trace à sa
        première apparition à l'écran (une fois par chargement de page). */
  const KEY_RANKS = 'versant_da_ranks';
  const tag = sel => (document.querySelector(sel)?.textContent || '').trim();
  const roundTag = () => { const s = tag('.banner-season-block .banner-value'), r = tag('.banner-round-block .banner-value'); return s && r ? s + '-' + r : ''; };
  const RANK_LISTS = [
    { id: 'round', rows: '#rankingContainer .ranking-row[data-participant-id]', key: r => r.dataset.participantId, cell: '.position', scope: roundTag },
    { id: 'teams', rows: '#rankingContainer .team-ranking > .team-block', key: r => r.querySelector('.team-name')?.textContent.trim(), cell: '.team-position', scope: roundTag },
    { id: 'elim', rows: '#eliminatedChallengeContainer .ranking-row', key: r => r.querySelector('.athlete-name')?.firstChild?.textContent.trim(), cell: '.ranking-position', scope: () => tag('.banner-season-block .banner-value') },
    { id: 'general', rows: '#finalStandingsContainer .standings-row', key: r => r.querySelector('.standings-athlete > span')?.textContent.trim(), cell: '.standings-rank', scope: () => 'annee' },
  ];
  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage bloqué */ } };
  const baselines = {};   // positions lues au chargement de la page, par liste
  function strikeSVG(w, h, lines, mode, k = 1) {
    const r = Math.random, paths = [];
    for (let i = 0; i < lines; i++) {
      const y0 = h * (0.5 + (r() - 0.5) * 0.25), y1 = h * (0.5 + (r() - 0.5) * 0.25);
      const d = 'M 2 ' + y0.toFixed(1) + ' C ' + (w * 0.3).toFixed(1) + ' ' + (y0 + (r() - 0.5) * 4).toFixed(1) + ' ' +
        (w * 0.7).toFixed(1) + ' ' + (y1 + (r() - 0.5) * 4).toFixed(1) + ' ' + (w - 2) + ' ' + y1.toFixed(1);
      const anim = mode === 'draw'
        ? ' pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"><animate attributeName="stroke-dashoffset" from="1" to="0" begin="' + ((0.05 + i * 0.28) * k).toFixed(3) + 's" dur="' + (0.28 * k).toFixed(3) + 's" fill="freeze"/></path>'
        : '/>';
      paths.push('<path d="' + d + '" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round"' + anim);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" data-n="' + (nonce++) + '">' + (mode === 'none' ? '' : paths.join('')) + '</svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }
  // Pose la rature ; draw : elle se tracera après 1 s à l'écran, une à la fois.
  // File d'attente : chaque rature attend que la précédente soit finie.
  const STRIKE_DELAY = 1000;
  const strikeSeen = new Map();   // élément -> instant où il est entré à l'écran (null s'il en est sorti)
  const strikeQueue = [];
  let striking = false;
  const strikeIO = !calm && 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    entries.forEach(e => {
      const el = e.target;
      if (e.isIntersecting) {
        strikeSeen.set(el, performance.now());
        if (!strikeQueue.includes(el)) strikeQueue.push(el);
      } else {
        strikeSeen.set(el, null);
      }
    });
    // Plus de 3 ratures à l'écran en même temps : un seul trait chacune, c'est plus rapide
    const pending = strikeQueue.filter(el => el.isConnected && strikeSeen.get(el) != null);
    if (pending.length > 3) pending.forEach(el => { el.dataset.daLines = '1'; el.dataset.daFast = '1'; });
    // et 20 % plus rapide
    nextStrike();
  }, { threshold: 1 }) : null;
  function nextStrike() {
    if (striking) return;
    // Première rature en attente encore à l'écran (celles sorties attendent leur retour)
    const i = strikeQueue.findIndex(el => el.isConnected && strikeSeen.get(el) != null);
    if (i < 0) return;
    const el = strikeQueue[i];
    striking = true;
    const wait = Math.max(0, strikeSeen.get(el) + STRIKE_DELAY - performance.now());
    setTimeout(() => {
      striking = false;
      if (!el.isConnected || strikeSeen.get(el) == null) { nextStrike(); return; }   // sortie entre-temps
      strikeQueue.splice(strikeQueue.indexOf(el), 1);
      strikeIO.unobserve(el);
      strikeSeen.delete(el);
      const lines = +el.dataset.daLines, k = el.dataset.daFast ? 0.8 : 1;
      el.style.setProperty('--da-strike', strikeSVG(el.offsetWidth + 8, el.offsetHeight, lines, 'draw', k));
      el.dispatchEvent(new CustomEvent('da-struck'));
      striking = true;
      setTimeout(() => { striking = false; nextStrike(); }, ((0.05 + lines * 0.28) * 1000 + 150) * k);
    }, wait);
  }
  function strike(el, lines, draw) {
    el.classList.add('da-strike');
    el.dataset.daLines = lines;
    const still = !draw || !strikeIO;
    el.style.setProperty('--da-strike', strikeSVG(el.offsetWidth + 8, el.offsetHeight, lines, still ? 'still' : 'none'));
    if (!still) strikeIO.observe(el);
  }
  function markRanks() {
    const store = readJSON(KEY_RANKS, {});
    let changed = false;
    RANK_LISTS.forEach(L => {
      const rows = [...document.querySelectorAll(L.rows)];
      const tagged = L.scope();
      if (!rows.length || !tagged) return;
      const scope = L.id + ':' + tagged;
      if (!(scope in baselines)) baselines[scope] = store[scope] || null;
      const now = {};
      rows.forEach((row, i) => {
        const key = L.key(row), cell = row.querySelector(L.cell);
        if (!key || !cell) return;
        const own = [...cell.childNodes].filter(n => !n.classList?.contains('da-was')).map(n => n.textContent).join('').replace('#', '').trim();
        const pos = /^\d+$/.test(own) ? +own : i + 1;
        now[key] = pos;
        const old = baselines[scope]?.[key];
        if (!old || old === pos || cell.querySelector('.da-was')) return;
        const was = document.createElement('span');
        was.className = 'da-was';
        was.textContent = old;
        was.title = old + (old === 1 ? 'er' : 'e') + ' à ta dernière visite';
        cell.classList.add('da-was-host');
        cell.prepend(was);
        strike(was, 1, true);
      });
      // Une seule entrée par liste : on oublie l'ancien round
      Object.keys(store).forEach(k => { if (k.startsWith(L.id + ':') && k !== scope) { delete store[k]; changed = true; } });
      if (JSON.stringify(store[scope]) !== JSON.stringify(now)) { store[scope] = now; changed = true; }
    });
    if (changed) writeJSON(KEY_RANKS, store);
  }
  // Une fois par chargement de page : revenir sur une saison déjà vue la montre raturée
  const struckOnce = new Set();
  try { localStorage.removeItem('versant_da_struck'); } catch { /* ancienne mémoire, abandonnée */ }
  function strikeEliminated() {
    document.querySelectorAll('.history-item .eliminated-name:not(.da-strike)').forEach(el => {
      const id = (el.closest('.history-item')?.dataset.round || '') + ':' + el.textContent.trim();
      const fresh = !struckOnce.has(id);
      strike(el, 2, fresh);
      if (fresh) el.addEventListener('da-struck', () => struckOnce.add(id), { once: true });
    });
  }

  const ro = 'ResizeObserver' in window ? new ResizeObserver(entries => {
    entries.forEach(e => { const m = MARKERS.find(x => e.target.matches(x.selector)); if (m) paintMarker(e.target, m); });
  }) : null;
  const watched = new WeakSet();
  /* Télex : pas des perforations calé sur un tiers de la piste (le contenu
     y est copié trois fois et l'animation avance d'une copie par tour) */
  function tuneTicker() {
    document.querySelectorAll('.ticker-track').forEach(t => {
      const w = t.scrollWidth / 3;
      if (w < 24) return;
      t.style.setProperty('--perf', (w / Math.round(w / 12)).toFixed(3) + 'px');
    });
  }
  /* --- Manuscrit « erratique » (police MANIC) ---
     Police de base, ligatures standard (les discrétionnaires, « ie » en
     « ï » par exemple, gênent la lecture) et, pour le côté erratique, une
     lettre sur dix au plus tirée parmi ses variantes (zone privée de la
     police), de façon stable : même texte, mêmes lettres. Deux variantes du
     4 sont écartées (l'une se lit comme un 9).
     HAND_BOOST : mots répétés sur une même page (« Éliminé R2 » dans
     l'historique…), liste tenue à la main ; là, on force sur les variantes et
     chaque occurrence a les siennes. Le texte d'origine reste dans la page pour les lecteurs
     d'écran ; seul le dessin change. Sont concernés les éléments que les
     feuilles de style écrivent en var(--f-hand), hors graphiques SVG. */
  const HAND_ALTS = {};
  Object.entries({"!":["6c"],"#":["179","17a","17b"],"$":["ef"],"%":["f4"],"&":["f1","f2","1a2"],"(":["181","183","185"],")":["182","184","186"],"*":["dc","172"],"/":["e8"],"0":["16c","16d","16e"],"1":["14f","159","163"],"2":["150","15a","164"],"3":["151","15b","165"],"4":["152","15c","166"],"5":["153","15d","167"],"6":["154","15e","168"],"7":["155","15f","169"],"8":["156","160","16a"],"9":["157","161","16b"],"<":["d8"],">":["d9"],"?":["7b","16f","170","171"],"@":["f5"],"A":["1a","1c","113"],"B":["88","8a","114"],"C":["115","116","117"],"D":["38","118","119"],"E":["11a","11b","11c"],"F":["59","5a","8d"],"G":["a6","11d","11e"],"H":["3c","3d","102"],"I":["30","8e","103"],"J":["43","5d","104"],"K":["90","91","105"],"L":["49","11f","120"],"M":["20","92","106"],"N":["1d","21","107"],"O":["6d","6e","108"],"P":["93","e7","109"],"Q":["94","97","10a"],"R":["40","95","10b"],"S":["10c","10d","10e"],"T":["3b","3e","57"],"U":["6a","6b","99"],"V":["9b","9c","10f"],"W":["9d","9e","ca"],"X":["47","c6","110"],"Y":["c8","c9","111"],"Z":["46","c7","112"],"[":["17d"],"\\":["e9"],"]":["17e"],"^":["da"],"a":["1bd","1d7","1f1"],"b":["1be","1d8","1f2"],"c":["1bf","1d9","1f3"],"d":["1c0","1da","1f4"],"e":["1c1","1db","1f5"],"f":["1c2","1dc","1f6"],"g":["1c3","1dd","1f7"],"h":["1c4","1de","1f8"],"i":["1c5","1df","1f9"],"j":["1c6","1e0","1fa"],"k":["1c7","1e1","1fb"],"l":["1c8","1e2","1fc"],"m":["1c9","1e3","1fd"],"n":["1ca","1e4","1fe"],"o":["1cb","1e5","1ff"],"p":["1cc","1e6","200"],"q":["1cd","1e7","201"],"r":["1ce","1e8","202"],"s":["1cf","1e9","203"],"t":["1d0","1ea","204"],"u":["1d1","1eb","205"],"v":["1d2","1ec","206"],"w":["1d3","1ed","207"],"x":["1d4","1ee","208"],"y":["1d5","1ef","209"],"z":["1d6","1f0","20a"],"{":["17f"],"|":["17c"],"}":["180"],"~":["178"],"¢":["174"],"£":["176"],"¥":["175"],"©":["f6"],"®":["f7"],"¼":["20c"],"½":["20e"],"¾":["210"],"€":["177"],"⅓":["20d"],"⅔":["20f"],"⅕":["20b"]}).forEach(([k, v]) => { HAND_ALTS[k] = v.map(h => String.fromCharCode(0xF000 + parseInt(h, 16))); });
  // Variante n (1 à 3) d'une lettre, pour les notes écrites lettre à lettre (js/da-hand.js)
  const HAND_ALTS_ALL = { ...HAND_ALTS };
  window.daHandAlt = (c, n) => (HAND_ALTS_ALL[c] || [])[n - 1] || c;
  delete HAND_ALTS['4'];
  HAND_ALTS['4'] = [String.fromCharCode(0xF152)];   // four.alt1 seulement
  const HAND_BOOST = [
    // « Éliminé R2 », mais aussi « Éliminé(e) » seul (historique des rounds)
    { re: /^\s*élimin[ée]+s?( r\d+)?\s*$/i, rate: 0.6 },
  ];
  const handSeen = new Map();   // texte renforcé -> nombre d'occurrences déjà tirées
  let handSel = null;
  // découpe une liste de sélecteurs aux virgules de premier niveau (pas dans :is(…))
  function splitSel(list) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of list) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function handSelector() {
    if (handSel) return handSel;
    const sels = [];
    const walk = list => {
      for (const r of list) {
        if (r.selectorText && r.style && r.style.cssText.includes('var(--f-hand)')) sels.push(...splitSel(r.selectorText).filter(x => !x.includes('::')));
        else if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) {
      try { walk(sh.cssRules); } catch { /* feuille d'une autre origine */ }
    }
    handSel = sels.join(',');
    if (handSel) {
      // ligatures standard de MANIC sur tout le manuscrit
      const st = document.createElement('style');
      st.textContent = ':is(' + sels.join(', ') + ') { font-feature-settings: "liga" 1; }';
      document.head.appendChild(st);
    }
    return handSel;
  }
  function scramble(text, rate, salt, keepFirst) {
    let s = text.length * 7 + salt * 7919;
    for (const c of text) s = (s * 31 + c.charCodeAt(0)) >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    let first = keepFirst;
    const lone1 = /^\s*[+−-]?1\s*$/.test(text);
    return Array.from(text, c => {
      // la première lettre reste normale si le CSS doit la passer en capitale
      if (first && /\S/.test(c)) { first = false; return c; }
      // le « 1 » de MANIC est un simple bâton : lisible dans un nombre (121)
      // ou une phrase (« en 1 pt ») ; seul (rang, numéro de round), il prend
      // sa variante à drapeau
      if (c === '1' && lone1) return HAND_ALTS_ALL['1'][0];
      const a = HAND_ALTS[c];
      return a && rnd() < rate ? a[Math.floor(rnd() * a.length)] : c;
    }).join('');
  }
  function erraticHand() {
    const sel = handSelector();
    if (!sel) return;
    let list;
    try { list = document.querySelectorAll(sel); } catch { return; }
    list.forEach(el => {
      if (el.closest('svg') || /^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(el.tagName)) return;
      // rangs : aucun tirage, seulement le 1 à drapeau quand il est seul
      const isRank = el.matches('.position');
      // déjà traité et inchangé : deux enfants, l'original puis le dessin
      if (el.childNodes.length === 2 && el.firstChild.className === 'da-sr' && el.lastChild.className === 'da-hand-v') return;
      // seulement les éléments qui ne contiennent que du texte
      if (!el.childNodes.length || Array.from(el.childNodes).some(n => n.nodeType !== 3)) return;
      const text = el.textContent;
      if (!text.trim()) return;
      // une règle plus précise a pu repasser l'élément dans une autre police
      // (variante MANIC illisible ailleurs : « Ø » à la place d'un J)
      const cs = getComputedStyle(el);
      if (!/MANIC/i.test(cs.fontFamily)) return;
      // les variantes ne suivent pas text-transform : on applique la casse avant
      const tt = cs.textTransform;
      const shown = tt === 'lowercase' ? text.toLowerCase() : tt === 'uppercase' ? text.toUpperCase() : text;
      const boost = HAND_BOOST.find(b => b.re.test(text));
      let salt = 0, rate = isRank ? 0 : 0.1;
      if (boost) {
        salt = handSeen.get(text) || 0;
        handSeen.set(text, salt + 1);
        rate = boost.rate;
      }
      const sr = document.createElement('span');
      sr.className = 'da-sr';
      sr.textContent = text;
      const vis = document.createElement('span');
      vis.className = 'da-hand-v';
      vis.setAttribute('aria-hidden', 'true');
      vis.textContent = scramble(shown, rate, salt, tt === 'lowercase');
      el.replaceChildren(sr, vis);
    });
  }
  /* --- Mots-clés soulignés au stylo (.da-key) ---
     Le trait est en CSS (police MANIC Sketches, il suit le mot quand la ligne
     se coupe ou que la fenêtre change) ; ici on tire seulement lequel, de façon
     stable, et jamais deux fois le même d'affilée. */
  // [trait de MANIC Sketches, hauteur] : la hauteur suit l'épaisseur du dessin
  const KEY_STROKES = [['P', '0.25em'], ['M', '0.22em'], ['O', '0.3em'], ['N', '0.2em'], ['T', '0.42em'], ['S', '0.45em']];
  function seeded(text, salt) {
    let s = 2166136261 ^ salt;
    for (const c of text) s = Math.imul(s ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  }
  let keyLast = -1;
  function keyStrokes() {
    document.querySelectorAll('.da-key:not([style*="--ul:"])').forEach(el => {
      const r = seeded(el.textContent.trim(), 23);
      let i = Math.floor(r() * KEY_STROKES.length);
      if (i === keyLast) i = (i + 1) % KEY_STROKES.length;
      keyLast = i;
      el.style.setProperty('--ul', 'url("/assets/manic/trait-' + KEY_STROKES[i][0] + '.svg")');
      el.style.setProperty('--ul-h', KEY_STROKES[i][1]);
    });
  }
  /* Classement général : une note posée sur la ligne n'apparaît que si elle
     ne chevauche pas le nom et ses étiquettes (sinon, rien plutôt que mal). */
  function fitStandingsNotes() {
    document.querySelectorAll('.standings-row > .da-standings-note').forEach(note => {
      note.classList.remove('da-no-room');
      const nb = note.getBoundingClientRect();
      if (!nb.width) return;
      const cell = note.parentElement.querySelector('.standings-athlete');
      if (!cell) return;
      let right = -Infinity;
      [...cell.children].forEach(c => { const r = c.getBoundingClientRect(); if (r.width) right = Math.max(right, r.right); });
      const cb = cell.getBoundingClientRect();
      // dans la marge (à droite de la ligne) : toujours de la place
      if (nb.left >= note.parentElement.getBoundingClientRect().right) return;
      if (nb.left < right + 12 || nb.right > cb.right + 2) note.classList.add('da-no-room');
    });
  }
  function paintMarkers() {
    fitStandingsNotes();
    erraticHand();
    keyStrokes();
    circleNames();
    fitGaugeToday();
    tuneTicker();
    // (les anciennes positions ne sont plus raturées : places gagnées / perdues
    // depuis minuit, dans la ligne, voir js/ui.js deltaBadge)
    strikeEliminated();
    MARKERS.forEach(m => {
      document.querySelectorAll(m.selector).forEach(el => {
        paintMarker(el, m);
        if (ro && !watched.has(el)) { watched.add(el); ro.observe(el); }
      });
    });
  }
  // Les blocs de l'accueil sont rendus plus tard par app.js : on repeint
  // quand de nouveaux éléments apparaissent (une fois par image au plus).
  let pending = false;
  function watchRenders() {
    if (!('MutationObserver' in window)) return;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; paintMarkers(); });
    }).observe(document.body, { childList: true, subtree: true });
    // Les cercles suivent la largeur des noms (rotation du téléphone, fenêtre)
    let resizing = false;
    window.addEventListener('resize', () => {
      if (resizing) return;
      resizing = true;
      requestAnimationFrame(() => { resizing = false; circleNames(); fitStandingsNotes(); fitGaugeToday(); });
    });
  }

  // Navigation collée en haut : classe sur <html> pour réduire le logo
  function watchStickyNav() {
    const nav = document.querySelector('.nav-sticky');
    if (!nav) return;
    let ticking = false;
    const check = () => {
      ticking = false;
      const top = parseFloat(getComputedStyle(nav).top) || 0;
      root.classList.toggle('da-nav-stuck', window.scrollY > 0 && nav.getBoundingClientRect().top <= top + 0.5);
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(check); }
    }, { passive: true });
    check();    // Hauteur réelle de la navigation (elle change avec la largeur et quand
    // elle se colle) : les bandeaux collés dessous s'y calent (--da-nav-h)
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => root.style.setProperty('--da-nav-h', Math.round(nav.getBoundingClientRect().height) + 'px')).observe(nav);
    }
  }

  // Règle du temps : « AUJ. » masqué s'il touche la date de début ou de fin
  function fitGaugeToday() {
    document.querySelectorAll('.da-round-gauge__marks').forEach(marks => {
      const today = marks.querySelector('.da-round-gauge__today');
      if (!today) return;
      today.style.visibility = '';
      const t = today.getBoundingClientRect();
      const clash = [...marks.children].some(o => {
        if (o === today || getComputedStyle(o).visibility === 'hidden') return false;
        const r = o.getBoundingClientRect();
        return t.left < r.right + 6 && t.right > r.left - 6;
      });
      if (clash) today.style.visibility = 'hidden';
    });
  }

  // Au toucher, ce qui ne s'affichait qu'au survol s'ouvre d'un appui :
  // le texte d'un title dans une bulle, la bulle d'une barre de la page Stats.
  // Un appui ailleurs referme. Liens et boutons gardent leur action.
  function touchInfo() {
    let touch = false, bubble = null, tapped = null;
    const close = () => {
      if (bubble) { bubble.remove(); bubble = null; }
      if (tapped) { tapped.classList.remove('da-tapped'); tapped = null; }
    };
    document.addEventListener('pointerdown', e => { touch = e.pointerType !== 'mouse'; }, true);
    document.addEventListener('click', e => {
      if (!touch) return;
      const was = tapped;
      close();
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.closest('a, button, input, select, textarea, label, [role="button"], [onclick]')) return;
      const bar = t.closest('.perf-bar');
      if (bar) {
        if (bar !== was) { bar.classList.add('da-tapped'); tapped = bar; }
        return;
      }
      const host = t.closest('[title]');
      const text = host && host.getAttribute('title');
      if (!text || !text.trim()) return;
      bubble = document.createElement('div');
      bubble.className = 'da-touch-tip';
      bubble.setAttribute('role', 'status');
      bubble.textContent = text;
      document.body.appendChild(bubble);
      const r = host.getBoundingClientRect(), w = bubble.offsetWidth, h = bubble.offsetHeight;
      bubble.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      bubble.style.top = (r.top > h + 16 ? r.top - h - 8 : r.bottom + 8) + 'px';
    });
    window.addEventListener('scroll', () => { if (bubble) close(); }, { passive: true });
  }

  /* Télex des sorties : il suit le défilement jusqu'au classement du round,
     puis s'efface (et revient en remontant). Sur ordinateur il est fixé en bas
     d'écran : il disparaît quand le classement occupe l'écran ; sur
     téléphone il est dans la navigation : quand le classement passe dessous. */
  function tickerUntilRanking() {
    const ranking = document.getElementById('ranking');
    const tickers = document.querySelectorAll('.activity-ticker');
    if (!ranking || !tickers.length) return;
    let queued = false;
    const update = () => {
      queued = false;
      const top = ranking.getBoundingClientRect().top;
      tickers.forEach(t => {
        const desktop = t.classList.contains('activity-ticker-desktop');
        const nav = t.closest('nav');
        const limit = desktop ? innerHeight * 0.4 : (nav ? nav.getBoundingClientRect().bottom + 8 : 0);
        // Marge de retour plus grande que le télex lui-même : en se repliant,
        // il fait remonter la limite ; sans elle, il clignote sur quelques pixels
        const away = t.classList.contains('da-ticker-away');
        t.classList.toggle('da-ticker-away', away ? top < limit + 90 : top < limit);
      });
    };
    const ask = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', ask, { passive: true });
    window.addEventListener('resize', ask);
    update();
  }

  document.addEventListener('DOMContentLoaded', () => {
    touchInfo();
    tickerUntilRanking();
    document.body.appendChild(buildFrame());
    paintMarkers();
    watchRenders();
    watchStickyNav();
    if (document.fonts) document.fonts.ready.then(paintMarkers);
    const nav = document.querySelector('.nav-links');
    if (nav) nav.appendChild(buildButton(false));
    else document.body.appendChild(buildButton(true));
  });
})();
