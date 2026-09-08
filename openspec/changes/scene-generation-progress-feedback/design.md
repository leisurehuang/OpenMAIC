# Design — Scene Generation Progress Feedback

## 改动面

| # | File | Change |
|---|---|---|
| 1 | `lib/store/stage.ts` | Transient fields `currentGeneratingPhase: 'idle' \| 'content' \| 'actions' \| 'tts'` (default `idle`) and `currentGeneratingStartedAt: number` + setters. Placed in the transient generation section beside `currentGeneratingOrder` — **excluded from `persistenceSnapshot`** (existing convention, avoids stale persisted phase). |
| 2 | `lib/hooks/use-scene-generator.ts` | Phase writes on both paths (`generateRemaining` serial consumption points + `retrySingleOutline`): before content await → `content`; before actions fetch → `actions`; before `generateTTSForScene` → `tts` (only when TTS will actually run); on scene landing / batch end / pause / abort → `idle`. `currentGeneratingStartedAt = Date.now()` written alongside `setCurrentGeneratingOrder`. Existing `onPhaseChange` callback untouched. |
| 3 | `components/canvas/generation-progress-panel.tsx` (new) | Self-subscribing panel: step indicator (content → actions → TTS; TTS step hidden when TTS disabled), page X/N (`currentGeneratingOrder + 1` / `outlines.length`), overall completion (`scenes.length` done / `generatingOutlines.length` remaining), media section (counts from `useMediaGenerationStore`, hidden when no tasks), mm:ss elapsed timer from `currentGeneratingStartedAt`, reassurance line after 30s. |
| 4 | `components/canvas/canvas-area.tsx` | Replace only the spinner+static-text else-branch (lines ~202-217) with `<GenerationProgressPanel />`. Failure and completion branches untouched. |
| 5 | `lib/i18n/locales/*.json` ×12 | New `stage.generationProgress.*` keys. |
| 6 | Tests ×3 | `tests/components/canvas/generation-progress-panel.test.tsx`, `tests/hooks/use-scene-generator-phase.test.ts`, `tests/i18n/generation-progress-locales.test.ts`. |

## 影响面 & 调用路径

(Grep/Read traced — repo `.codegraph/` index not built.)

- Render chain: `ClassroomSurface → Stage → PlaybackChromeRoot → CanvasArea`.
  `CanvasArea`'s only consumer is `PlaybackChromeRoot`; the panel self-subscribes
  to stores, so the `CanvasArea` props interface does not change and callers are
  untouched.
- `useSceneGenerator` consumers (`app/classroom/[id]/page.tsx`,
  `components/classroom/ClassroomSurface.tsx`) require **no changes** — phase
  flows through the store, not callbacks.
- The Pro workbench third pane hosts the same `ClassroomSurface` (pane
  variant), so the panel appears there too as a natural consequence of the
  shared component. No workbench-specific UI is built.
- `useMediaGenerationStore` is read-only here; no write paths change.
- **Risk addressed:** with parallel content pre-warm, the phase must follow the
  *serial consumption point* (where the loop awaits the outline's content),
  not the pre-warm kickoff, so the panel never shows a later page's phase while
  an earlier one is still assembling.

## 数据模型 / 迁移

None. Client-only transient state; IndexedDB untouched; no API changes.

## 接口设计

None. `/api/generate/*` request/response shapes unchanged (AC7).

## 项目规则遵循

- Repo has no `CLAUDE.md`; repo conventions apply:
  - i18n: all copy lands in all 12 locales; `pnpm check:i18n-keys` must pass.
  - Store: transient generation state stays out of the persistence snapshot.
  - Tests: mirror `tests/{components,hooks,i18n}/` existing layouts/patterns.
  - Self-checks adapted to this repo: `pnpm check:i18n-keys`, `pnpm test`
    (vitest), `pnpm lint`, `npx tsc --noEmit` (no repo typecheck script).
