/* Kotoba — Japanese flashcards. Plain JS, no build step. */
(() => {
  'use strict';

  const APP_VERSION = '1.0.2';
  const KEY_PROGRESS = 'kotoba.progress.v1';
  const KEY_SETTINGS = 'kotoba.settings.v1';
  const SEP = '\u001f';                       // deck name + SEP + jp text = progress key
  const INTERVALS = [0, 1, 3, 7, 14, 30, 60]; // Leitner box -> days until the card is due again
  const MASTERED_BOX = 4;                     // box 4 (14-day interval) counts as mastered
  const MAX_BOX = INTERVALS.length - 1;
  const DAY = 86400000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- storage
  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }; }
    catch { return { ...fallback }; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('save failed', e); }
  }

  const state = {
    decks: [],            // [{ name, cards: [{ deck, jp, romaji, sounds, en, key }] }]
    cardsVersion: null,
    progress: loadJSON(KEY_PROGRESS, { cards: {}, streak: { count: 0, lastDay: null }, sessions: 0, lastVersion: null }),
    settings: loadJSON(KEY_SETTINGS, { theme: 'auto', reverse: false, shuffle: false, size: 20, name: 'Elan', autoSpeak: false }),
    selected: new Set(),
    session: null,
    screen: 'home',
  };
  const saveProgress = () => saveJSON(KEY_PROGRESS, state.progress);
  const saveSettings = () => saveJSON(KEY_SETTINGS, state.settings);

  // ---------------------------------------------------------------- helpers
  const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yesterdayKey = () => todayKey(new Date(Date.now() - DAY));
  const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };

  function cardRecord(card) { return state.progress.cards[card.key]; }
  function isDue(card) { const r = cardRecord(card); return !r || r.due <= endOfToday(); }
  function isNew(card) { return !cardRecord(card); }
  function isMastered(card) { const r = cardRecord(card); return !!r && r.box >= MASTERED_BOX; }

  function deckStats(deck) {
    let due = 0, mastered = 0, learned = 0, boxSum = 0;
    for (const c of deck.cards) {
      if (isDue(c)) due++;
      if (isMastered(c)) mastered++;
      const r = cardRecord(c);
      if (r) { learned++; boxSum += Math.min(r.box, MASTERED_BOX); }
    }
    const total = deck.cards.length;
    return { total, due, mastered, learned, mastery: total ? boxSum / (total * MASTERED_BOX) : 0 };
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function fmtTime(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function haptic(ms = 10) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } }
  function jpSizeClass(text) {
    const n = [...text.replace(/[\s。、！？]/g, '')].length;
    if (n <= 2) return 'size-xl';
    if (n <= 5) return 'size-l';
    if (n <= 9) return 'size-m';
    if (n <= 15) return 'size-s';
    return 'size-xs';
  }

  // ---------------------------------------------------------------- theme
  const metaTheme = $('#meta-theme-color');
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = state.settings.theme;
    const dark = t === 'dark' || (t === 'auto' && darkMQ.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    metaTheme.setAttribute('content', dark ? '#14161c' : '#f7f3ec');
    $$('#opt-theme .seg').forEach(b => b.classList.toggle('is-on', b.dataset.theme === t));
  }
  darkMQ.addEventListener?.('change', applyTheme);

  // ---------------------------------------------------------------- speech
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang.replace('_', '-')));
    const pick = pickVoice();
    $('#voice-name').textContent = pick ? `Voice: ${pick.name}` : 'No Japanese voice found on this device';
  }
  function pickVoice() {
    if (!voices.length) return null;
    const pref = ['Kyoko', 'O-Ren', 'Otoya', 'Hattori', 'Google 日本語', 'Microsoft Nanami'];
    for (const p of pref) { const v = voices.find(v => v.name.includes(p)); if (v) return v; }
    return voices.find(v => v.localService) || voices[0];
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }
  let currentUtterance = null; // keep a reference so the utterance isn't garbage-collected mid-speech
  let speechPrimed = false;
  function primeSpeech() {
    // iOS only lets speech start from a user gesture; an empty utterance on the first tap unlocks it
    if (speechPrimed || !('speechSynthesis' in window)) return;
    speechPrimed = true;
    try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; speechSynthesis.speak(u); } catch {}
  }
  function speak(text, btn) {
    if (!('speechSynthesis' in window)) { toast('Speech is not supported on this device'); return; }
    const clean = text.replace(/○○/g, 'なになに').replace(/／/g, '、').replace(/[（）()]/g, '');
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'ja-JP'; u.rate = 0.9; u.pitch = 1; u.volume = 1;
    const v = pickVoice(); if (v) u.voice = v;
    if (btn) { btn.classList.add('is-speaking'); u.onend = u.onerror = () => btn.classList.remove('is-speaking'); }
    currentUtterance = u;
    const go = () => { try { speechSynthesis.resume(); speechSynthesis.speak(u); } catch (e) { console.warn('speak failed', e); } };
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      // iOS drops an utterance queued immediately after cancel(); give the engine a beat
      speechSynthesis.cancel();
      setTimeout(go, 80);
    } else {
      go();
    }
  }

  // ---------------------------------------------------------------- screens
  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
    const active = $(`.screen[data-screen="${name}"]`);
    if (active && name !== 'study') active.scrollTop = 0;
  }

  // ---------------------------------------------------------------- toast
  let toastTimer;
  function toast(text, { action, onAction, duration = 3200 } = {}) {
    const el = $('#toast'), btn = $('#toast-btn');
    $('#toast-text').textContent = text;
    btn.hidden = !action;
    if (action) { btn.textContent = action; btn.onclick = () => { hideToast(); onAction?.(); }; }
    el.hidden = false;
    clearTimeout(toastTimer);
    if (duration) toastTimer = setTimeout(hideToast, duration);
  }
  function hideToast() { $('#toast').hidden = true; }

  // ---------------------------------------------------------------- modal
  function confirmSheet({ title, text, confirmLabel = 'Confirm', danger = true }) {
    return new Promise(resolve => {
      const m = $('#modal');
      $('#modal-title').textContent = title;
      $('#modal-text').textContent = text;
      const ok = $('#modal-confirm'), cancel = $('#modal-cancel');
      ok.textContent = confirmLabel;
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      m.hidden = false;
      const done = v => { m.hidden = true; ok.onclick = cancel.onclick = $('#modal-backdrop').onclick = null; resolve(v); };
      ok.onclick = () => done(true);
      cancel.onclick = $('#modal-backdrop').onclick = () => done(false);
    });
  }

  // ---------------------------------------------------------------- data
  async function loadCards({ silent = false } = {}) {
    let data;
    try {
      const res = await fetch('./cards.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      console.warn('cards.json load failed', e);
      if (!state.decks.length) {
        $('#deck-list').innerHTML = '<div class="empty">Couldn\'t load cards.json. Check your connection and reload.</div>';
        $('#hero-sub').textContent = 'No cards loaded';
      } else if (!silent) toast('Couldn\'t check for new cards');
      return false;
    }
    const decks = (data.decks || []).filter(d => d && d.name && Array.isArray(d.cards)).map(d => ({
      name: String(d.name),
      cards: d.cards.filter(c => c && c.jp).map(c => ({
        deck: String(d.name), jp: String(c.jp), romaji: String(c.romaji || ''), sounds: String(c.sounds || ''), en: String(c.en || ''),
        key: `${d.name}${SEP}${c.jp}`,
      })),
    }));
    const prevVersion = state.cardsVersion;
    const prevCount = state.decks.reduce((n, d) => n + d.cards.length, 0);
    state.decks = decks;
    state.cardsVersion = data.version != null ? String(data.version) : null;
    const count = decks.reduce((n, d) => n + d.cards.length, 0);
    $('#data-info').textContent = `${count} cards in ${decks.length} decks${state.cardsVersion ? ` · ${state.cardsVersion}` : ''}`;

    if (prevVersion !== null && (prevVersion !== state.cardsVersion || prevCount !== count)) {
      toast(`Cards updated · ${count} cards`);
    } else if (!silent && prevVersion !== null) {
      toast('Cards are up to date');
    }
    if (state.cardsVersion && state.progress.lastVersion !== state.cardsVersion) {
      if (state.progress.lastVersion !== null) toast(`New cards loaded · ${count} cards`);
      state.progress.lastVersion = state.cardsVersion; saveProgress();
    }
    // forget selections of decks that no longer exist
    for (const name of [...state.selected]) if (!decks.some(d => d.name === name)) state.selected.delete(name);
    return true;
  }

  // ---------------------------------------------------------------- streak
  function currentStreak() {
    const s = state.progress.streak;
    if (!s.lastDay) return 0;
    if (s.lastDay === todayKey() || s.lastDay === yesterdayKey()) return s.count;
    return 0;
  }
  function touchStreak() {
    const s = state.progress.streak, today = todayKey();
    if (s.lastDay === today) return;
    s.count = s.lastDay === yesterdayKey() ? s.count + 1 : 1;
    s.lastDay = today;
    saveProgress();
  }

  // ---------------------------------------------------------------- home
  function renderHome() {
    $('#home-name').textContent = state.settings.name || 'Elan';
    $('#home-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

    const streak = currentStreak();
    $('#stat-streak').textContent = streak;
    $('#stat-streak-sub').textContent = streak === 0 ? 'Study today to start one'
      : state.progress.streak.lastDay === todayKey() ? 'Studied today · keep it up' : 'Study today to keep it';

    const all = state.decks.flatMap(d => d.cards);
    const mastered = all.filter(isMastered).length;
    const due = all.filter(isDue).length;
    const newCount = all.filter(isNew).length;
    $('#stat-mastered').textContent = mastered;
    $('#stat-mastered-sub').textContent = `of ${all.length} cards`;
    $('#hero-count').textContent = due;
    $('#hero-sub').textContent = all.length === 0 ? 'No cards yet'
      : due === 0 ? 'All caught up · review anyway'
      : newCount === due ? `${due} new cards waiting` : `${due - newCount} to review · ${newCount} new`;
    $('.hero-title').textContent = due === 0 && all.length ? 'Review all cards' : 'Study due cards';

    // options
    $('#opt-reverse').setAttribute('aria-pressed', String(!!state.settings.reverse));
    $('#opt-shuffle').setAttribute('aria-pressed', String(!!state.settings.shuffle));
    $$('#opt-size .seg').forEach(b => b.classList.toggle('is-on', Number(b.dataset.size) === Number(state.settings.size)));

    // decks
    const list = $('#deck-list');
    list.innerHTML = '';
    if (!state.decks.length) { list.innerHTML = '<div class="empty">No decks in cards.json yet.</div>'; return; }
    state.decks.forEach((deck, i) => {
      const s = deckStats(deck);
      const el = document.createElement('div');
      el.className = 'deck' + (state.selected.has(deck.name) ? ' is-selected' : '');
      el.style.setProperty('--i', i);
      el.setAttribute('role', 'button');
      const pct = Math.round(s.mastery * 100);
      const complete = s.total > 0 && s.mastered === s.total;
      const ring = complete
        ? `<div class="hanko" title="Mastered"><svg viewBox="0 0 48 48"><rect x="3" y="3" width="42" height="42" rx="9" fill="none" stroke="var(--accent)" stroke-width="3"/><rect x="8" y="8" width="32" height="32" rx="5" fill="var(--accent)" opacity=".12"/><text x="24" y="33" text-anchor="middle" font-family="Noto Sans JP, sans-serif" font-size="22" font-weight="700" fill="var(--accent)">済</text></svg></div>`
        : `<div class="ring"><svg viewBox="0 0 52 52"><circle class="track" cx="26" cy="26" r="22"/><circle class="fill" cx="26" cy="26" r="22" style="stroke-dashoffset:${(138.2 * (1 - s.mastery)).toFixed(1)}"/></svg><div class="pct">${pct}%</div></div>`;
      el.innerHTML = `
        ${ring}
        <div class="deck-body">
          <div class="deck-name">${escapeHTML(deck.name)}</div>
          <div class="deck-meta"><span>${s.total} card${s.total === 1 ? '' : 's'}</span><span class="dot"></span>${s.due ? `<span class="due">${s.due} due</span>` : `<span>${complete ? 'mastered' : 'nothing due'}</span>`}</div>
        </div>
        <button class="deck-check" aria-label="Select deck"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span></button>`;
      el.querySelector('.deck-check').addEventListener('click', e => {
        e.stopPropagation(); haptic();
        if (state.selected.has(deck.name)) state.selected.delete(deck.name); else state.selected.add(deck.name);
        el.classList.toggle('is-selected', state.selected.has(deck.name));
        renderMixBar();
      });
      el.addEventListener('click', () => startSession({ decks: [deck], title: deck.name }));
      list.appendChild(el);
    });
    // trigger ring animation after paint
    requestAnimationFrame(() => $$('.ring .fill', list).forEach(c => { const v = c.style.strokeDashoffset; c.style.strokeDashoffset = '138.2'; requestAnimationFrame(() => { c.style.strokeDashoffset = v; }); }));
    renderMixBar();
  }

  function renderMixBar() {
    const bar = $('#mix-bar');
    const decks = state.decks.filter(d => state.selected.has(d.name));
    if (!decks.length) { bar.hidden = true; return; }
    const total = decks.reduce((n, d) => n + d.cards.length, 0);
    const due = decks.reduce((n, d) => n + deckStats(d).due, 0);
    $('#mix-title').textContent = decks.length === 1 ? decks[0].name : `${decks.length} decks selected`;
    $('#mix-sub').textContent = `${total} cards · ${due} due`;
    bar.hidden = false;
  }

  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------------------------------------------------------------- session
  function startSession({ decks, title, dueOnly = false, cards = null, redo = false }) {
    let pool = cards || decks.flatMap(d => d.cards);
    if (!pool.length) { toast('This deck has no cards'); return; }
    let label = title;
    if (dueOnly) {
      const due = pool.filter(isDue);
      if (due.length) pool = due;
      else { label = 'Review'; toast('Nothing due — reviewing everything'); }
    }
    if (state.settings.shuffle || dueOnly) pool = shuffle(pool);
    if (!state.settings.shuffle && !dueOnly) {
      // keep deck order, but put due cards first so a partial session is useful
      pool = pool.slice().sort((a, b) => Number(isDue(b)) - Number(isDue(a)));
    }
    if (dueOnly) pool.sort((a, b) => Number(isNew(a)) - Number(isNew(b))); // reviews before brand-new cards
    const size = Number(state.settings.size);
    if (size > 0 && !redo) pool = pool.slice(0, size);

    state.session = {
      title: label, queue: pool.slice(), total: pool.length, done: 0,
      results: new Map(), missed: [], startedAt: Date.now(), current: null, flipped: false, busy: false,
      reverse: !!state.settings.reverse,
      multiDeck: new Set(pool.map(c => c.deck)).size > 1,
    };
    $('#study-title').textContent = label;
    showScreen('study');
    renderProgress();
    nextCard();
  }

  function renderProgress() {
    const s = state.session; if (!s) return;
    const left = s.total - s.done;
    $('#study-progress').style.width = `${(s.done / s.total) * 100}%`;
    $('#study-counter').textContent = `${left} left`;
  }

  function nextCard() {
    const s = state.session;
    const stage = $('#card-stage');
    $$('.swipe-card', stage).forEach(el => el.remove());
    if (!s.queue.length) { finishSession(); return; }
    s.current = s.queue.shift();
    s.flipped = false; s.busy = false;
    const el = buildCard(s.current, s.reverse);
    stage.appendChild(el);
    attachSwipe(el);
    $('#actions-reveal').hidden = false;
    $('#actions-grade').hidden = true;
    const remainingAfter = s.queue.length;
    $('.card-ghost-1').classList.toggle('is-hidden', remainingAfter < 1);
    $('.card-ghost-2').classList.toggle('is-hidden', remainingAfter < 2);
    if (state.settings.autoSpeak && !s.reverse) setTimeout(() => speak(s.current.jp, el.querySelector('.card-front .speak-btn')), 250);
  }

  function buildCard(card, reverse) {
    const el = document.createElement('div');
    el.className = 'swipe-card';
    const multiDeck = state.session ? state.session.multiDeck : true;
    const speakBtn = `<button class="speak-btn" aria-label="Read aloud"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg></button>`;
    const top = `<div class="card-top"><span class="card-deck">${multiDeck ? escapeHTML(card.deck) : ''}</span>${speakBtn}</div>`;
    const jpFront = `<div class="card-jp ${jpSizeClass(card.jp)}">${escapeHTML(card.jp)}</div>`;
    const enFront = `<div class="card-en-front ${card.en.length > 28 ? 'long' : ''}">${escapeHTML(card.en)}</div>`;
    const backDetails = `
      ${card.romaji ? `<div class="card-romaji">${escapeHTML(card.romaji)}</div>` : ''}
      ${card.sounds ? `<div class="card-sounds">“${escapeHTML(card.sounds)}”</div>` : ''}
      <div class="card-sep"></div>`;
    const front = reverse ? enFront : jpFront;
    const back = reverse
      ? `<div class="card-jp on-back rev ${jpSizeClass(card.jp)}">${escapeHTML(card.jp)}</div>${backDetails}<div class="card-en" style="font-size:17px;color:var(--text-2);font-weight:500">${escapeHTML(card.en)}</div>`
      : `<div class="card-jp on-back">${escapeHTML(card.jp)}</div>${backDetails}<div class="card-en">${escapeHTML(card.en)}</div>`;
    el.innerHTML = `
      <div class="card-inner">
        <div class="card-face card-front">${top}<div class="card-main">${front}</div><div class="card-hint">Tap to flip</div></div>
        <div class="card-face card-back">${top}<div class="card-main">${back}</div><div class="card-hint">Swipe → got it · ← again</div></div>
      </div>
      <div class="card-tint"></div>
      <div class="stamp stamp-good">Got it</div>
      <div class="stamp stamp-again">Again</div>`;
    $$('.speak-btn', el).forEach(b => {
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); haptic(); speak(card.jp, b); });
    });
    return el;
  }

  function flipCard() {
    const s = state.session; if (!s || s.busy) return;
    const inner = $('#card-stage .card-inner'); if (!inner) return;
    s.flipped = !s.flipped;
    inner.classList.toggle('is-flipped', s.flipped);
    haptic(8);
    if (s.flipped) {
      $('#actions-reveal').hidden = true;
      $('#actions-grade').hidden = false;
      if (state.settings.autoSpeak && s.reverse) speak(s.current.jp, inner.querySelector('.card-back .speak-btn'));
    } else {
      $('#actions-reveal').hidden = false;
      $('#actions-grade').hidden = true;
    }
  }

  // Leitner update
  function recordAnswer(card, good) {
    const now = Date.now();
    const r = state.progress.cards[card.key] || { box: 0, due: 0, reps: 0, lapses: 0, last: 0 };
    r.reps++;
    if (good) { r.box = Math.min(r.box + 1, MAX_BOX); r.due = now + INTERVALS[r.box] * DAY; }
    else { r.box = 0; r.lapses++; r.due = now; }
    r.last = now;
    state.progress.cards[card.key] = r;
    touchStreak();
    saveProgress();
  }

  function grade(good, { viaSwipe = false } = {}) {
    const s = state.session; if (!s || s.busy || !s.current) return;
    s.busy = true;
    const card = s.current;
    const el = $('#card-stage .swipe-card');
    recordAnswer(card, good);
    const res = s.results.get(card.key) || { again: 0 };
    if (good) {
      s.done++;
      if (res.again === 0) res.firstTry = true;
    } else {
      res.again++;
      if (!s.missed.some(c => c.key === card.key)) s.missed.push(card);
      // bring the card back a few cards later in this same session
      const at = Math.min(s.queue.length, 2 + Math.floor(Math.random() * 2));
      s.queue.splice(at, 0, card);
    }
    s.results.set(card.key, res);
    haptic(good ? 12 : 20);
    renderProgress();
    flyOff(el, good ? 1 : -1, viaSwipe).then(nextCard);
  }

  function flyOff(el, dir, viaSwipe) {
    if (!el) return Promise.resolve();
    el.classList.add('is-leaving');
    const tint = el.querySelector('.card-tint');
    tint.classList.toggle('bad', dir < 0);
    tint.style.opacity = '0.28';
    el.querySelector(dir > 0 ? '.stamp-good' : '.stamp-again').style.opacity = '1';
    if (reduceMotion()) { el.style.opacity = '0'; return new Promise(r => setTimeout(r, 30)); }
    const w = window.innerWidth;
    const dy = viaSwipe ? (el._dy || 0) : -20;
    el.style.transition = 'transform 420ms cubic-bezier(.2,.7,.3,1), opacity 360ms ease-out';
    requestAnimationFrame(() => {
      el.style.transform = `translate(-50%, -50%) translate(${dir * w * 1.2}px, ${dy}px) rotate(${dir * 28}deg)`;
      el.style.opacity = '0';
    });
    return new Promise(r => setTimeout(r, 300));
  }

  // Tinder-style drag
  function attachSwipe(el) {
    let drag = null;
    const tint = el.querySelector('.card-tint');
    const stampGood = el.querySelector('.stamp-good'), stampBad = el.querySelector('.stamp-again');
    const THRESHOLD = Math.min(120, window.innerWidth * 0.3);

    el.addEventListener('pointerdown', e => {
      if (state.session?.busy || e.button > 0) return;
      drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, t: performance.now(), vx: 0, lastX: e.clientX, lastT: performance.now() };
      el.setPointerCapture(e.pointerId);
      el.style.transition = 'none';
    });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      drag.dx = e.clientX - drag.x0; drag.dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(drag.dx, drag.dy) > 8) drag.moved = true;
      if (!drag.moved) return;
      const now = performance.now();
      drag.vx = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastT); drag.lastX = e.clientX; drag.lastT = now;
      const rot = drag.dx * 0.07;
      el.style.transform = `translate(-50%, -50%) translate(${drag.dx}px, ${drag.dy * 0.35}px) rotate(${rot}deg)`;
      const p = Math.max(-1, Math.min(1, drag.dx / THRESHOLD));
      tint.classList.toggle('bad', p < 0);
      tint.style.opacity = String(Math.abs(p) * 0.26);
      stampGood.style.opacity = String(Math.max(0, p));
      stampBad.style.opacity = String(Math.max(0, -p));
    });
    const end = e => {
      if (!drag) return;
      const d = drag; drag = null;
      try { el.releasePointerCapture(e.pointerId); } catch {}
      if (!d.moved) { flipCard(); return; }
      const fling = Math.abs(d.vx) > 0.6 && Math.sign(d.vx) === Math.sign(d.dx) && Math.abs(d.dx) > 30;
      if (Math.abs(d.dx) > THRESHOLD || fling) {
        el._dy = d.dy * 0.35 + Math.sign(d.dx) * 0;
        grade(d.dx > 0, { viaSwipe: true });
      } else {
        el.style.transition = 'transform 420ms cubic-bezier(.34,1.4,.64,1)';
        el.style.transform = 'translate(-50%, -50%)';
        tint.style.opacity = '0'; stampGood.style.opacity = '0'; stampBad.style.opacity = '0';
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function endSessionEarly() {
    const s = state.session; if (!s) return;
    if (s.done === 0 && s.missed.length === 0) { state.session = null; renderHome(); showScreen('home'); return; }
    finishSession({ early: true });
  }

  // ---------------------------------------------------------------- summary
  function finishSession({ early = false } = {}) {
    const s = state.session; if (!s) return;
    const answered = [...s.results.values()];
    const firstTry = answered.filter(r => r.firstTry).length;
    const againCount = answered.reduce((n, r) => n + r.again, 0);
    const attempted = early ? answered.length : s.total;
    const pct = attempted ? Math.round((firstTry / attempted) * 100) : 0;
    const elapsed = Date.now() - s.startedAt;
    state.progress.sessions = (state.progress.sessions || 0) + 1; saveProgress();

    $('#summary-eyebrow').textContent = early ? 'Session ended' : 'Session complete';
    const [jp, sub] = pct >= 90 ? ['すばらしい', 'Outstanding. That was nearly perfect.']
      : pct >= 75 ? ['よくできました', 'Well done. Solid recall.']
      : pct >= 50 ? ['おつかれさま', 'Good effort. The misses will come back sooner.']
      : ['がんばって', 'Keep at it. Repetition does the work.'];
    $('#summary-jp').textContent = jp;
    $('#summary-sub').textContent = sub;
    $('#score-sub').textContent = `${firstTry} of ${attempted} first try`;
    $('#sum-good').textContent = s.done;
    $('#sum-again').textContent = againCount;
    $('#sum-time').textContent = fmtTime(elapsed);

    const missedBlock = $('#missed-block'), list = $('#missed-list');
    list.innerHTML = '';
    if (s.missed.length) {
      missedBlock.hidden = false;
      s.missed.forEach(c => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="m-jp">${escapeHTML(c.jp)}</span><span class="m-en">${escapeHTML(c.en)}</span>`;
        li.addEventListener('click', () => speak(c.jp));
        list.appendChild(li);
      });
      $('#btn-redo-missed').hidden = false;
      $('#btn-redo-missed').textContent = `Redo ${s.missed.length} missed`;
    } else { missedBlock.hidden = true; $('#btn-redo-missed').hidden = true; }

    const ringFill = $('#score-ring-fill'), pctEl = $('#score-pct');
    ringFill.style.transition = 'none'; ringFill.style.strokeDashoffset = '326.7'; pctEl.textContent = '0';
    showScreen('summary');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ringFill.style.transition = '';
      ringFill.style.strokeDashoffset = String((326.7 * (1 - pct / 100)).toFixed(1));
      countUp(pctEl, pct, reduceMotion() ? 0 : 1200);
    }));
    if (pct >= 75 && !reduceMotion()) setTimeout(() => petals(pct >= 90 ? 90 : 55), 350);
    state.lastSession = { missed: s.missed.slice(), title: s.title };
    state.session = null;
  }

  function countUp(el, target, dur) {
    if (!dur) { el.textContent = target; return; }
    const t0 = performance.now();
    const step = t => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(target * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  // Sakura petals
  let petalRAF = 0;
  function petals(count) {
    const cv = $('#petals'), ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
    const colors = ['#f7c5d0', '#f3a9ba', '#fbd9e0', '#ef8fa6', '#bc002d'];
    const ps = Array.from({ length: count }, () => ({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.6, r: 5 + Math.random() * 6,
      vy: 1.2 + Math.random() * 1.8, vx: -0.6 + Math.random() * 1.2, a: Math.random() * Math.PI * 2, va: (-0.5 + Math.random()) * 0.08,
      sway: Math.random() * Math.PI * 2, c: colors[Math.floor(Math.random() * colors.length)], o: 0.75 + Math.random() * 0.25,
    }));
    const t0 = performance.now();
    cancelAnimationFrame(petalRAF);
    const frame = t => {
      const life = (t - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of ps) {
        p.sway += 0.03; p.x += p.vx + Math.sin(p.sway) * 0.6; p.y += p.vy; p.a += p.va;
        if (p.y < H + 30) alive++;
        const fade = life > 5 ? Math.max(0, 1 - (life - 5) / 1.5) : 1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.globalAlpha = p.o * fade; ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.moveTo(0, -p.r);
        ctx.bezierCurveTo(p.r, -p.r, p.r, p.r * 0.6, 0, p.r);
        ctx.bezierCurveTo(-p.r, p.r * 0.6, -p.r, -p.r, 0, -p.r);
        ctx.fill(); ctx.restore();
      }
      if (alive && life < 6.5 && state.screen === 'summary') petalRAF = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    petalRAF = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    $('#opt-name').value = state.settings.name || '';
    $('#opt-autospeak').checked = !!state.settings.autoSpeak;
    $('#app-version').textContent = `v${APP_VERSION}`;
    applyTheme();
  }

  async function resetProgress() {
    const ok = await confirmSheet({ title: 'Reset all progress?', text: 'This clears every card\'s review history and your streak. Your cards and settings stay. This cannot be undone.', confirmLabel: 'Reset' });
    if (!ok) return;
    state.progress = { cards: {}, streak: { count: 0, lastDay: null }, sessions: 0, lastVersion: state.cardsVersion };
    saveProgress();
    toast('Progress reset');
    renderHome();
  }

  // ---------------------------------------------------------------- service worker
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing; if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready', { action: 'Reload', onAction: () => { nw.postMessage({ type: 'SKIP_WAITING' }); }, duration: 0 });
            }
          });
        });
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) return; refreshing = true; location.reload(); });
      } catch (e) { console.warn('SW registration failed', e); }
    });
  }

  // ---------------------------------------------------------------- wiring
  function bind() {
    $('#btn-settings').addEventListener('click', () => { renderSettings(); showScreen('settings'); });
    $('#btn-settings-back').addEventListener('click', () => { renderHome(); showScreen('home'); });
    $('#btn-study-due').addEventListener('click', () => startSession({ decks: state.decks, title: 'Due cards', dueOnly: true }));
    $('#btn-all-decks').addEventListener('click', () => startSession({ decks: state.decks, title: 'All decks' }));
    $('#btn-mix-study').addEventListener('click', () => {
      const decks = state.decks.filter(d => state.selected.has(d.name));
      startSession({ decks, title: decks.length === 1 ? decks[0].name : `${decks.length} decks` });
    });
    $('#btn-mix-clear').addEventListener('click', () => { state.selected.clear(); renderHome(); });

    $('#opt-reverse').addEventListener('click', () => { state.settings.reverse = !state.settings.reverse; saveSettings(); haptic(); renderHome(); });
    $('#opt-shuffle').addEventListener('click', () => { state.settings.shuffle = !state.settings.shuffle; saveSettings(); haptic(); renderHome(); });
    $$('#opt-size .seg').forEach(b => b.addEventListener('click', () => { state.settings.size = Number(b.dataset.size); saveSettings(); haptic(); renderHome(); }));

    $('#btn-study-close').addEventListener('click', endSessionEarly);
    $('#btn-reveal').addEventListener('click', flipCard);
    $('#btn-again').addEventListener('click', () => grade(false));
    $('#btn-good').addEventListener('click', () => grade(true));
    $('#btn-summary-done').addEventListener('click', () => { renderHome(); showScreen('home'); });
    $('#btn-redo-missed').addEventListener('click', () => {
      const m = state.lastSession?.missed || [];
      if (m.length) startSession({ title: 'Missed cards', cards: m, redo: true });
    });

    $$('#opt-theme .seg').forEach(b => b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; saveSettings(); haptic(); applyTheme(); }));
    $('#opt-name').addEventListener('input', e => { state.settings.name = e.target.value.trim(); saveSettings(); });
    $('#opt-autospeak').addEventListener('change', e => { state.settings.autoSpeak = e.target.checked; saveSettings(); });
    $('#btn-test-voice').addEventListener('click', e => speak('こんにちは、エランさん', e.currentTarget));
    $('#btn-refresh-cards').addEventListener('click', async () => { const ok = await loadCards(); if (ok) renderHome(); });
    $('#btn-reset').addEventListener('click', resetProgress);

    // keyboard support (desktop testing)
    document.addEventListener('keydown', e => {
      if (state.screen !== 'study' || !state.session) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); }
      else if (e.key === 'ArrowRight') grade(true);
      else if (e.key === 'ArrowLeft') grade(false);
      else if (e.key === 'Escape') endSessionEarly();
    });

    document.addEventListener('pointerdown', primeSpeech, { once: true, capture: true });
    // block pinch/double-tap zoom on iOS
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
    // when the app comes back to the foreground, refresh due counts / check for new cards
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && state.screen === 'home') { await loadCards({ silent: true }); renderHome(); }
    });
    window.addEventListener('resize', () => { if (state.screen === 'summary') { /* petals canvas resizes on next run */ } });
  }

  // ---------------------------------------------------------------- init
  async function init() {
    applyTheme();
    bind();
    registerSW();
    await loadCards({ silent: true });
    renderHome();
  }
  init();
})();
