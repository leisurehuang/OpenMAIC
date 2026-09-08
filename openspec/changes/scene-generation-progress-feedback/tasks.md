# Tasks — Scene Generation Progress Feedback

## 1. Store & generator signals

- [x] 1.1 Add transient `currentGeneratingPhase` + `currentGeneratingStartedAt` fields and setters to `lib/store/stage.ts` (transient generation section; excluded from `persistenceSnapshot`)
- [x] 1.2 Write phase transitions in `generateRemaining` (`lib/hooks/use-scene-generator.ts`): `content` at the serial content await, `actions` before the actions fetch, `tts` before `generateTTSForScene` (only when TTS runs), `idle` on scene landing / batch end / pause / abort; set `currentGeneratingStartedAt` alongside `setCurrentGeneratingOrder`
- [x] 1.3 Write the same phase transitions in `retrySingleOutline` (`lib/hooks/use-scene-generator.ts`)

## 2. UI

- [x] 2.1 Create `components/canvas/generation-progress-panel.tsx`: step indicator (content → actions → TTS, TTS step hidden when TTS disabled), page X/N, done/remaining counts, media section (hidden when no tasks), mm:ss elapsed timer, reassurance line after 30s
- [x] 2.2 Replace the spinner block in `components/canvas/canvas-area.tsx` (pending, non-failed branch) with `<GenerationProgressPanel />`; leave failure and completion branches untouched

## 3. i18n

- [x] 3.1 Add `stage.generationProgress.*` keys to all 12 files in `lib/i18n/locales/`

## 4. Tests

- [x] 4.1 `tests/hooks/use-scene-generator-phase.test.ts`: phase transitions and resets on both generation paths (pattern: `tests/hooks/use-scene-generator-retry.test.ts`) — note: `.test.ts` (not `.tsx`) because vitest only includes `tests/**/*.test.ts`; the hook API is captured via a static-render probe component
- [x] 4.2 `tests/components/canvas/generation-progress-panel.test.ts`: stage rendering, page/completion counts, TTS-step hiding, media section visibility, elapsed timer + 30s reassurance — note: `.test.ts` (same vitest include constraint); zustand stores are mocked with plain readers because zustand v5 server rendering reads `getInitialState()`
- [x] 4.3 `tests/i18n/generation-progress-locales.test.ts`: new keys present in all 12 locales (pattern: existing `tests/i18n/*-locales.test.ts`)

## 5. Verification

- [x] 5.1 `openspec validate --strict` clean; `pnpm check:i18n-keys`, `pnpm test`, `pnpm lint`, `npx tsc --noEmit` all green — also repaired three pre-existing breakages blocking green: `tests/agent-runtime/owner.test.ts` (missed `await` after `resolveRequestOwnerId` became async + Secure cookie now keyed off `COOKIE_SECURE` instead of `NODE_ENV`), `tests/workbench/pg-mode-folder-listing.test.ts` (ordinal fetch assertions broken by the owner warm-up settings fetch), and two `no-explicit-any` lint errors in `lib/ai/llm.ts`
