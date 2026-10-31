/* Kotoba — Japanese flashcards. Plain JS, no build step. */
(() => {
  'use strict';

  const APP_VERSION = '2.1.1';
  const KEY_PROGRESS = 'kotoba.progress.v1';
  const KEY_SETTINGS = 'kotoba.settings.v1';
  const SEP = '\u001f';                       // deck name + SEP + jp text = progress key
  const INTERVALS = [0, 1, 3, 7, 14, 30, 60]; // Leitner box -> days until the card is due again
  const MASTERED_BOX = 4;                     // box 4 (14-day interval) counts as mastered
  const MAX_BOX = INTERVALS.length - 1;
  const DAY = 86400000;
  const KANA = window.KANA_DATA || { tiers: [] };
  const ROW_PASS = 80;   // % needed in a row drill to mark the row learned
  const TIER_PASS = 90;  // % needed in the tier test to unlock the next tier

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
  const QUIZ_DEFAULTS = { source: 'decks', decks: [], mode: 'mc', direction: 'both', count: 10, answer: 'en' };

  const state = {
    decks: [],            // [{ name, cards: [{ deck, jp, romaji, sounds, en, key }] }]
    lessons: [], grammar: { entries: [], groups: [], further: [] },
    lesson: null, build: null, speak: null, rp: null,
    cardsVersion: null,
    progress: loadJSON(KEY_PROGRESS, { cards: {}, streak: { count: 0, lastDay: null }, sessions: 0, lastVersion: null, kana: { rows: {}, tiers: {} }, lessons: {}, plan: { day: null, done: {} } }),
    settings: loadJSON(KEY_SETTINGS, { theme: 'auto', reverse: false, shuffle: false, size: 20, name: 'Elan', autoSpeak: false, romajiHelp: true, quiz: { ...QUIZ_DEFAULTS } }),
    selected: new Set(),
    session: null, quiz: null, learn: null, lastResult: null,
    screen: 'home', tab: 'home', kanaTier: null,
  };
  state.progress.kana = { rows: {}, tiers: {}, ...(state.progress.kana || {}) };
  state.progress.lessons = state.progress.lessons || {};
  state.progress.plan = { day: null, done: {}, ...(state.progress.plan || {}) };
  state.settings.quiz = { ...QUIZ_DEFAULTS, ...(state.settings.quiz || {}) };
  if (state.settings.romajiHelp === undefined) state.settings.romajiHelp = true;
  const saveProgress = () => saveJSON(KEY_PROGRESS, state.progress);
  const saveSettings = () => saveJSON(KEY_SETTINGS, state.settings);

  // ---------------------------------------------------------------- helpers
  const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const yesterdayKey = () => todayKey(new Date(Date.now() - DAY));
  const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };

  function cardRecord(card) { return state.progress.cards[card.key]; }
  function isDue(card) { const r = cardRecord(card); return !r || r.due <= endOfToday(); }
  function isNew(card) { const r = cardRecord(card); return !r || r.reps === 0; }   // not yet answered
  function isUnseen(card) { return !cardRecord(card); }                               // never shown at all
  function markSeen(card) { if (!cardRecord(card)) state.progress.cards[card.key] = { box: 0, due: Date.now(), reps: 0, lapses: 0, last: Date.now(), seen: 1 }; }
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
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  function fmtTime(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function haptic(ms = 10) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } }
  function jpLen(text) { return [...text.replace(/[\s。、！？]/g, '')].length; }
  function jpSizeClass(text) {
    const n = jpLen(text);
    if (n <= 2) return 'size-xl';
    if (n <= 5) return 'size-l';
    if (n <= 9) return 'size-m';
    if (n <= 15) return 'size-s';
    return 'size-xs';
  }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const SPEAK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const LOCK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  // ---------------------------------------------------------------- romaji helper (kana → romaji, Hepburn, matching the lesson sheets)
  const KANA_MAP = { あ:'a', い:'i', う:'u', え:'e', お:'o', か:'ka', き:'ki', く:'ku', け:'ke', こ:'ko', さ:'sa', し:'shi', す:'su', せ:'se', そ:'so', た:'ta', ち:'chi', つ:'tsu', て:'te', と:'to', な:'na', に:'ni', ぬ:'nu', ね:'ne', の:'no', は:'ha', ひ:'hi', ふ:'fu', へ:'he', ほ:'ho', ま:'ma', み:'mi', む:'mu', め:'me', も:'mo', や:'ya', ゆ:'yu', よ:'yo', ら:'ra', り:'ri', る:'ru', れ:'re', ろ:'ro', わ:'wa', を:'o', ん:'n', が:'ga', ぎ:'gi', ぐ:'gu', げ:'ge', ご:'go', ざ:'za', じ:'ji', ず:'zu', ぜ:'ze', ぞ:'zo', だ:'da', ぢ:'ji', づ:'zu', で:'de', ど:'do', ば:'ba', び:'bi', ぶ:'bu', べ:'be', ぼ:'bo', ぱ:'pa', ぴ:'pi', ぷ:'pu', ぺ:'pe', ぽ:'po', ぁ:'a', ぃ:'i', ぅ:'u', ぇ:'e', ぉ:'o', ゔ:'vu' };
  const SMALL_Y = { ゃ:'ya', ゅ:'yu', ょ:'yo' };
  const PUNCT = { '。': '.', '、': ',', '？': '?', '！': '!', '「': '"', '」': '"', '・': ' · ' };
  // word spacing the way the lesson sheets write romaji: before です/ます-type endings and end-of-word particles
  const SPLIT_BEFORE = ['じゃないです', 'じゃない', 'でしたか', 'ですか', 'でした', 'です', 'ございます', 'ください', 'します', 'しました'];
  const NO_SPLIT = /^(こんにちは|こんばんは)[、。！？]*$/;
  function spaceKana(s) {
    if (NO_SPLIT.test(s.trim())) return s;
    let out = s;
    for (const w of SPLIT_BEFORE) out = out.replace(new RegExp(`([ぁ-ゖァ-ヺー○▲])(${w})`, 'g'), '$1 $2');
    out = out.replace(/([ぁ-ゖァ-ヺー○▲])([はがをへ])(?=[\s、。！？」]|$)/g, (m, a, p) => (p === 'が' && /えい$/.test(m.slice(0, -1)) ? m : `${a} ${p}`));
    out = out.replace(/([ぁ-ゖァ-ヺー○▲])(に)(?=[\s、。！？」]|$)/g, (m, a) => (a === 'な' ? m : `${a} に`));
    out = out.replace(/(です|ます|でした|ました)か/g, '$1 か');
    out = out.replace(/、/g, '、 ');
    return out;
  }
  function romanize(text) {
    const s = spaceKana(text).replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    const chars = [...s]; let out = '', lastVowel = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i], next = chars[i + 1];
      const endOfWord = !next || /[\s、。！？」]/.test(next);
      if (ch === 'っ') { const nr = next && KANA_MAP[next]; if (nr) out += nr.startsWith('ch') ? 't' : nr[0]; continue; }
      if (ch === 'ー') { out += lastVowel; continue; }
      if (ch === 'は' && endOfWord && out.trim()) { out += 'wa'; lastVowel = 'a'; continue; }
      if (ch === 'へ' && endOfWord && out.trim()) { out += 'e'; lastVowel = 'e'; continue; }
      let r = KANA_MAP[ch];
      if (r !== undefined) {
        if (next && SMALL_Y[next]) { const base = r.slice(0, -1); r = base + (['sh', 'ch', 'j'].includes(base) ? SMALL_Y[next].slice(1) : SMALL_Y[next]); i++; }
        if (/[○▲]$/.test(out)) out += ' ';
        out += r; lastVowel = r.slice(-1); continue;
      }
      if (PUNCT[ch]) { out += PUNCT[ch]; continue; }
      out += ch;
    }
    return out.replace(/\s+/g, ' ').replace(/\s+([.,?!])/g, '$1').trim();
  }
  const KANA_RUN = /[ぁ-ゖァ-ヺー・○▲「」]+(?:[ 　]+[ぁ-ゖァ-ヺー・○▲「」]+)*[、。！？]*/g;
  const NO_ANNOTATE = '.jp, .ro-inline, .card-jp, .pv-jp, .g-ex, .g-word, .rp-jp, .sp-jp, .b-sentence, .b-tile, .q-opt, .m-tile, .g-pattern, .g-pattern-ro, .kana-tile, .learn-kana, .kana-sheet-char, .m-jp, .card-hinted, .lesson-name, .ref-row-title, .tab';
  // Adds "(romaji)" after every run of kana inside explanatory text, so the guide is readable before you can read kana.
  function annotateKana(root) {
    if (!root || !state.settings.romajiHelp) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      if (node.parentElement.closest(NO_ANNOTATE)) continue;
      const text = node.nodeValue; if (!/[ぁ-ゖァ-ヺ]/.test(text)) continue;
      const frag = document.createDocumentFragment(); let last = 0;
      text.replace(KANA_RUN, (m, off) => {
        if (!/[ぁ-ゖァ-ヺ]/.test(m)) return m;
        frag.append(text.slice(last, off), m);
        const sp = document.createElement('span'); sp.className = 'ro-inline'; sp.textContent = `(${romanize(m)})`;
        frag.append(sp); last = off + m.length; return m;
      });
      frag.append(text.slice(last)); node.replaceWith(frag);
    }
    // rule patterns get a romaji line underneath instead of inline brackets
    $$('.g-pattern', root).forEach(p => { if (p.nextElementSibling?.classList.contains('g-pattern-ro')) return; const ro = document.createElement('div'); ro.className = 'g-pattern-ro'; ro.textContent = romanize(p.textContent); p.after(ro); });
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
    const pickV = pickVoice();
    $('#voice-name').textContent = pickV ? `Voice: ${pickV.name}` : 'No Japanese voice found on this device';
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
    u.lang = 'ja-JP'; u.rate = jpLen(clean) <= 2 ? 0.8 : 0.9; u.pitch = 1; u.volume = 1;
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

  // ---------------------------------------------------------------- screens & tabs
  const TAB_SCREENS = ['home', 'review', 'kana', 'quiz', 'lesson', 'guide', 'ref', 'refentry'];
  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
    $('#tabbar').hidden = !TAB_SCREENS.includes(name);
    const active = $(`.screen[data-screen="${name}"]`);
    if (active && !['study', 'learn', 'quizrun', 'build', 'speak', 'roleplay', 'preview'].includes(name)) { const sc = active.querySelector('.home-wrap, .page-wrap, .settings-wrap, .summary-wrap'); if (sc) sc.scrollTop = 0; }
  }
  function showTab(name) {
    state.tab = name;
    $$('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.tab === name));
    if (name === 'home') renderHome();
    if (name === 'review') renderReview();
    if (name === 'kana') renderKana();
    if (name === 'quiz') renderQuizSetup();
    showScreen(name);
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
    for (const name of [...state.selected]) if (!decks.some(d => d.name === name)) state.selected.delete(name);
    state.settings.quiz.decks = state.settings.quiz.decks.filter(n => decks.some(d => d.name === n));
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

  // ---------------------------------------------------------------- kana model
  const tierById = id => KANA.tiers.find(t => t.id === id);
  const rowKey = (t, i) => `${t.id}:${i}`;
  const rowLearned = (t, i) => !!state.progress.kana.rows[rowKey(t, i)];
  const tierPassed = t => !!state.progress.kana.tiers[t.id]?.passed;
  const tierUnlocked = t => !t.requires || tierPassed(tierById(t.requires));
  const tierTotal = t => t.rows.reduce((n, r) => n + r.kana.length, 0);
  const tierLearned = t => t.rows.reduce((n, r, i) => n + (rowLearned(t, i) ? r.kana.length : 0), 0);
  const nextRowIndex = t => t.rows.findIndex((r, i) => !rowLearned(t, i));
  const totalKanaLearned = () => KANA.tiers.reduce((n, t) => n + tierLearned(t), 0);
  const totalKana = () => KANA.tiers.reduce((n, t) => n + tierTotal(t), 0);
  function kanaItem(k, tier, row) {
    return { id: `k:${k[0]}`, kind: 'kana', jp: k[0], en: k[1], meaning: k[1], romaji: k[1], sounds: k[2], note: k[3] || '', group: row.name, tier: tier.id };
  }
  function cardItem(c) {
    const useRomaji = state.settings.quiz.answer === 'romaji' && c.romaji;
    return { id: `c:${c.key}`, kind: 'card', jp: c.jp, en: useRomaji ? c.romaji : c.en, meaning: c.en, romaji: c.romaji, sounds: c.sounds, group: c.deck, card: c };
  }
  const tierItems = t => t.rows.flatMap(r => r.kana.map(k => kanaItem(k, t, r)));
  function learnedKanaItems(onlyTier = null) {
    const out = [];
    for (const t of KANA.tiers) {
      if (onlyTier && t.id !== onlyTier.id) continue;
      t.rows.forEach((r, i) => { if (rowLearned(t, i)) r.kana.forEach(k => out.push(kanaItem(k, t, r))); });
    }
    return out;
  }
  function defaultKanaTier() {
    const unlocked = KANA.tiers.filter(tierUnlocked);
    return unlocked.find(t => nextRowIndex(t) >= 0 || !tierPassed(t)) || unlocked[unlocked.length - 1] || KANA.tiers[0];
  }
  function kanaStatusLine() {
    const basic = KANA.tiers[0]; if (!basic) return '';
    const t = defaultKanaTier();
    const learned = tierLearned(t), total = tierTotal(t), nr = nextRowIndex(t);
    if (nr >= 0) return `${learned} of ${total} ${t.name} learned · next: ${t.rows[nr].name}`;
    if (!tierPassed(t)) return `All ${total} learned · take the ${t.name} test`;
    return `${t.name} mastered · ${totalKanaLearned()} of ${totalKana()} kana`;
  }

  // ---------------------------------------------------------------- home
  function renderReview() {
    const all = state.decks.flatMap(d => d.cards);
    const due = all.filter(isDue).length;
    const newCount = all.filter(isNew).length;
    const unseen = all.filter(isUnseen).length;
    $('#btn-meet-new').hidden = unseen === 0;
    $('#meet-sub').textContent = `${unseen} new · see everything first, then test`;
    $('#hero-count').textContent = due;
    $('#hero-sub').textContent = all.length === 0 ? 'No cards yet'
      : due === 0 ? 'All caught up · review anyway'
      : newCount === due ? `${due} new cards waiting` : `${due - newCount} to review · ${newCount} new`;
    $('.hero-title').textContent = due === 0 && all.length ? 'Review all cards' : 'Study due cards';

    $('#opt-reverse').setAttribute('aria-pressed', String(!!state.settings.reverse));
    $('#opt-shuffle').setAttribute('aria-pressed', String(!!state.settings.shuffle));
    $$('#opt-size .seg').forEach(b => b.classList.toggle('is-on', Number(b.dataset.size) === Number(state.settings.size)));

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
        <button class="deck-check" aria-label="Select deck"><span>${CHECK_SVG}</span></button>`;
      el.querySelector('.deck-check').addEventListener('click', e => {
        e.stopPropagation(); haptic();
        if (state.selected.has(deck.name)) state.selected.delete(deck.name); else state.selected.add(deck.name);
        el.classList.toggle('is-selected', state.selected.has(deck.name));
        renderMixBar();
      });
      el.addEventListener('click', () => startSession({ decks: [deck], title: deck.name }));
      list.appendChild(el);
    });
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

  // ---------------------------------------------------------------- flashcard session
  function startSession({ decks, title, dueOnly = false, cards = null, redo = false, limit = null, returnTo = null, onDone = null }) {
    let pool = cards || decks.flatMap(d => d.cards);
    if (!pool.length) { toast('This deck has no cards'); return; }
    let label = title;
    if (dueOnly) {
      const due = pool.filter(isDue);
      if (due.length) pool = due;
      else { label = 'Review'; toast('Nothing due — reviewing everything'); }
    }
    if (state.settings.shuffle || dueOnly) pool = shuffle(pool);
    if (!state.settings.shuffle && !dueOnly) pool = pool.slice().sort((a, b) => Number(isDue(b)) - Number(isDue(a)));
    if (dueOnly) pool.sort((a, b) => Number(isNew(a)) - Number(isNew(b)));
    const size = limit != null ? limit : Number(state.settings.size);
    if (size > 0 && !redo) pool = pool.slice(0, size);

    state.session = {
      title: label, queue: pool.slice(), total: pool.length, done: 0,
      results: new Map(), missed: [], startedAt: Date.now(), current: null, flipped: false, busy: false,
      reverse: !!state.settings.reverse,
      multiDeck: new Set(pool.map(c => c.deck)).size > 1,
      returnTo, onDone,
    };
    $('#study-title').textContent = label;
    showScreen('study');
    renderProgress();
    nextCard();
  }

  function renderProgress() {
    const s = state.session; if (!s) return;
    $('#study-progress').style.width = `${(s.done / s.total) * 100}%`;
    $('#study-counter').textContent = `${s.total - s.done} left`;
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
    $('.card-ghost-1').classList.toggle('is-hidden', s.queue.length < 1);
    $('.card-ghost-2').classList.toggle('is-hidden', s.queue.length < 2);
    if (state.settings.autoSpeak && !s.reverse) setTimeout(() => speak(s.current.jp, el.querySelector('.card-front .speak-btn')), 250);
  }

  function buildCard(card, reverse) {
    const el = document.createElement('div');
    el.className = 'swipe-card';
    const multiDeck = state.session ? state.session.multiDeck : true;
    const speakBtn = `<button class="speak-btn" aria-label="Read aloud">${SPEAK_SVG}</button>`;
    const fresh = isNew(card);
    const top = `<div class="card-top"><span class="card-deck">${multiDeck ? escapeHTML(card.deck) : ''}${fresh ? `${multiDeck ? ' · ' : ''}<span class="card-learning">Learning</span>` : ''}</span>${speakBtn}</div>`;
    const jpFront = `<div class="card-jp ${jpSizeClass(card.jp)}">${escapeHTML(card.jp)}</div>${fresh ? `<button class="card-hintbtn" type="button">Hint</button><div class="card-hinted" hidden>${escapeHTML(card.romaji)}${card.sounds ? ` · <span class="s">“${escapeHTML(card.sounds)}”</span>` : ''}</div>` : ''}`;
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
    const hb = el.querySelector('.card-hintbtn');
    if (hb) { hb.addEventListener('pointerdown', e => e.stopPropagation()); hb.addEventListener('click', e => { e.stopPropagation(); hb.remove(); el.querySelector('.card-hinted').hidden = false; speak(card.jp); }); }
    return el;
  }

  function flipCard() {
    const s = state.session; if (!s || s.busy) return;
    const inner = $('#card-stage .card-inner'); if (!inner) return;
    s.flipped = !s.flipped;
    inner.classList.toggle('is-flipped', s.flipped);
    haptic(8);
    $('#actions-reveal').hidden = s.flipped;
    $('#actions-grade').hidden = !s.flipped;
    if (s.flipped && state.settings.autoSpeak && s.reverse) speak(s.current.jp, inner.querySelector('.card-back .speak-btn'));
  }

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
  function markDueNow(card) {
    const r = state.progress.cards[card.key] || { box: 0, due: 0, reps: 0, lapses: 0, last: 0 };
    r.box = 0; r.due = Date.now(); r.lapses++;
    state.progress.cards[card.key] = r;
  }

  function grade(good, { viaSwipe = false } = {}) {
    const s = state.session; if (!s || s.busy || !s.current) return;
    s.busy = true;
    const card = s.current;
    const el = $('#card-stage .swipe-card');
    const res = s.results.get(card.key) || { again: 0 };
    if (good && isNew(card) && !res.passOnce && s.queue.length) {
      // first-ever correct answer: come back once more later in this session before it graduates
      res.passOnce = true; s.results.set(card.key, res);
      s.queue.splice(Math.min(s.queue.length, 4), 0, card);
      haptic(12); renderProgress();
      flyOff(el, 1, viaSwipe).then(nextCard);
      return;
    }
    recordAnswer(card, good);
    if (good) {
      s.done++;
      if (res.again === 0) res.firstTry = true;
    } else {
      res.again++;
      if (!s.missed.some(c => c.key === card.key)) s.missed.push(card);
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

  function attachSwipe(el) {
    let drag = null;
    const tint = el.querySelector('.card-tint');
    const stampGood = el.querySelector('.stamp-good'), stampBad = el.querySelector('.stamp-again');
    const THRESHOLD = Math.min(120, window.innerWidth * 0.3);

    el.addEventListener('pointerdown', e => {
      if (state.session?.busy || e.button > 0) return;
      drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false, vx: 0, lastX: e.clientX, lastT: performance.now() };
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
      el.style.transform = `translate(-50%, -50%) translate(${drag.dx}px, ${drag.dy * 0.35}px) rotate(${drag.dx * 0.07}deg)`;
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
        el._dy = d.dy * 0.35;
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
    if (s.done === 0 && s.missed.length === 0) { state.session = null; showTab(s.returnTo || 'review'); return; }
    finishSession({ early: true });
  }

  function finishSession({ early = false } = {}) {
    const s = state.session; if (!s) return;
    const answered = [...s.results.values()];
    const firstTry = answered.filter(r => r.firstTry).length;
    const againCount = answered.reduce((n, r) => n + r.again, 0);
    const attempted = early ? answered.length : s.total;
    const pct = attempted ? Math.round((firstTry / attempted) * 100) : 0;
    state.progress.sessions = (state.progress.sessions || 0) + 1; saveProgress();
    const missed = s.missed.slice();
    state.session = null;
    showResults({
      eyebrow: early ? 'Session ended' : 'Session complete', pct,
      scoreSub: `${firstTry} of ${attempted} first try`,
      good: s.done, again: againCount, goodLabel: 'Got it', againLabel: 'Again',
      elapsed: Date.now() - s.startedAt, missed, returnTo: s.returnTo || 'review',
      redo: missed.length ? () => startSession({ title: 'Missed cards', cards: missed, redo: true, returnTo: s.returnTo }) : null,
      onDone: s.onDone,
    });
  }

  // ---------------------------------------------------------------- results screen (shared)
  function showResults(r) {
    state.lastResult = r;
    if (r.onDone) { try { r.onDone(r); } catch (e) { console.warn(e); } }
    $('#summary-eyebrow').textContent = r.eyebrow;
    const [jp, sub] = r.pct >= 90 ? ['すばらしい', 'Outstanding. That was nearly perfect.']
      : r.pct >= 75 ? ['よくできました', 'Well done. Solid recall.']
      : r.pct >= 50 ? ['おつかれさま', 'Good effort. The misses will come back sooner.']
      : ['がんばって', 'Keep at it. Repetition does the work.'];
    $('#summary-jp').textContent = jp;
    $('#summary-sub').textContent = r.subOverride || sub; annotateKana($('#summary-sub'));
    $('#score-sub').textContent = r.scoreSub;
    $('#sum-good').textContent = r.good; $('#sum-good-label').textContent = r.goodLabel;
    $('#sum-again').textContent = r.again; $('#sum-again-label').textContent = r.againLabel;
    $('#sum-time').textContent = fmtTime(r.elapsed);

    const missedBlock = $('#missed-block'), list = $('#missed-list');
    list.innerHTML = '';
    if (r.missed.length) {
      missedBlock.hidden = false;
      r.missed.forEach(c => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="m-jp">${escapeHTML(c.jp)}</span><span class="m-en">${escapeHTML(c.kind === 'kana' ? `${c.romaji} · “${c.sounds}”` : c.romaji && c.en !== c.meaning ? `${c.romaji} · ${c.meaning}` : c.en)}</span>`;
        li.addEventListener('click', () => speak(c.jp));
        list.appendChild(li);
      });
    } else missedBlock.hidden = true;
    const redoBtn = $('#btn-redo-missed');
    redoBtn.hidden = !r.redo;
    if (r.redo) redoBtn.textContent = `Redo ${r.missed.length} missed`;

    const ringFill = $('#score-ring-fill'), pctEl = $('#score-pct');
    ringFill.style.transition = 'none'; ringFill.style.strokeDashoffset = '326.7'; pctEl.textContent = '0';
    showScreen('summary');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ringFill.style.transition = '';
      ringFill.style.strokeDashoffset = String((326.7 * (1 - r.pct / 100)).toFixed(1));
      countUp(pctEl, r.pct, reduceMotion() ? 0 : 1200);
    }));
    if (r.pct >= 75 && !reduceMotion()) setTimeout(() => petals(r.pct >= 90 ? 90 : 55), 350);
  }

  function countUp(el, target, dur) {
    if (!dur) { el.textContent = target; return; }
    const t0 = performance.now();
    const step = t => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(target * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

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

  // ---------------------------------------------------------------- kana screen
  function renderKana() {
    if (!KANA.tiers.length) return;
    if (!state.kanaTier || !tierById(state.kanaTier)) state.kanaTier = defaultKanaTier().id;
    const tier = tierById(state.kanaTier);
    const learned = tierLearned(tier), total = tierTotal(tier), nr = nextRowIndex(tier);

    $('#kana-sub').textContent = `${totalKanaLearned()} of ${totalKana()} kana learned`;
    $('#kana-badge').textContent = nr >= 0 ? tier.rows[nr].kana[0][0] : tier.rows[0].kana[0][0];

    const chips = $('#tier-chips'); chips.innerHTML = '';
    KANA.tiers.forEach(t => {
      const unlocked = tierUnlocked(t);
      const b = document.createElement('button');
      b.className = 'tier-chip' + (t.id === tier.id ? ' is-on' : '') + (unlocked ? '' : ' is-locked');
      b.innerHTML = `${unlocked ? (tierPassed(t) ? CHECK_SVG : '') : LOCK_SVG}<span>${t.name}</span><span class="tc-count">${tierLearned(t)}/${tierTotal(t)}</span>`;
      b.addEventListener('click', () => {
        if (!unlocked) { toast(`Pass the ${tierById(t.requires).name} test to unlock ${t.name}`); return; }
        state.kanaTier = t.id; haptic(); renderKana();
      });
      chips.appendChild(b);
    });
    $('#tier-desc').textContent = `${tier.jp} · ${tier.desc}`;
    $('#kana-progress').style.width = `${(learned / total) * 100}%`;
    $('#kana-counter').textContent = `${learned}/${total}`;

    const cont = $('#btn-kana-continue');
    if (nr >= 0) { cont.textContent = `Learn ${tier.rows[nr].name}`; cont.onclick = () => startLearnRow(tier, nr); }
    else if (!tierPassed(tier)) { cont.textContent = `Take the ${total}-kana test`; cont.onclick = () => startTierTest(tier); }
    else { cont.textContent = 'Retake test'; cont.onclick = () => startTierTest(tier); }
    $('#btn-kana-practice').disabled = learnedKanaItems().length === 0;

    const rows = $('#kana-rows'); rows.innerHTML = '';
    tier.rows.forEach((row, i) => {
      const done = rowLearned(tier, i), current = i === nr, locked = !done && !current;
      const el = document.createElement('div');
      el.className = 'kana-row' + (current ? ' is-current' : '') + (locked ? ' is-locked' : '');
      el.style.setProperty('--i', i);
      const status = done ? `<span class="kana-row-status learned">${CHECK_SVG} Learned</span>`
        : current ? `<span class="kana-row-status">Up next</span>`
        : `<span class="kana-row-status">${LOCK_SVG}</span>`;
      const action = done ? `<button class="pill pill-ghost" data-act="review">Review</button>`
        : current ? `<button class="pill pill-accent" data-act="learn">Learn</button>` : '';
      el.innerHTML = `
        <div class="kana-row-head">
          <div class="kana-row-name"><span class="jp">${escapeHTML(row.kana.map(k => k[0]).join(''))}</span>${status}</div>
          ${action}
        </div>
        <div class="kana-tiles">${row.kana.map(k => `<button class="kana-tile ${done ? 'is-learned' : ''} ${locked ? 'is-locked' : ''} ${k[0].length > 1 ? 'wide' : ''}" data-k="${escapeHTML(k[0])}">${escapeHTML(k[0])}${locked ? '' : `<small>${escapeHTML(k[1])}</small>`}</button>`).join('')}</div>`;
      el.querySelector('[data-act]')?.addEventListener('click', () => startLearnRow(tier, i));
      $$('.kana-tile', el).forEach(t => t.addEventListener('click', () => {
        const k = row.kana.find(x => x[0] === t.dataset.k);
        if (k) openKanaSheet(k);
      }));
      rows.appendChild(el);
    });
  }

  function openKanaSheet(k) {
    $('#ks-char').textContent = k[0];
    $('#ks-romaji').textContent = k[1];
    $('#ks-sounds').textContent = `“${k[2]}”`;
    $('#ks-note').textContent = k[3] || ''; annotateKana($('#ks-note'));
    $('#kana-modal').hidden = false;
    haptic();
    speak(k[0], $('#ks-speak'));
    $('#ks-speak').onclick = () => speak(k[0], $('#ks-speak'));
    const close = () => { $('#kana-modal').hidden = true; };
    $('#ks-close').onclick = close; $('#kana-modal-backdrop').onclick = close;
  }

  // ---------------------------------------------------------------- learn a row
  function startLearnRow(tier, idx) {
    const row = tier.rows[idx];
    state.learn = { tier, idx, row, step: 0, review: rowLearned(tier, idx) };
    $('#learn-title').textContent = `${row.name} · ${tier.name}`;
    showScreen('learn');
    renderLearnStep();
  }
  function renderLearnStep() {
    const L = state.learn; if (!L) return;
    const n = L.row.kana.length, k = L.row.kana[L.step];
    $('#learn-progress').style.width = `${((L.step + 1) / n) * 100}%`;
    $('#learn-counter').textContent = `${L.step + 1} / ${n}`;
    const stage = $('#learn-stage'); stage.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'learn-card';
    el.innerHTML = `
      <div class="card-top"><span class="card-deck">${escapeHTML(L.row.name)}</span><button class="speak-btn" aria-label="Read aloud">${SPEAK_SVG}</button></div>
      <div class="card-main">
        <div class="learn-kana ${k[0].length > 1 ? 'wide' : ''}">${escapeHTML(k[0])}</div>
        <div class="learn-romaji">${escapeHTML(k[1])}</div>
        <div class="learn-sounds">“${escapeHTML(k[2])}”</div>
        ${k[3] ? `<div class="learn-note">${escapeHTML(k[3])}</div>` : ''}
      </div>
      <div class="learn-dots">${L.row.kana.map((_, i) => `<span class="${i === L.step ? 'is-on' : i < L.step ? 'is-done' : ''}"></span>`).join('')}</div>`;
    const sb = el.querySelector('.speak-btn');
    sb.addEventListener('click', () => { haptic(); speak(k[0], sb); });
    el.addEventListener('click', e => { if (e.target.closest('.speak-btn')) return; speak(k[0], sb); });
    stage.appendChild(el);
    speak(k[0], sb);
    const last = L.step === n - 1;
    $('#btn-learn-next').textContent = last ? (L.review ? 'Done' : 'Start drill') : 'Next';
  }
  function learnNext() {
    const L = state.learn; if (!L) return;
    haptic();
    if (L.step < L.row.kana.length - 1) { L.step++; renderLearnStep(); return; }
    if (L.review) { state.learn = null; showTab('kana'); return; }
    startRowDrill(L.tier, L.idx);
    state.learn = null;
  }

  function startRowDrill(tier, idx) {
    const row = tier.rows[idx];
    const rowItems = row.kana.map(k => kanaItem(k, tier, row));
    const learned = learnedKanaItems(tier).filter(it => !rowItems.some(r => r.id === it.id));
    let qs = [...rowItems, ...rowItems];
    if (qs.length < 10 && learned.length) qs.push(...shuffle(learned).slice(0, 10 - qs.length));
    let pool = [...rowItems, ...learned];
    if (pool.length < 4) pool = pool.concat(tierItems(tier).filter(it => !pool.some(p => p.id === it.id)).slice(0, 4 - pool.length));
    startQuiz({
      title: `${row.name} drill`, mode: 'mixed', direction: 'both', items: shuffle(qs), pool, returnTo: 'kana',
      eyebrow: 'Drill complete',
      onDone: res => {
        if (res.pct >= ROW_PASS) {
          state.progress.kana.rows[rowKey(tier, idx)] = { at: Date.now(), pct: res.pct }; saveProgress();
          const nr = nextRowIndex(tier);
          res.subOverride = nr >= 0 ? `${row.name} learned. ${tier.rows[nr].name} is unlocked.` : `${row.name} learned. All ${tierTotal(tier)} learned — take the test!`;
        } else {
          res.subOverride = `Score ${ROW_PASS}% or more to learn this row. Review it and try again.`;
        }
      },
    });
  }

  function startTierTest(tier) {
    const items = shuffle(tierItems(tier));
    startQuiz({
      title: `${tier.name} test`, mode: 'mixed', direction: 'both', items, pool: items, returnTo: 'kana',
      eyebrow: 'Test complete',
      onDone: res => {
        const rec = state.progress.kana.tiers[tier.id] || { passed: false, best: 0 };
        rec.best = Math.max(rec.best || 0, res.pct);
        if (res.pct >= TIER_PASS) {
          rec.passed = true;
          const next = KANA.tiers.find(t => t.requires === tier.id);
          res.subOverride = next ? `${tier.name} mastered! ${next.name} is unlocked.` : `${tier.name} mastered! That's every hiragana.`;
        } else res.subOverride = `Score ${TIER_PASS}% or more to pass. Review the rows you missed.`;
        state.progress.kana.tiers[tier.id] = rec; saveProgress();
      },
    });
  }

  // ---------------------------------------------------------------- quiz setup
  function quizItems() {
    const q = state.settings.quiz;
    if (q.source === 'kana') return learnedKanaItems();
    const decks = q.decks.length ? state.decks.filter(d => q.decks.includes(d.name)) : state.decks;
    return decks.flatMap(d => d.cards.map(cardItem));
  }
  function renderQuizSetup() {
    const q = state.settings.quiz;
    $('#src-decks').setAttribute('aria-pressed', String(q.source === 'decks'));
    $('#src-kana').setAttribute('aria-pressed', String(q.source === 'kana'));
    const chips = $('#quiz-deck-chips'); chips.innerHTML = '';
    if (q.source === 'decks') {
      const all = document.createElement('button');
      all.className = 'deck-chip' + (q.decks.length === 0 ? ' is-on' : ''); all.textContent = 'All decks';
      all.addEventListener('click', () => { q.decks = []; saveSettings(); haptic(); renderQuizSetup(); });
      chips.appendChild(all);
      state.decks.forEach(d => {
        const b = document.createElement('button');
        b.className = 'deck-chip' + (q.decks.includes(d.name) ? ' is-on' : ''); b.textContent = d.name;
        b.addEventListener('click', () => {
          q.decks = q.decks.includes(d.name) ? q.decks.filter(n => n !== d.name) : [...q.decks, d.name];
          saveSettings(); haptic(); renderQuizSetup();
        });
        chips.appendChild(b);
      });
    }
    const items = quizItems();
    $('#quiz-source-hint').textContent = q.source === 'kana'
      ? (items.length ? `${items.length} learned kana` : 'Learn a hiragana row first, then quiz it here.')
      : `${items.length} cards`;
    $$('#mode-grid .mode-card').forEach(b => b.classList.toggle('is-on', b.dataset.mode === q.mode));
    $('#quiz-dir-row').hidden = q.mode === 'match' || q.mode === 'listen';
    $('#quiz-answer-row').hidden = q.source !== 'decks' || q.mode === 'listen';
    $$('#quiz-answer .seg').forEach(b => b.classList.toggle('is-on', b.dataset.answer === (q.answer || 'en')));
    $$('#quiz-dir .seg').forEach(b => b.classList.toggle('is-on', b.dataset.dir === q.direction));
    $$('#quiz-count .seg').forEach(b => b.classList.toggle('is-on', Number(b.dataset.count) === Number(q.count)));
    $('#btn-quiz-start').disabled = items.length === 0;
    const names = { mc: 'multiple choice', listen: 'listening quiz', match: 'match game', mixed: 'mixed test' };
    $('#btn-quiz-start').textContent = items.length ? `Start ${names[q.mode]}` : 'Nothing to quiz yet';
  }
  function startQuizFromSetup() {
    const q = state.settings.quiz;
    let items = quizItems(); if (!items.length) return;
    if (q.mode === 'match') { const seen = new Set(); items = items.filter(it => seen.has(it.jp + '|' + it.en) ? false : (seen.add(it.jp + '|' + it.en), true)); }
    const pool = items;
    items = shuffle(items);
    if (Number(q.count) > 0) items = items.slice(0, Number(q.count));
    const names = { mc: 'Multiple choice', listen: 'Listening', match: 'Match', mixed: 'Mixed test' };
    startQuiz({ title: names[q.mode], mode: q.mode, direction: q.direction, items, pool, returnTo: 'quiz', eyebrow: 'Quiz complete' });
  }

  // ---------------------------------------------------------------- quiz engine
  function startQuiz({ title, mode, direction, items, pool, returnTo, onDone, eyebrow, groups = null, custom = null }) {
    if (state.quiz?.timer) clearInterval(state.quiz.timer);
    state.quiz = { title, mode, direction, items, pool: pool || items, index: 0, results: new Map(), startedAt: Date.now(), busy: false, returnTo, onDone, eyebrow, matchPos: 0, matchMistakes: 0, matchDone: 0, timer: null, groups, custom };
    $('#quiz-title').textContent = title;
    showScreen('quizrun');
    if (mode === 'match') state.quiz.timer = setInterval(updateQuizHeader, 1000);
    nextQuestion();
  }
  function updateQuizHeader() {
    const q = state.quiz; if (!q) return;
    if (q.mode === 'match') {
      $('#quiz-progress').style.width = `${(q.matchDone / q.items.length) * 100}%`;
      $('#quiz-counter').textContent = `${fmtTime(Date.now() - q.startedAt)} · ${q.items.length - q.matchDone} left`;
    } else {
      $('#quiz-progress').style.width = `${(q.index / q.items.length) * 100}%`;
      $('#quiz-counter').textContent = `${Math.min(q.index + 1, q.items.length)} / ${q.items.length}`;
    }
  }
  function record(item, correct) {
    const q = state.quiz;
    const r = q.results.get(item.id) || { item, right: 0, wrong: 0 };
    if (correct) r.right++; else r.wrong++;
    q.results.set(item.id, r);
  }
  function nextQuestion() {
    const q = state.quiz; if (!q) return;
    q.busy = false;
    if (q.mode === 'match') { renderMatchRound(); return; }
    if (q.index >= q.items.length) { finishQuiz(); return; }
    updateQuizHeader();
    const item = q.items[q.index];
    if (q.custom) { renderSituation(item); return; }
    let mode = q.mode; if (mode === 'mixed') mode = pick(['mc', 'mc', 'listen']);
    let dir = q.direction; if (dir === 'both' || !dir) dir = Math.random() < 0.5 ? 'jp-en' : 'en-jp';
    if (mode === 'listen') renderListen(item); else renderMC(item, dir);
  }

  function buildOptions(item, field) {
    const q = state.quiz;
    const seen = new Set([item[field]]);
    const take = x => x.id !== item.id && !seen.has(x[field]) && seen.add(x[field]);
    if (q.groups && q.groups[item.id]) {
      // confusable set first, then fill from the whole pool
      const picks = shuffle(q.groups[item.id].filter(take)).slice(0, 3);
      const fill = shuffle(q.pool.filter(take));
      while (picks.length < 3 && fill.length) picks.push(fill.shift());
      return shuffle([item, ...picks]);
    }
    const cands = q.pool.filter(take);
    const sameGroup = shuffle(cands.filter(x => x.group === item.group)), others = shuffle(cands.filter(x => x.group !== item.group));
    const picks = [...sameGroup.slice(0, 2), ...others.slice(0, 1)];
    const rest = [...sameGroup.slice(2), ...others.slice(1)];
    while (picks.length < 3 && rest.length) picks.push(rest.shift());
    return shuffle([item, ...picks]);
  }
  const jpOptClass = text => `q-opt q-opt-jp${jpLen(text) <= 2 ? ' q-opt-big' : ''}`;

  function renderMC(item, dir) {
    const body = $('#quiz-body');
    const promptJP = dir === 'jp-en';
    const field = promptJP ? 'en' : 'jp';
    const options = buildOptions(item, field);
    const promptHTML = promptJP
      ? `<div class="card-jp ${jpSizeClass(item.jp)}">${escapeHTML(item.jp)}</div>`
      : `<div class="q-en ${item.en.length > 28 ? 'long' : ''}">${escapeHTML(item.en)}</div>${item.kind === 'kana' || item.en === item.romaji ? `<div class="q-sub">“${escapeHTML(item.sounds)}”</div>` : ''}`;
    body.innerHTML = `
      <div class="q-prompt">
        <div class="card-top"><span class="card-deck">${escapeHTML(item.group)}</span>${promptJP ? `<button class="speak-btn" aria-label="Read aloud">${SPEAK_SVG}</button>` : '<span></span>'}</div>
        <div class="q-prompt-main">${promptHTML}</div>
        <div class="card-hint">${promptJP ? (item.en === item.romaji ? 'How is it read?' : 'What does it mean?') : 'Which one is it?'}</div>
      </div>
      <div class="q-options">${options.map((o, i) => `<button class="${promptJP ? 'q-opt' : jpOptClass(o.jp)}" data-i="${i}">${escapeHTML(o[field])}</button>`).join('')}</div>`;
    body.querySelector('.speak-btn')?.addEventListener('click', e => speak(item.jp, e.currentTarget));
    $$('.q-opt', body).forEach(b => b.addEventListener('click', () => answerChoice(item, options[Number(b.dataset.i)], b, field)));
  }

  function renderSituation(item) {
    const body = $('#quiz-body');
    const options = item.options.map((text, i) => ({ text, ok: i === item.answer }));
    const shuffled = shuffle(options);
    body.innerHTML = `
      <div class="q-prompt">
        <div class="card-top"><span class="card-deck">${escapeHTML(item.group || 'Situation')}</span><span></span></div>
        <div class="q-prompt-main"><div class="q-en ${item.prompt.length > 48 ? 'long' : ''}">${escapeHTML(item.prompt)}</div></div>
        <div class="card-hint">What do you say?</div>
      </div>
      <div class="q-options">${shuffled.map((o, i) => `<button class="${jpOptClass(o.text)}" data-i="${i}">${escapeHTML(o.text)}</button>`).join('')}</div>`;
    $$('.q-opt', body).forEach(b => b.addEventListener('click', () => {
      const q = state.quiz; if (!q || q.busy) return;
      q.busy = true;
      const o = shuffled[Number(b.dataset.i)];
      const opts = $$('#quiz-body .q-opt'); opts.forEach(x => { x.disabled = true; });
      b.classList.add(o.ok ? 'is-right' : 'is-wrong');
      opts.forEach((x, i) => { if (shuffled[i].ok && x !== b) x.classList.add('is-right'); else if (x !== b) x.classList.add('is-dim'); });
      const right = item.options[item.answer];
      if (!o.ok && item.why) toast(item.why, { duration: 2200 });
      speak(right);
      record({ id: item.id, kind: 'situation', jp: right, en: item.prompt, romaji: '', sounds: '', meaning: item.prompt }, o.ok);
      haptic(o.ok ? 12 : 25);
      q.index++;
      setTimeout(nextQuestion, o.ok ? 700 : 1700);
    }));
  }

  function renderListen(item) {
    const body = $('#quiz-body');
    const options = buildOptions(item, 'jp');
    body.innerHTML = `
      <div class="q-prompt">
        <div class="card-top"><span class="card-deck">${escapeHTML(item.group)}</span><span></span></div>
        <div class="q-prompt-main">
          <button class="q-listen-btn" aria-label="Play"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg></button>
          <div class="q-listen-label">Listen, then choose. Tap to replay.</div>
        </div>
        <div class="card-hint">Which did you hear?</div>
      </div>
      <div class="q-options">${options.map((o, i) => `<button class="${jpOptClass(o.jp)}" data-i="${i}">${escapeHTML(o.jp)}</button>`).join('')}</div>`;
    const play = body.querySelector('.q-listen-btn');
    play.addEventListener('click', () => speak(item.jp, play));
    setTimeout(() => speak(item.jp, play), 120);
    $$('.q-opt', body).forEach(b => b.addEventListener('click', () => answerChoice(item, options[Number(b.dataset.i)], b, 'jp')));
  }

  function answerChoice(item, chosen, btn, field) {
    const q = state.quiz; if (!q || q.busy) return;
    q.busy = true;
    const correct = chosen[field] === item[field];
    const opts = $$('#quiz-body .q-opt');
    opts.forEach(o => { o.disabled = true; });
    btn.classList.add(correct ? 'is-right' : 'is-wrong');
    if (!correct) opts.forEach(o => { if (o.textContent === item[field]) o.classList.add('is-right'); else if (o !== btn) o.classList.add('is-dim'); });
    else opts.forEach(o => { if (o !== btn) o.classList.add('is-dim'); });
    record(item, correct);
    haptic(correct ? 12 : 25);
    if (field === 'en' || field === 'jp') speak(item.jp);
    q.index++;
    setTimeout(nextQuestion, correct ? 650 : 1500);
  }

  function renderMatchRound() {
    const q = state.quiz; const body = $('#quiz-body');
    if (q.matchPos >= q.items.length) { finishQuiz(); return; }
    const batch = q.items.slice(q.matchPos, q.matchPos + 6); q.matchPos += batch.length;
    const tiles = shuffle([...batch.map(it => ({ it, side: 'jp' })), ...batch.map(it => ({ it, side: 'en' }))]);
    body.innerHTML = `<p class="match-hint">${q.items[0]?.en === q.items[0]?.romaji ? 'Match each kana word to how it\'s read' : 'Tap a Japanese tile, then its match'}</p><div class="match-grid">${tiles.map((t, i) =>
      `<button class="m-tile ${t.side === 'jp' ? `jp${jpLen(t.it.jp) <= 2 ? ' big' : ''}` : (t.it.en.length > 26 ? 'long' : '')}" data-i="${i}" style="--i:${i}">${escapeHTML(t.side === 'jp' ? t.it.jp : t.it.en)}</button>`).join('')}</div>`;
    updateQuizHeader();
    let first = null, remaining = batch.length;
    const wrongOnce = new Set();
    $$('.m-tile', body).forEach(btn => btn.addEventListener('click', () => {
      if (q.busy || btn.classList.contains('is-matched')) return;
      const i = Number(btn.dataset.i), t = tiles[i];
      if (first === null) { first = i; btn.classList.add('is-sel'); haptic(6); return; }
      if (first === i) { first = null; btn.classList.remove('is-sel'); return; }
      const fb = body.querySelector(`.m-tile[data-i="${first}"]`), ft = tiles[first];
      first = null;
      if (ft.it.id === t.it.id && ft.side !== t.side) {
        fb.classList.remove('is-sel'); fb.classList.add('is-ok'); btn.classList.add('is-ok');
        record(t.it, !wrongOnce.has(t.it.id));
        q.matchDone++; remaining--; haptic(12);
        speak(t.it.jp);
        setTimeout(() => { fb.classList.add('is-matched'); btn.classList.add('is-matched'); }, 220);
        updateQuizHeader();
        if (remaining === 0) { q.busy = true; setTimeout(() => { q.busy = false; renderMatchRound(); }, 550); }
      } else {
        q.matchMistakes++; wrongOnce.add(ft.it.id); wrongOnce.add(t.it.id);
        fb.classList.remove('is-sel'); fb.classList.add('is-wrong'); btn.classList.add('is-wrong'); haptic(25);
        q.busy = true;
        setTimeout(() => { fb.classList.remove('is-wrong'); btn.classList.remove('is-wrong'); q.busy = false; }, 420);
      }
    }));
  }

  function endQuizEarly() {
    const q = state.quiz; if (!q) return;
    if (q.results.size === 0) { if (q.timer) clearInterval(q.timer); state.quiz = null; showTab(q.returnTo || 'quiz'); return; }
    finishQuiz({ early: true });
  }

  function finishQuiz({ early = false } = {}) {
    const q = state.quiz; if (!q) return;
    if (q.timer) clearInterval(q.timer);
    const rs = [...q.results.values()];
    let right, wrong, scoreSub;
    if (q.mode === 'match') {
      right = rs.filter(r => r.right > 0 && r.wrong === 0).length; wrong = q.matchMistakes;
      scoreSub = `${q.matchDone} pairs · ${wrong} mistake${wrong === 1 ? '' : 's'}`;
    } else {
      right = rs.reduce((n, r) => n + r.right, 0); wrong = rs.reduce((n, r) => n + r.wrong, 0);
      scoreSub = `${right} of ${right + wrong} correct`;
    }
    const pct = right + wrong ? Math.round((right / (right + wrong)) * 100) : 0;
    const missed = rs.filter(r => r.wrong > 0).map(r => r.item);
    // feed misses back into the flashcard schedule
    missed.forEach(it => { if (it.kind === 'card') markDueNow(it.card); });
    if (rs.length) { touchStreak(); state.progress.sessions = (state.progress.sessions || 0) + 1; }
    saveProgress();
    const res = { pct, right, wrong, early };
    if (!early) q.onDone?.(res);
    const again = { title: q.title, mode: q.mode, direction: q.direction, pool: q.pool, returnTo: q.returnTo, eyebrow: q.eyebrow };
    state.quiz = null;
    showResults({
      eyebrow: early ? 'Quiz ended' : (q.eyebrow || 'Quiz complete'), pct, scoreSub,
      good: right, again: wrong, goodLabel: q.mode === 'match' ? 'Clean pairs' : 'Correct', againLabel: q.mode === 'match' ? 'Mistakes' : 'Wrong',
      elapsed: Date.now() - q.startedAt, missed, returnTo: q.returnTo || 'quiz', subOverride: res.subOverride,
      redo: missed.length ? () => startQuiz({ ...again, title: 'Missed', items: shuffle(missed), mode: again.mode === 'match' && missed.length < 2 ? 'mc' : again.mode }) : null,
    });
  }


  // ================================================================ lessons
  async function loadLessons() {
    try {
      const res = await fetch('./lessons.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.lessons = (data.lessons || []).filter(l => l && l.id);
    } catch (e) { console.warn('lessons.json load failed', e); }
  }
  async function loadGrammar() {
    try {
      const res = await fetch('./grammar.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.grammar = { entries: data.entries || [], groups: data.groups || [], further: data.further || [] };
    } catch (e) { console.warn('grammar.json load failed', e); }
  }
  const lessonById = id => state.lessons.find(l => l.id === id);
  function lp(l) { // lesson progress record
    const p = state.progress.lessons;
    if (!p[l.id]) p[l.id] = { read: {}, build: { best: 0, attempts: 0 }, speak: { best: 0, attempts: 0 }, roleplay: { runs: 0 }, check: { best: 0, passed: false, attempts: 0 } };
    const r = p[l.id];
    r.read = r.read || {}; r.build = r.build || { best: 0, attempts: 0 }; r.speak = r.speak || { best: 0, attempts: 0 }; r.roleplay = r.roleplay || { runs: 0 }; r.check = r.check || { best: 0, passed: false, attempts: 0 };
    return r;
  }
  const lessonCards = l => state.decks.filter(d => (l.decks || []).includes(d.name)).flatMap(d => d.cards);
  const lessonDecks = l => state.decks.filter(d => (l.decks || []).includes(d.name));
  function lessonParts(l) {
    if (l.status !== 'full') return [];
    const r = lp(l);
    const readN = (l.learn || []).filter(s => r.read[s.id]).length;
    return [
      { key: 'learn', name: 'Learn', glyph: '学', sub: `${(l.learn || []).length} sections · study guide`, status: readN === (l.learn || []).length ? 'Read' : `${readN}/${(l.learn || []).length} read`, done: readN === (l.learn || []).length, frac: (l.learn || []).length ? readN / l.learn.length : 0, go: () => openGuide(l) },
      { key: 'build', name: 'Build', glyph: '組', sub: `${(l.build || []).length} drills · particles, slots, word order`, status: r.build.attempts ? `best ${r.build.best}%` : 'Not started', done: r.build.best >= 80, frac: Math.min(1, r.build.best / 100), go: () => startBuild(l) },
      { key: 'speak', name: 'Speak', glyph: '話', sub: `${(l.speak || []).length} phrases · say it, then check`, status: r.speak.attempts ? `best ${r.speak.best}%` : 'Not started', done: r.speak.best >= 80, frac: Math.min(1, r.speak.best / 100), go: () => startSpeak(l, {}) },
      { key: 'roleplay', name: 'Role-play', glyph: '店', sub: l.roleplay ? l.roleplay.title : '', status: r.roleplay.runs ? `${r.roleplay.runs} run${r.roleplay.runs === 1 ? '' : 's'}` : 'Not started', done: r.roleplay.runs > 0, frac: Math.min(1, r.roleplay.runs), go: () => startRoleplay(l) },
      { key: 'check', name: 'Check', glyph: '済', sub: `${(l.check || []).length} questions · pass at 80%`, status: r.check.passed ? 'Passed' : r.check.attempts ? `best ${r.check.best}%` : 'Locked until the rest is done', done: r.check.passed, frac: r.check.passed ? 1 : r.check.best / 100, go: () => startCheck(l) },
    ];
  }
  function lessonProgress(l) {
    const cards = lessonCards(l);
    const cardFrac = cards.length ? cards.filter(isMastered).length / cards.length : 0;
    if (l.status !== 'full') return cardFrac;
    const parts = lessonParts(l);
    return (parts.reduce((n, p) => n + p.frac, 0) + cardFrac) / (parts.length + 1);
  }
  const lessonDone = l => l.status === 'full' ? lp(l).check.passed : (lessonCards(l).length > 0 && lessonCards(l).every(isMastered));
  function currentLesson() {
    const full = state.lessons.filter(l => l.status === 'full');
    return full.find(l => !lessonDone(l)) || full[full.length - 1] || state.lessons[state.lessons.length - 1] || null;
  }
  function ringHTML(frac, size = 52) {
    const pct = Math.round(frac * 100);
    return `<div class="ring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 52 52"><circle class="track" cx="26" cy="26" r="22"/><circle class="fill" cx="26" cy="26" r="22" style="stroke-dashoffset:${(138.2 * (1 - frac)).toFixed(1)}"/></svg><div class="pct">${pct}%</div></div>`;
  }

  // ---------------------------------------------------------------- home (lesson path + plan)
  function renderHome() {
    $('#home-name').textContent = state.settings.name || 'Elan';
    $('#home-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const streak = currentStreak();
    $('#stat-streak').textContent = streak;
    $('#stat-streak-sub').textContent = streak === 0 ? 'Study today to start one'
      : state.progress.streak.lastDay === todayKey() ? 'Studied today · keep it up' : 'Study today to keep it';
    const all = state.decks.flatMap(d => d.cards);
    $('#stat-mastered').textContent = all.filter(isMastered).length;
    $('#stat-mastered-sub').textContent = `of ${all.length} cards`;
    $('#home-kana-sub').textContent = kanaStatusLine();
    $('#home-ref-sub').textContent = state.grammar.entries.length ? `${state.grammar.entries.length} rules · particles, verbs, adjectives, numbers` : 'Sentence structure, particles, verbs, adjectives';
    const cur = currentLesson();
    $('#home-sub').textContent = cur ? `Working on Lesson ${cur.num}: ${cur.title}.` : 'Welcome back.';
    renderPlan();

    const path = $('#lesson-path'); path.innerHTML = '';
    const doneCount = state.lessons.filter(lessonDone).length;
    $('#lessons-sub').textContent = state.lessons.length ? `${doneCount} of ${state.lessons.length} complete` : '';
    if (!state.lessons.length) { path.innerHTML = '<div class="empty">No lessons yet.</div>'; return; }
    state.lessons.forEach((l, i) => {
      const el = document.createElement('button');
      const isCur = cur && cur.id === l.id, done = lessonDone(l);
      el.className = 'lesson-row' + (isCur ? ' is-current' : '');
      el.style.setProperty('--i', i);
      const cards = lessonCards(l), due = cards.filter(isDue).length;
      const pill = done ? '<span class="lesson-pill done">済</span>' : isCur ? '<span class="lesson-pill cur">Current</span>' : l.status !== 'full' ? '<span class="lesson-pill">Cards</span>' : '';
      el.innerHTML = `
        <div class="lesson-num">${l.num}</div>
        <div class="lesson-body">
          <div class="lesson-name">${escapeHTML(l.title)} <span class="jp">${escapeHTML(l.jp || '')}</span></div>
          <div class="lesson-meta">${l.status === 'full' ? `${(l.learn || []).length} sections · ${(l.build || []).length} drills · ` : ''}${cards.length} cards${due ? ` · <span class="due">${due} due</span>` : ''}</div>
        </div>
        ${pill}
        ${ringHTML(lessonProgress(l), 44)}`;
      el.addEventListener('click', () => openLesson(l.id));
      path.appendChild(el);
    });
  }

  // ---------------------------------------------------------------- today's plan
  function planToday() {
    const p = state.progress.plan;
    if (p.day !== todayKey()) { p.day = todayKey(); p.done = {}; saveProgress(); }
    return p;
  }
  function markPlan(step) { const p = planToday(); p.done[step] = true; saveProgress(); }
  function planSteps() {
    const p = planToday();
    const all = state.decks.flatMap(d => d.cards);
    const due = all.filter(isDue).length;
    const cur = currentLesson();
    const steps = [];
    const unseenPool = cur ? (unseenCards(lessonDecks(cur)).length ? unseenCards(lessonDecks(cur)) : unseenCards()) : unseenCards();
    if (unseenPool.length) steps.push({ key: 'meet', title: `Meet ${Math.min(8, unseenPool.length)} new cards`, sub: 'See each one whole, with audio, before it\'s tested', done: !!p.done.meet,
      go: () => startPreview({ cards: unseenPool, title: 'Meet new cards', returnTo: 'home', onDone: () => markPlan('meet') }) });
    steps.push({ key: 'review', title: due ? `Review ${Math.min(due, 10)} due cards` : 'Review: nothing due', sub: due ? 'Flashcards from every lesson, misses come back sooner' : 'All caught up. Come back tomorrow.', done: !!p.done.review || due === 0,
      go: () => startSession({ decks: state.decks, title: "Today's review", dueOnly: true, limit: 10, returnTo: 'home', onDone: () => markPlan('review') }) });
    if (cur && cur.status === 'full') {
      const parts = lessonParts(cur);
      const next = parts.find(pt => !pt.done && pt.key !== 'check') || parts.find(pt => !pt.done) || null;
      if (next) steps.push({ key: 'part', title: `Lesson ${cur.num}: ${next.name}`, sub: next.sub, done: !!p.done.part, go: next.go });
      else steps.push({ key: 'part', title: `Lesson ${cur.num} complete`, sub: 'Everything passed. Review keeps it fresh.', done: true, go: () => openLesson(cur.id) });
      steps.push({ key: 'speak', title: `Speak: ${Math.min(8, (cur.speak || []).length)} phrases out loud`, sub: `From Lesson ${cur.num}. Say it, reveal, grade yourself.`, done: !!p.done.speak, go: () => startSpeak(cur, { count: 8, plan: true }) });
    } else if (cur) {
      steps.push({ key: 'part', title: `Lesson ${cur.num}: flashcards`, sub: 'Study guide and drills coming after Lesson 5 is approved.', done: !!p.done.part, go: () => startSession({ decks: lessonDecks(cur), title: cur.title, returnTo: 'home', onDone: () => markPlan('part') }) });
    }
    return steps;
  }
  function renderPlan() {
    const steps = planSteps();
    const wrap = $('#plan-steps'); wrap.innerHTML = '';
    const doneN = steps.filter(s => s.done).length;
    $('#plan-count').textContent = `${doneN} / ${steps.length}`;
    steps.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'plan-step' + (s.done ? ' is-done' : '');
      b.innerHTML = `<span class="plan-num">${s.done ? CHECK_SVG : i + 1}</span><span class="plan-body"><span class="plan-title">${escapeHTML(s.title)}</span><span class="plan-sub">${escapeHTML(s.sub)}</span></span><span class="plan-go">${s.done ? 'Again' : 'Start'}</span>`;
      b.addEventListener('click', () => { haptic(); s.go(); });
      wrap.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- lesson overview
  function openLesson(id) {
    const l = lessonById(id) || currentLesson(); if (!l) { showTab('home'); return; }
    state.lesson = l;
    $('#lesson-eyebrow').textContent = `Lesson ${l.num}${l.date ? ` · ${l.date}` : ''} · ${l.jp || ''}`;
    $('#lesson-title').textContent = l.title;
    $('#lesson-goal').textContent = l.goal || ''; annotateKana($('#lesson-goal'));
    $('#lesson-ring').innerHTML = ringHTML(lessonProgress(l), 60);
    const parts = $('#lesson-parts'); parts.innerHTML = '';
    let i = 0;
    const r = lp(l);
    const partsList = lessonParts(l);
    partsList.forEach(p => {
      const b = document.createElement('button');
      b.className = 'part-row' + (p.done ? ' is-done' : '');
      b.style.setProperty('--i', i++);
      const locked = p.key === 'check' && !partsList.filter(x => x.key !== 'check').every(x => x.done || (x.key === 'learn' ? x.frac >= 1 : x.frac > 0));
      if (locked && !r.check.passed) b.disabled = true;
      b.innerHTML = `<span class="part-icon jp">${p.glyph}</span><span class="part-body"><span class="part-name">${p.name}</span><span class="part-sub">${escapeHTML(p.sub)}</span></span><span class="part-status">${escapeHTML(p.done ? (p.key === 'check' ? 'Passed' : p.status) : locked ? 'Locked' : p.status)}</span>`;
      b.addEventListener('click', () => { haptic(); p.go(); });
      parts.appendChild(b);
    });
    // meet-new row, then flashcards
    const cards = lessonCards(l), due = cards.filter(isDue).length;
    const unseenL = cards.filter(isUnseen);
    if (unseenL.length) {
      const mt = document.createElement('button');
      mt.className = 'part-row'; mt.style.setProperty('--i', i++);
      mt.innerHTML = `<span class="part-icon jp">新</span><span class="part-body"><span class="part-name">Meet new cards</span><span class="part-sub">See the kana, romaji, sound and meaning together before testing</span></span><span class="part-status">${unseenL.length} new</span>`;
      mt.addEventListener('click', () => startPreview({ cards: unseenL, title: `Lesson ${l.num} · Meet the cards`, returnTo: 'lesson' }));
      parts.appendChild(mt);
    }
    const fc = document.createElement('button');
    fc.className = 'part-row'; fc.style.setProperty('--i', i++);
    fc.innerHTML = `<span class="part-icon jp">札</span><span class="part-body"><span class="part-name">Flashcards</span><span class="part-sub">${lessonDecks(l).map(d => d.name).join(' · ') || 'No decks'}</span></span><span class="part-status">${due ? `${due} due` : `${cards.length} cards`}</span>`;
    fc.addEventListener('click', () => startSession({ decks: lessonDecks(l), title: l.title, dueOnly: due > 0, returnTo: 'lesson' }));
    parts.appendChild(fc);
    if (l.status !== 'full') {
      const note = document.createElement('p'); note.className = 'hint'; note.style.padding = '12px 6px 0';
      note.textContent = 'Study guide, drills, speaking and role-play for this lesson come after Lesson 5 is approved.';
      parts.appendChild(note);
    }
    showScreen('lesson');
  }

  // ---------------------------------------------------------------- study guide
  function openGuide(l) {
    state.lesson = l;
    const r = lp(l);
    $('#guide-eyebrow').textContent = `Lesson ${l.num} · Study guide`;
    $('#guide-title').textContent = l.title;
    const body = $('#guide-body'); body.innerHTML = '';
    const goal = document.createElement('div'); goal.className = 'goal-card'; goal.style.marginTop = '8px';
    goal.innerHTML = `<div class="goal-body"><p class="eyebrow">Can-do goal</p><p class="goal-text">${escapeHTML(l.goal || '')}</p></div>`;
    body.appendChild(goal);
    const refByLesson = state.grammar.entries.filter(e => e.lesson === l.id);
    (l.learn || []).forEach((s, i) => {
      const sec = document.createElement('section'); sec.className = 'g-section'; sec.style.setProperty('--i', i);
      sec.innerHTML = `
        <h2>${escapeHTML(s.title)}</h2>${s.jp ? `<div class="g-jp jp">${escapeHTML(s.jp)}</div>` : ''}
        ${s.intro ? `<p class="g-intro">${escapeHTML(s.intro)}</p>` : ''}
        ${s.rule ? `<div class="g-rule"><div class="g-label">${escapeHTML(s.rule.label || 'Rule')}</div><div class="g-pattern">${s.rule.pattern}</div>${s.rule.note ? `<div class="g-note">${escapeHTML(s.rule.note)}</div>` : ''}</div>` : ''}
        ${s.when ? `<p class="g-when"><b>When to use it:</b> ${escapeHTML(s.when)}</p>` : ''}
        ${s.examples?.length ? `<div class="g-ex-list">${s.examples.map((e, j) => `<div class="g-ex"><div class="g-ex-text"><span class="jp">${escapeHTML(e.jp)}</span><span class="ro">${escapeHTML(e.romaji || '')}</span><span class="en">${escapeHTML(e.en)}</span></div><button class="speak-btn" data-jp="${escapeHTML(e.jp)}" aria-label="Read aloud">${SPEAK_SVG}</button></div>`).join('')}</div>` : ''}
        ${s.tips?.length ? `<div class="g-tips">${s.tips.map(t => `<div class="g-tip">${escapeHTML(t)}</div>`).join('')}</div>` : ''}
        <div class="g-read"><button class="pill ${r.read[s.id] ? 'pill-ghost is-on' : 'pill-accent'}" data-sec="${s.id}">${r.read[s.id] ? `${CHECK_SVG} Read` : 'Got it'}</button></div>`;
      $$('.speak-btn', sec).forEach(b => b.addEventListener('click', () => speak(b.dataset.jp, b)));
      sec.querySelector('[data-sec]').addEventListener('click', e => {
        const btn = e.currentTarget; r.read[s.id] = !r.read[s.id]; saveProgress(); haptic();
        btn.className = `pill ${r.read[s.id] ? 'pill-ghost is-on' : 'pill-accent'}`; btn.innerHTML = r.read[s.id] ? `${CHECK_SVG} Read` : 'Got it';
        if ((l.learn || []).every(x => r.read[x.id])) markPlan('part');
      });
      body.appendChild(sec);
    });
    // word bank
    const words = (l.vocab || []).map(jp => state.decks.flatMap(d => d.cards).find(c => c.jp === jp)).filter(Boolean);
    if (words.length) {
      const sec = document.createElement('section'); sec.className = 'g-section'; sec.style.setProperty('--i', (l.learn || []).length);
      sec.innerHTML = `<h2>Word bank</h2><div class="g-jp jp">たんご</div><div class="g-vocab">${words.map(w => `<button class="g-word" data-jp="${escapeHTML(w.jp)}"><span><span class="jp">${escapeHTML(w.jp)}</span><small>${escapeHTML(w.romaji)} · ${escapeHTML(w.en)}</small></span><span class="speak-btn">${SPEAK_SVG}</span></button>`).join('')}</div>`;
      $$('.g-word', sec).forEach(b => b.addEventListener('click', () => speak(b.dataset.jp, b.querySelector('.speak-btn'))));
      body.appendChild(sec);
    }
    if (refByLesson.length) {
      const sec = document.createElement('section'); sec.className = 'g-section'; sec.style.setProperty('--i', (l.learn || []).length + 1);
      sec.innerHTML = `<h2>The grammar behind it</h2><div class="g-jp jp">ぶんぽう</div><p class="g-intro">Rules this lesson introduces, in the Japanese reference.</p><div class="g-ref-links">${refByLesson.map(e => `<button class="g-ref-link" data-ref="${e.id}">${escapeHTML(e.title)}</button>`).join('')}</div>`;
      $$('[data-ref]', sec).forEach(b => b.addEventListener('click', () => openRefEntry(b.dataset.ref, 'guide')));
      body.appendChild(sec);
    }
    const cta = document.createElement('div'); cta.className = 'g-cta';
    cta.innerHTML = `<button class="btn btn-primary">Start the Build drills</button>`;
    cta.querySelector('button').addEventListener('click', () => startBuild(l));
    body.appendChild(cta);
    annotateKana(body);
    showScreen('guide');
  }

  // ---------------------------------------------------------------- build drills
  function startBuild(l) {
    state.lesson = l;
    const items = shuffle((l.build || []).map((b, i) => ({ ...b, id: `b${i}` })));
    if (!items.length) { toast('No drills in this lesson yet'); return; }
    state.build = { l, queue: items, total: items.length, index: 0, results: new Map(), startedAt: Date.now(), current: null, busy: false, first: new Set(items.map(i => i.id)) };
    $('#build-title').textContent = `Lesson ${l.num} · Build`;
    showScreen('build');
    nextBuild();
  }
  function buildHeader() {
    const b = state.build; if (!b) return;
    const done = b.total - b.queue.length - (b.current ? 1 : 0);
    $('#build-progress').style.width = `${(Math.max(0, done) / b.total) * 100}%`;
    $('#build-counter').textContent = `${Math.min(done + 1, b.total)} / ${b.total}${b.queue.length + (b.current ? 1 : 0) > b.total - done ? '' : ''}`;
  }
  function nextBuild() {
    const b = state.build; if (!b) return;
    b.busy = false;
    if (!b.queue.length) { finishBuild(); return; }
    b.current = b.queue.shift();
    buildHeader();
    const it = b.current;
    if (it.type === 'order') renderOrder(it); else renderSlot(it);
  }
  const KIND = { slot: 'Fill the slot', particle: 'Pick the particle', order: 'Build the sentence' };
  function recordBuild(it, ok) {
    const b = state.build;
    const r = b.results.get(it.id) || { item: it, right: 0, wrong: 0, firstTry: null };
    if (ok) r.right++; else r.wrong++;
    if (r.firstTry === null) r.firstTry = ok;
    b.results.set(it.id, r);
    if (!ok) b.queue.splice(Math.min(b.queue.length, 2), 0, it); // comes back soon
  }
  function showWhy(container, ok, it, extra = '') {
    const d = document.createElement('div'); d.className = `b-why ${ok ? 'ok' : 'bad'}`;
    d.innerHTML = `${ok ? '✓ ' : '✕ '}${extra}${escapeHTML(it.why || '')}`;
    container.appendChild(d); annotateKana(d);
    const foot = document.createElement('div'); foot.className = 'b-foot';
    foot.innerHTML = `<button class="btn ${ok ? 'btn-good' : 'btn-reveal'}" id="btn-build-next">${ok ? 'Next' : 'Got it, next'}</button>`;
    container.appendChild(foot);
    foot.querySelector('button').addEventListener('click', () => { haptic(); nextBuild(); });
    const body = $('#build-body'); body.scrollTop = body.scrollHeight;
  }
  function renderSlot(it) {
    const body = $('#build-body');
    const parts = it.jp.split('___');
    const options = shuffle(it.options);
    const narrow = options.every(o => jpLen(o) <= 1);
    body.innerHTML = `
      <div class="b-prompt">
        <div class="b-kind">${KIND[it.type] || 'Drill'}</div>
        <div class="b-en">${escapeHTML(it.en)}</div>
        <div class="b-sentence">${escapeHTML(parts[0] || '')}<span class="b-blank" id="b-blank">&nbsp;</span>${escapeHTML(parts[1] || '')}</div>
      </div>
      <div class="b-options ${narrow ? 'narrow' : ''}">${options.map((o, i) => `<button class="${jpOptClass(o)}" data-i="${i}">${escapeHTML(o)}</button>`).join('')}</div>`;
    const blank = $('#b-blank');
    $$('.q-opt', body).forEach(btn => btn.addEventListener('click', () => {
      const b = state.build; if (!b || b.busy) return; b.busy = true;
      const chosen = options[Number(btn.dataset.i)], ok = chosen === it.answer;
      $$('.q-opt', body).forEach(x => { x.disabled = true; if (x.textContent === it.answer) x.classList.add('is-right'); else if (x !== btn) x.classList.add('is-dim'); });
      if (!ok) btn.classList.add('is-wrong');
      blank.textContent = chosen; blank.className = `b-blank filled ${ok ? 'ok' : 'bad'}`;
      recordBuild(it, ok); haptic(ok ? 12 : 25);
      speak(it.jp.replace('___', it.answer));
      showWhy(body, ok, it, ok ? '' : `The answer is <b class="jp">${escapeHTML(it.answer)}</b>. `);
    }));
  }
  function renderOrder(it) {
    const body = $('#build-body');
    const tiles = shuffle(it.tiles.map((t, i) => ({ t, i })));
    body.innerHTML = `
      <div class="b-prompt">
        <div class="b-kind">${KIND.order}</div>
        <div class="b-en">${escapeHTML(it.en)}</div>
        <div class="b-answer" id="b-answer"></div>
      </div>
      <div class="b-bank" id="b-bank">${tiles.map((x, k) => `<button class="b-tile jp" data-k="${k}">${escapeHTML(x.t)}</button>`).join('')}</div>
      <div class="b-foot"><button class="btn btn-reveal" id="btn-order-check" disabled>Check</button></div>`;
    const answer = $('#b-answer'), check = $('#btn-order-check');
    let placed = [];
    const sync = () => { check.disabled = placed.length !== it.tiles.length; };
    $$('#b-bank .b-tile', body).forEach(btn => btn.addEventListener('click', () => {
      if (state.build?.busy || btn.classList.contains('is-used')) return;
      btn.classList.add('is-used'); haptic(6);
      const k = Number(btn.dataset.k);
      const chip = document.createElement('button'); chip.className = 'b-tile jp'; chip.textContent = tiles[k].t; chip.dataset.k = k;
      chip.addEventListener('click', () => { if (state.build?.busy) return; chip.remove(); btn.classList.remove('is-used'); placed = placed.filter(p => p !== k); sync(); });
      answer.appendChild(chip); placed.push(k); sync();
    }));
    check.addEventListener('click', () => {
      const b = state.build; if (!b || b.busy) return; b.busy = true;
      const ok = placed.every((k, idx) => tiles[k].i === idx);
      answer.classList.add(ok ? 'ok' : 'bad');
      $$('.b-tile', body).forEach(x => { x.disabled = true; });
      check.closest('.b-foot').remove();
      recordBuild(it, ok); haptic(ok ? 12 : 25);
      speak(it.tiles.join(''));
      showWhy(body, ok, it, ok ? '' : `Correct order: <b class="jp">${escapeHTML(it.tiles.join(' '))}</b>. `);
    });
  }
  function endBuildEarly() {
    const b = state.build; if (!b) return;
    if (b.results.size === 0) { state.build = null; $('#build-body').innerHTML = ''; openLesson(b.l.id); return; }
    finishBuild({ early: true });
  }
  function finishBuild({ early = false } = {}) {
    const b = state.build; if (!b) return;
    const rs = [...b.results.values()];
    const first = rs.filter(r => r.firstTry).length;
    const attempted = rs.length;
    const pct = attempted ? Math.round((first / attempted) * 100) : 0;
    const wrong = rs.reduce((n, r) => n + r.wrong, 0);
    const missed = rs.filter(r => r.wrong > 0).map(r => ({ jp: r.item.type === 'order' ? r.item.tiles.join(' ') : r.item.jp.replace('___', r.item.answer), en: r.item.en, kind: 'drill' }));
    const r = lp(b.l);
    if (!early) { r.build.attempts++; r.build.best = Math.max(r.build.best, pct); if (pct >= 80) markPlan('part'); }
    touchStreak(); saveProgress();
    const l = b.l; state.build = null; $('#build-body').innerHTML = '';
    showResults({
      eyebrow: early ? 'Drills ended' : 'Drills complete', pct, scoreSub: `${first} of ${attempted} right first time`,
      good: first, again: wrong, goodLabel: 'First try', againLabel: 'Retried', elapsed: Date.now() - b.startedAt, missed, returnTo: 'lesson',
      subOverride: !early ? (pct >= 80 ? `Build passed. ${missed.length ? 'Retried items are listed below.' : 'Clean run.'}` : 'Score 80% or more to pass. The explanations tell you why.') : undefined,
      redo: () => startBuild(l),
    });
    $('#btn-redo-missed').textContent = 'Run the drills again';
    $('#btn-redo-missed').hidden = false;
  }

  // ---------------------------------------------------------------- speak (say it, then reveal)
  function startSpeak(l, { count = 0, plan = false } = {}) {
    state.lesson = l;
    let items = shuffle((l.speak || []).map((s, i) => ({ ...s, id: `s${i}` })));
    if (count > 0) items = items.slice(0, count);
    if (!items.length) { toast('No speaking prompts yet'); return; }
    state.speak = { l, queue: items, total: items.length, results: new Map(), startedAt: Date.now(), current: null, revealed: false, plan };
    $('#speak-title').textContent = `Lesson ${l.num} · Speak`;
    showScreen('speak');
    nextSpeak();
  }
  function nextSpeak() {
    const s = state.speak; if (!s) return;
    if (!s.queue.length) { finishSpeak(); return; }
    s.current = s.queue.shift(); s.revealed = false;
    const done = s.total - s.queue.length - 1;
    $('#speak-progress').style.width = `${(done / s.total) * 100}%`;
    $('#speak-counter').textContent = `${Math.min(done + 1, s.total)} / ${s.total}`;
    const it = s.current;
    const stage = $('#speak-stage'); stage.innerHTML = '';
    const card = document.createElement('div'); card.className = 'speak-card';
    card.innerHTML = `
      <div class="card-top"><span class="card-deck">Say it in Japanese</span><span></span></div>
      <div class="card-main" style="align-items:flex-start;text-align:left">
        <div class="sp-en ${it.en.length > 26 ? 'long' : ''}">${escapeHTML(it.en)}</div>
        <div class="sp-hint" id="sp-hint"><span class="dot"></span> Say it out loud, then reveal</div>
        <div id="sp-answer"></div>
      </div>
      <div class="card-hint">Grade yourself honestly. Misses come back.</div>`;
    stage.appendChild(card);
    $('#speak-actions').innerHTML = `<button class="btn btn-reveal" id="btn-sp-reveal">Reveal</button>`;
    $('#btn-sp-reveal').addEventListener('click', revealSpeak);
  }
  function revealSpeak() {
    const s = state.speak; if (!s || s.revealed) return;
    s.revealed = true; haptic(8);
    const it = s.current;
    $('#sp-hint').remove();
    $('#sp-answer').innerHTML = `<div class="sp-jp">${escapeHTML(it.jp)}</div><div class="sp-ro">${escapeHTML(it.romaji || '')}</div>`;
    $('#speak-actions').innerHTML = `<div class="sp-grade"><button class="btn btn-again" id="btn-sp-bad">Not yet</button><button class="btn btn-good" id="btn-sp-good">Got it</button></div>`;
    $('#btn-sp-bad').addEventListener('click', () => gradeSpeak(false));
    $('#btn-sp-good').addEventListener('click', () => gradeSpeak(true));
    speak(it.jp);
  }
  function gradeSpeak(ok) {
    const s = state.speak; if (!s || !s.revealed) return;
    const it = s.current;
    const r = s.results.get(it.id) || { item: it, right: 0, wrong: 0, firstTry: null };
    if (ok) r.right++; else r.wrong++;
    if (r.firstTry === null) r.firstTry = ok;
    s.results.set(it.id, r);
    if (!ok) s.queue.splice(Math.min(s.queue.length, 2), 0, it);
    haptic(ok ? 12 : 20);
    nextSpeak();
  }
  function endSpeakEarly() {
    const s = state.speak; if (!s) return;
    if (s.results.size === 0) { state.speak = null; openLesson(s.l.id); return; }
    finishSpeak({ early: true });
  }
  function finishSpeak({ early = false } = {}) {
    const s = state.speak; if (!s) return;
    const rs = [...s.results.values()];
    const first = rs.filter(r => r.firstTry).length, attempted = rs.length;
    const pct = attempted ? Math.round((first / attempted) * 100) : 0;
    const missed = rs.filter(r => r.wrong > 0).map(r => ({ jp: r.item.jp, en: r.item.en, kind: 'speak' }));
    const r = lp(s.l);
    if (!early) { r.speak.attempts++; r.speak.best = Math.max(r.speak.best, pct); if (s.plan) markPlan('speak'); else if (pct >= 80) markPlan('part'); }
    touchStreak(); saveProgress();
    const l = s.l, plan = s.plan; state.speak = null; $('#speak-stage').innerHTML = ''; $('#speak-actions').innerHTML = '';
    showResults({
      eyebrow: early ? 'Speaking ended' : 'Speaking complete', pct, scoreSub: `${first} of ${attempted} on the first try`,
      good: first, again: rs.reduce((n, x) => n + x.wrong, 0), goodLabel: 'Got it', againLabel: 'Not yet', elapsed: Date.now() - s.startedAt, missed,
      returnTo: plan ? 'home' : 'lesson', redo: missed.length ? () => startSpeak(l, {}) : null,
    });
  }

  // ---------------------------------------------------------------- role-play
  function startRoleplay(l) {
    const rp = l.roleplay; if (!rp) { toast('No role-play in this lesson'); return; }
    state.lesson = l;
    const v = {}; for (const k of Object.keys(rp.variants || {})) v[k] = pick(rp.variants[k]);
    const fill = s => (s || '').replace(/\{(\w+)(?:\.(\w+))?\}/g, (m, k, f) => {
      const key = k.toLowerCase(), cap = k[0] === k[0].toUpperCase();
      const val = v[key]; if (!val) return m;
      let out = f === 'r' ? val[1] : f === 'en' ? val[2] : f === 'a' ? (val[3] || val[2]) : val[0];
      if (cap) out = out.charAt(0).toUpperCase() + out.slice(1);
      return out;
    });
    const lines = rp.lines.map(ln => ({ ...ln, jp: fill(ln.jp), romaji: fill(ln.romaji), en: fill(ln.en), cue: fill(ln.cue) }));
    state.rp = { l, lines, i: 0, v, revealed: false, startedAt: Date.now() };
    $('#rp-title').textContent = rp.title;
    const log = $('#rp-log'); log.innerHTML = `<p class="rp-intro">${escapeHTML(rp.intro || '')}</p>`;
    showScreen('roleplay');
    stepRoleplay();
  }
  function rpBubble(ln, { reveal = true } = {}) {
    const d = document.createElement('div'); d.className = `rp-msg ${ln.who}`;
    d.innerHTML = `<div class="rp-who">${ln.who === 'staff' ? 'Staff' : 'You'}</div><div class="rp-jp">${escapeHTML(ln.jp)}</div><div class="rp-ro">${escapeHTML(ln.romaji || '')}</div><div class="rp-en">${escapeHTML(ln.en || '')}</div><button class="speak-btn" aria-label="Read aloud">${SPEAK_SVG}</button>`;
    d.querySelector('.speak-btn').addEventListener('click', e => { e.stopPropagation(); speak(ln.jp, e.currentTarget); });
    return d;
  }
  function stepRoleplay() {
    const r = state.rp; if (!r) return;
    const log = $('#rp-log'), actions = $('#rp-actions');
    $$('.rp-cue', log).forEach(c => c.remove());
    $('#rp-progress').style.width = `${(r.i / r.lines.length) * 100}%`;
    $('#rp-counter').textContent = `${Math.min(r.i + 1, r.lines.length)} / ${r.lines.length}`;
    if (r.i >= r.lines.length) {
      const p = lp(r.l); p.roleplay.runs++; saveProgress(); markPlan('part'); touchStreak();
      const end = document.createElement('div'); end.className = 'rp-end';
      end.innerHTML = `<div class="jp">おつかれさま</div><p>Done: ${escapeHTML(r.v.item ? r.v.item[2] : 'item')}, ${escapeHTML(r.v.price ? r.v.price[2] : '')}. Run it again with a different item and price.</p>`;
      log.appendChild(end); log.scrollTop = log.scrollHeight;
      actions.innerHTML = `<button class="btn btn-primary" id="btn-rp-again">Run again</button><button class="btn btn-secondary" id="btn-rp-done">Done</button>`;
      $('#btn-rp-again').addEventListener('click', () => startRoleplay(r.l));
      $('#btn-rp-done').addEventListener('click', () => { const l = r.l; state.rp = null; openLesson(l.id); });
      return;
    }
    const ln = r.lines[r.i];
    if (ln.who === 'staff') {
      log.appendChild(rpBubble(ln)); log.scrollTop = log.scrollHeight;
      speak(ln.jp);
      actions.innerHTML = `<button class="btn btn-reveal" id="btn-rp-next">Next</button>`;
      $('#btn-rp-next').addEventListener('click', () => { r.i++; stepRoleplay(); });
    } else {
      r.revealed = false;
      const cue = document.createElement('div'); cue.className = 'rp-cue';
      cue.innerHTML = `<div class="rp-who">Your turn</div><div class="rp-cue-text">${escapeHTML(ln.cue || ln.en)}</div><div class="rp-cue-hint">Say it out loud, then reveal.</div>`;
      log.appendChild(cue); log.scrollTop = log.scrollHeight;
      actions.innerHTML = `<button class="btn btn-reveal" id="btn-rp-reveal">Reveal my line</button>`;
      $('#btn-rp-reveal').addEventListener('click', () => {
        cue.remove();
        log.appendChild(rpBubble(ln)); log.scrollTop = log.scrollHeight;
        speak(ln.jp); haptic(8);
        actions.innerHTML = `<button class="btn btn-good" id="btn-rp-next">Next</button>`;
        $('#btn-rp-next').addEventListener('click', () => { r.i++; stepRoleplay(); });
      });
    }
  }

  // ---------------------------------------------------------------- check (lesson checkpoint)
  function startCheck(l) {
    state.lesson = l;
    const qs = shuffle((l.check || []).map((c, i) => ({ ...c, id: `c${i}`, group: `Lesson ${l.num} check` })));
    if (!qs.length) { toast('No checkpoint yet'); return; }
    startQuiz({
      title: `Lesson ${l.num} · Check`, mode: 'mc', direction: 'en-jp', items: qs, pool: qs, returnTo: 'lesson', eyebrow: 'Checkpoint', custom: true,
      onDone: res => {
        const r = lp(l); r.check.attempts++; r.check.best = Math.max(r.check.best, res.pct);
        if (res.pct >= 80) { r.check.passed = true; markPlan('part'); res.subOverride = `Lesson ${l.num} passed. You can do this at a shop in Asakusa.`; }
        else res.subOverride = 'Score 80% or more to pass. Reread the guide sections you missed.';
        saveProgress();
      },
    });
  }

  // ---------------------------------------------------------------- reference
  function renderRef() {
    const g = state.grammar; const body = $('#ref-body'); body.innerHTML = '';
    if (!g.entries.length) { body.innerHTML = '<div class="empty">Reference not loaded yet.</div>'; return; }
    const cur = currentLesson(); const curNum = cur ? cur.num : 99;
    const numOf = id => lessonById(id)?.num ?? 0;
    g.groups.forEach(grp => {
      const entries = g.entries.filter(e => e.group === grp); if (!entries.length) return;
      const sec = document.createElement('div'); sec.className = 'ref-group';
      sec.innerHTML = `<h3>${escapeHTML(grp)}</h3><div class="ref-list">${entries.map(e => {
        const n = numOf(e.lesson), ahead = n > curNum;
        return `<button class="ref-row" data-ref="${e.id}"><span class="ref-row-body"><span class="ref-row-title">${escapeHTML(e.title)} <span class="jp">${escapeHTML(e.jp || '')}</span></span><span class="ref-row-sum">${escapeHTML(e.summary || '')}</span></span><span class="ref-tag ${ahead ? 'ahead' : ''}">${ahead ? 'Ahead' : n ? `L${n}` : ''}</span></button>`;
      }).join('')}</div>`;
      $$('[data-ref]', sec).forEach(b => b.addEventListener('click', () => openRefEntry(b.dataset.ref, 'ref')));
      body.appendChild(sec);
    });
    if (g.further.length) {
      const f = document.createElement('div'); f.className = 'ref-group further';
      f.innerHTML = `<h3>Free further reading</h3><div class="ref-list">${g.further.map(x => `<a href="${escapeHTML(x.url)}" target="_blank" rel="noopener"><span class="f-title">${escapeHTML(x.title)}</span><span class="f-note">${escapeHTML(x.note || '')}</span></a>`).join('')}</div>`;
      body.appendChild(f);
    }
    annotateKana(body);
  }
  function openRefEntry(id, from = 'ref') {
    const e = state.grammar.entries.find(x => x.id === id); if (!e) return;
    const l = lessonById(e.lesson);
    $('#refentry-eyebrow').textContent = `${e.group}${l ? ` · introduced in Lesson ${l.num}` : ''}`;
    $('#refentry-title').textContent = e.title;
    const body = $('#refentry-body');
    body.innerHTML = `
      <div class="g-section" style="margin-top:8px">
        <div class="g-jp jp" style="margin-top:0">${escapeHTML(e.jp || '')}</div>
        <p class="g-intro"><b>${escapeHTML(e.summary || '')}</b></p>
        <div class="ref-body">${e.body || ''}</div>
        ${e.examples?.length ? `<div class="g-ex-list">${e.examples.map(x => `<div class="g-ex"><div class="g-ex-text"><span class="jp">${escapeHTML(x.jp)}</span><span class="ro">${escapeHTML(x.romaji || '')}</span><span class="en">${escapeHTML(x.en)}</span></div><button class="speak-btn" data-jp="${escapeHTML(x.jp)}" aria-label="Read aloud">${SPEAK_SVG}</button></div>`).join('')}</div>` : ''}
      </div>`;
    $$('.speak-btn', body).forEach(b => b.addEventListener('click', () => speak(b.dataset.jp, b)));
    annotateKana(body);
    $('#btn-refentry-back').onclick = () => { if (from === 'guide' && state.lesson) openGuide(state.lesson); else { renderRef(); showScreen('ref'); } };
    showScreen('refentry');
  }

  // ---------------------------------------------------------------- meet the cards (preview before testing)
  function unseenCards(decks = state.decks) { return decks.flatMap(d => d.cards).filter(isUnseen); }
  function startPreview({ cards, title = 'Meet the cards', returnTo = 'review', limit = 8, onDone = null }) {
    const batch = cards.slice(0, limit > 0 ? limit : cards.length);
    if (!batch.length) { toast('No new cards here'); return; }
    state.preview = { queue: batch.slice(), total: batch.length, done: [], current: null, title, returnTo, onDone, startedAt: Date.now() };
    $('#preview-title').textContent = title;
    showScreen('preview');
    nextPreview();
  }
  function nextPreview() {
    const p = state.preview; if (!p) return;
    if (!p.queue.length) { finishPreview(); return; }
    p.current = p.queue.shift();
    markSeen(p.current);
    const i = p.done.length;
    $('#preview-progress').style.width = `${(i / p.total) * 100}%`;
    $('#preview-counter').textContent = `${i + 1} / ${p.total}`;
    const c = p.current;
    const stage = $('#preview-stage'); stage.innerHTML = '';
    const el = document.createElement('div'); el.className = 'preview-card';
    el.innerHTML = `
      <div class="card-top"><span class="card-deck">${escapeHTML(c.deck)}</span><span class="pv-new">New</span></div>
      <div class="pv-main">
        <div class="pv-jp ${jpSizeClass(c.jp)}">${escapeHTML(c.jp)}</div>
        ${c.romaji ? `<div class="pv-ro">${escapeHTML(c.romaji)}</div>` : ''}
        ${c.sounds ? `<div class="pv-sounds">“${escapeHTML(c.sounds)}”</div>` : ''}
        <div class="card-sep"></div>
        <div class="pv-en">${escapeHTML(c.en)}</div>
      </div>
      <div class="card-hint">Say it out loud twice, then Next</div>`;
    el.addEventListener('click', () => speak(c.jp));
    stage.appendChild(el);
    speak(c.jp);
  }
  function finishPreview() {
    const p = state.preview; if (!p) return;
    saveProgress(); touchStreak();
    const cards = p.done.slice(); const returnTo = p.returnTo;
    p.onDone?.();
    state.preview = null; $('#preview-stage').innerHTML = '';
    showResults({
      eyebrow: 'Cards met', pct: 100, scoreSub: `${cards.length} new card${cards.length === 1 ? '' : 's'} seen`, subOverride: 'Now test them while they\'re fresh. The front shows a hint the first time.',
      good: cards.length, again: 0, goodLabel: 'Met', againLabel: 'Skipped', elapsed: Date.now() - p.startedAt, missed: [], returnTo,
      redo: () => startSession({ title: 'Fresh cards', cards, redo: true, returnTo }),
    });
    $('#btn-redo-missed').textContent = `Flashcards for these ${cards.length}`;
    $('#btn-redo-missed').hidden = false;
    $('#summary-jp').textContent = 'はじめまして';
  }

  // ---------------------------------------------------------------- kana: look-alike drill
  const LOOKALIKE_GROUPS = [['あ', 'お', 'め', 'ぬ'], ['き', 'さ', 'ち'], ['ね', 'れ', 'わ'], ['は', 'ほ', 'ま'], ['る', 'ろ'], ['い', 'り'], ['く', 'へ'], ['し', 'つ'], ['た', 'な'], ['ふ', 'ぶ', 'ぷ']];
  function startLookalikeDrill() {
    const all = KANA.tiers.flatMap(t => tierItems(t));
    const byChar = Object.fromEntries(all.map(it => [it.jp, it]));
    const groups = {}; const items = [];
    LOOKALIKE_GROUPS.forEach(g => { const its = g.map(c => byChar[c]).filter(Boolean); its.forEach(it => { groups[it.id] = its; items.push(it); }); });
    startQuiz({ title: 'Look-alike kana', mode: 'mc', direction: 'jp-en', items: shuffle(items).slice(0, 16), pool: all, groups, returnTo: 'kana', eyebrow: 'Drill complete' });
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    $('#opt-name').value = state.settings.name || '';
    $('#opt-autospeak').checked = !!state.settings.autoSpeak;
    $('#opt-romaji').checked = !!state.settings.romajiHelp;
    $('#app-version').textContent = `v${APP_VERSION}`;
    applyTheme();
  }

  async function resetProgress() {
    const ok = await confirmSheet({ title: 'Reset all progress?', text: 'This clears every card\'s review history, your hiragana progress and your streak. Your cards and settings stay. This cannot be undone.', confirmLabel: 'Reset' });
    if (!ok) return;
    state.progress = { cards: {}, streak: { count: 0, lastDay: null }, sessions: 0, lastVersion: state.cardsVersion, kana: { rows: {}, tiers: {} } };
    state.kanaTier = null;
    saveProgress();
    toast('Progress reset');
    renderHome();
  }

  // ---------------------------------------------------------------- service worker
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
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
    $$('.tab').forEach(t => t.addEventListener('click', () => { haptic(); showTab(t.dataset.tab); }));
    $('#home-kana-card').addEventListener('click', () => showTab('kana'));
    $('#btn-settings').addEventListener('click', () => { renderSettings(); showScreen('settings'); });
    $('#btn-settings-back').addEventListener('click', () => showTab('home'));
    $('#home-ref-card').addEventListener('click', () => { renderRef(); showScreen('ref'); });
    $('#btn-ref-back').addEventListener('click', () => showTab('home'));
    $('#btn-refentry-back').addEventListener('click', () => { renderRef(); showScreen('ref'); });
    $('#btn-lesson-back').addEventListener('click', () => showTab('home'));
    $('#btn-guide-back').addEventListener('click', () => openLesson(state.lesson?.id));
    $('#btn-build-close').addEventListener('click', () => endBuildEarly());
    $('#btn-speak-close').addEventListener('click', () => endSpeakEarly());
    $('#btn-rp-close').addEventListener('click', () => { state.rp = null; openLesson(state.lesson?.id); });
    $('#btn-study-due').addEventListener('click', () => startSession({ decks: state.decks, title: 'Due cards', dueOnly: true }));
    $('#btn-meet-new').addEventListener('click', () => startPreview({ cards: unseenCards(), title: 'Meet new cards', returnTo: 'review' }));
    $('#btn-preview-next').addEventListener('click', () => { const p = state.preview; if (!p) return; haptic(); p.done.push(p.current); nextPreview(); });
    $('#btn-preview-hear').addEventListener('click', e => { if (state.preview?.current) speak(state.preview.current.jp, e.currentTarget); });
    $('#btn-preview-close').addEventListener('click', () => { const p = state.preview; if (!p) return; if (p.done.length) finishPreview(); else { state.preview = null; showTab(p.returnTo); } });
    document.addEventListener('keydown', e => { if (state.screen === 'speak' && state.speak) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); $('#speak-actions .btn-reveal')?.click(); } else if (e.key === 'ArrowRight') $('#btn-sp-good')?.click(); else if (e.key === 'ArrowLeft') $('#btn-sp-bad')?.click(); } });
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
    $('#btn-summary-done').addEventListener('click', () => { const r = state.lastResult?.returnTo || 'home'; if (r === 'lesson') openLesson(state.lesson?.id); else showTab(r); });
    $('#btn-redo-missed').addEventListener('click', () => state.lastResult?.redo?.());

    // kana
    $('#btn-kana-practice').addEventListener('click', () => { state.settings.quiz.source = 'kana'; saveSettings(); showTab('quiz'); });
    $('#btn-kana-lookalike').addEventListener('click', startLookalikeDrill);
    $('#btn-kana-readwords').addEventListener('click', () => {
      const q = state.settings.quiz; q.source = 'decks'; q.decks = ['Words']; q.mode = 'mc'; q.direction = 'jp-en'; q.answer = 'romaji'; q.count = 10; saveSettings();
      startQuizFromSetup();
    });
    $('#btn-learn-close').addEventListener('click', () => { state.learn = null; showTab('kana'); });
    $('#btn-learn-next').addEventListener('click', learnNext);

    // quiz
    $('#src-decks').addEventListener('click', () => { state.settings.quiz.source = 'decks'; saveSettings(); haptic(); renderQuizSetup(); });
    $('#src-kana').addEventListener('click', () => { state.settings.quiz.source = 'kana'; saveSettings(); haptic(); renderQuizSetup(); });
    $$('#mode-grid .mode-card').forEach(b => b.addEventListener('click', () => { state.settings.quiz.mode = b.dataset.mode; saveSettings(); haptic(); renderQuizSetup(); }));
    $$('#quiz-dir .seg').forEach(b => b.addEventListener('click', () => { state.settings.quiz.direction = b.dataset.dir; saveSettings(); haptic(); renderQuizSetup(); }));
    $$('#quiz-count .seg').forEach(b => b.addEventListener('click', () => { state.settings.quiz.count = Number(b.dataset.count); saveSettings(); haptic(); renderQuizSetup(); }));
    $$('#quiz-answer .seg').forEach(b => b.addEventListener('click', () => { state.settings.quiz.answer = b.dataset.answer; saveSettings(); haptic(); renderQuizSetup(); }));
    $('#btn-quiz-start').addEventListener('click', startQuizFromSetup);
    $('#btn-quiz-close').addEventListener('click', endQuizEarly);

    // settings
    $$('#opt-theme .seg').forEach(b => b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; saveSettings(); haptic(); applyTheme(); }));
    $('#opt-name').addEventListener('input', e => { state.settings.name = e.target.value.trim(); saveSettings(); });
    $('#opt-autospeak').addEventListener('change', e => { state.settings.autoSpeak = e.target.checked; saveSettings(); });
    $('#opt-romaji').addEventListener('change', e => { state.settings.romajiHelp = e.target.checked; saveSettings(); });
    $('#btn-test-voice').addEventListener('click', e => speak('こんにちは、エランさん', e.currentTarget));
    $('#btn-refresh-cards').addEventListener('click', async () => { const ok = await loadCards(); if (ok) renderHome(); });
    $('#btn-reset').addEventListener('click', resetProgress);

    document.addEventListener('keydown', e => {
      if (state.screen === 'study' && state.session) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); }
        else if (e.key === 'ArrowRight') grade(true);
        else if (e.key === 'ArrowLeft') grade(false);
        else if (e.key === 'Escape') endSessionEarly();
      } else if (state.screen === 'learn') {
        if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); learnNext(); }
      }
    });

    document.addEventListener('pointerdown', primeSpeech, { once: true, capture: true });
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && state.screen === 'home') { await loadCards({ silent: true }); await loadLessons(); renderHome(); }
    });
  }

  // ---------------------------------------------------------------- init
  async function init() {
    applyTheme();
    bind();
    registerSW();
    await Promise.all([loadCards({ silent: true }), loadLessons(), loadGrammar()]);
    showTab('home');
  }
  init();
})();
