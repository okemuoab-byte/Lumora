# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (localhost:5173)
npm run build     # Production build → dist/
npm run lint      # ESLint check
npm run preview   # Serve the production build locally
```

No test framework is configured.

## Architecture

All application code lives in a **single file**: `src/App.jsx` (~1490 lines). There is no routing library — navigation is handled via `useState` screen/view variables throughout.

### Exports

Three named exports consumed by the app shell, plus the default:
- `export default App` — root component (onboarding → landing → platform)
- `export function Platform` — main study hub (home, topic, quiz views)
- `export function MockExam` — timed mock exam
- `export function Generator` — AI question generator

### File structure inside App.jsx

Sections are marked with `// ════` comment dividers (in order):
1. XP/streak helpers (`getXP`, `addXP`, `getStreakData`, `touchStreak`)
2. SM-2 spaced repetition (`sm2Update`, `getDueIds`, `recordPerf`)
3. AI helpers (`callAPI`, `aiMark`, `aiSocratic`) — direct `fetch` to `api.anthropic.com`
4. `DS` design system const — all style tokens (see below)
5. `DIFF` const — difficulty colour mappings
6. `MODULES` data array — 6 modules × 22 topics
7. `AnimStyles` — global `<style>` tag with keyframes
8. Utility components: `MasteryRing`, `PredictedGrade`, `StudyModeToggle`, `Celebration`, `GamificationBar`
9. `Onboarding`, `LandingPage`
10. `QCard`, `TopicPage`, `DueForReview`, `WeaknessHeatmap`
11. `Platform` (home / topic / quiz views)
12. `MockQCard`, `MockExam`
13. `QCardGen`, `Generator`
14. `SocraticChat`
15. `App` (root)

### DS design system

All styling uses the `DS` const — never raw hex strings:

```js
DS.bg.base / .surface / .elevated / .overlay / .deep   // dark backgrounds
DS.accent.amber / .amberDim / .teal / .tealDim / .red / .redDim
DS.text.primary / .secondary / .muted
DS.border / DS.borderHi
DS.radius.sm / .md / .lg / .xl
DS.shadow
DS.tr  // transition string
```

### Data layer

All persistence is via `localStorage`. Keys:
- `gcse_sr` — spaced repetition schedule (SM-2 state per topic)
- `gcse_perf` — performance record per topic `{correct, total}`
- `lumora_profile` — user onboarding data
- `lumora_xp` — XP total
- `lumora_streak` — streak data `{last, count}`
- `lumora_tc_*` — topic chat history (one key per topic id)

### AI integration

Direct browser fetch to `api.anthropic.com/v1/messages`. API key read from `import.meta.env.VITE_ANTHROPIC_API_KEY` (requires `.env.local` with `VITE_ANTHROPIC_API_KEY=sk-ant-…`). Uses `anthropic-dangerous-direct-browser-access: true` header.

### MODULES data shape

```js
{ id, title, color, topics: [
  { id, title, boards: ['AQA','Edexcel',...], analogy, markScheme: [...],
    questions: [{q, mark, diff:'Starter'|'Mid'|'Killer', worked, board},...],
    mistakes: [...] }
]}
```

### ESLint note

`no-unused-vars` is configured to ignore names matching `^[A-Z_]`, so uppercase module-level constants (`DIFF`, `MODULES`, `MCOLORS`, `BCOLORS`, etc.) do not trigger lint errors even if not referenced in JSX.
- API key is in .env.local as VITE_ANTHROPIC_API_KEY
- Spaced repetition data stored in localStorage under gcse_sr
- Performance data stored under gcse_perf
- User profile stored under lumora_profile
- Do not break existing localStorage data structures when editing