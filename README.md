# Kotoba — Japanese flashcards

A small, offline-capable flashcard app for iPhone (Safari → Add to Home Screen) hosted on GitHub Pages. Plain HTML/CSS/JS, no build step.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell (home, study, summary, settings screens) |
| `styles.css` | Design: light/dark themes, card flip, swipe feedback |
| `app.js` | Logic: decks, Leitner spaced repetition, swipe, speech, streak, kana lessons, quizzes, settings |
| `kana-data.js` | Built-in hiragana: 46 basic, 25 dakuten, 33 combos, with romaji and sounds-like |
| `cards.json` | Flashcard decks. |
| `lessons.json` | Lessons: study guide, drills, speaking prompts, role-play, checkpoint. |
| `grammar.json` | Japanese reference entries and free further-reading links. |
| `manifest.json` | PWA manifest (name, icons, standalone display) |
| `sw.js` | Service worker: offline cache, network-first for `cards.json` |
| `icons/` | App icons (red circle with あ) |

## Updating cards

Edit or replace `cards.json` and push. Format:

```json
{
  "version": "lessons-1-5",
  "decks": [
    { "name": "Greetings", "cards": [
      { "jp": "こんにちは。", "romaji": "konnichiwa", "sounds": "kohn-nee-chee-wah", "en": "Hello." }
    ]}
  ]
}
```

Progress is keyed by **deck name + Japanese text**, so keep those unchanged for cards you've already studied. New decks and cards appear automatically the next time the app opens online. Change `version` whenever you update so the app shows a "New cards loaded" note.

## Lessons (v2)

The home screen is a lesson path, one lesson per teacher session, each with a Can-do goal and five parts:

1. **Learn**: a study guide written from the lesson notes: the pattern, the rule, when to use it, examples with audio, pitfalls, word bank.
2. **Build**: fill-the-slot, pick-the-particle and build-the-sentence drills. Every answer shows why.
3. **Speak**: Pimsleur-style. English prompt, say it aloud, reveal and hear it, grade yourself.
4. **Role-play**: a scripted conversation (e.g. the Asakusa shop) with the app as the other speaker. Item and price change each run.
5. **Check**: situational questions tied to the Can-do goal. 80% passes and seals the lesson.

"Today's 10 minutes" on the home screen chains a short review, the next unfinished lesson part and a speaking set. Lesson content lives in `lessons.json`; the built-in Japanese reference (sentence structure, particles, verbs, adjectives, numbers, politeness) lives in `grammar.json`, with each entry tagged by the lesson that introduces it.

## Hiragana

The Kana tab teaches hiragana row by row (あいうえお, then かきくけこ, ...). Each row is a short lesson with audio, followed by a 10-question drill; 80% or better marks the row learned and unlocks the next. When all 46 are learned, a mixed test (90% to pass) unlocks the Dakuten tier, which in turn unlocks the Combos tier.

## Quiz

The Quiz tab tests any lesson decks or your learned kana with multiple choice (either direction), listening, a timed match game, or a mixed test. Cards you miss in a quiz become due in flashcards.

## Spaced repetition

Leitner boxes 0–6 with intervals of 0, 1, 3, 7, 14, 30 and 60 days. "Got it" moves a card up one box; "Again" sends it back to box 0 and re-queues it a few cards later in the same session. A card in box 4 or higher counts as mastered. A deck whose cards are all mastered gets the red 済 seal.

## Deploying (GitHub Pages)

1. Create a new **public** repository on GitHub, e.g. `kotoba`.
2. In this folder:
   ```bash
   git init
   git add .
   git commit -m "Kotoba flashcards"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/kotoba.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, Save.
4. After a minute the site is live at `https://YOUR-USERNAME.github.io/kotoba/`.

## Installing on iPhone

1. Open the URL above in **Safari** (not Chrome).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch it from the home screen: it opens full-screen with no Safari bars and works offline.

## Pushing an update

After changing any file, commit and push again. The service worker fetches `cards.json` network-first, so new cards show up the next time the app opens with a connection. If you change the app's code, bump `CACHE_VERSION` in `sw.js` so installed phones pick up the new version (the app shows an "Update ready → Reload" toast).
