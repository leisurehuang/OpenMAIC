---
status: implementing
feature: scene-generation-progress-feedback
---

# Scene Generation Progress Feedback

## Why

During course generation on the classroom playback page, the canvas shows a bare
spinner with the static copy "场景正在生成，请稍候..." (`stage.generatingNextPage`) for
the entire wait. Users cannot tell what the AI is doing, which page is being
built, or how far along the batch is — a black-box loading state for a process
that regularly takes tens of seconds per page.

The raw signals already exist client-side: `useSceneGenerator` walks a
deterministic pipeline (content → actions → TTS, with media generation running
in parallel), the stage store tracks `currentGeneratingOrder`,
`generatingOutlines`, `scenes`, and the media store tracks per-element task
status. None of it reaches the UI.

## What Changes

- Replace the static pending overlay in the classroom canvas with a full
  **generation progress panel**: stage step indicator (content → actions → TTS),
  page progress (第 X / N 页), overall completion (done pages / queue
  remaining), parallel media status, elapsed time, and a long-wait reassurance
  line after 30s.
- Surface the pipeline phase as transient store state
  (`currentGeneratingPhase`, `currentGeneratingStartedAt`) written by
  `useSceneGenerator` at the serial consumption points; the panel subscribes
  directly — no prop drilling, no consumer changes.
- New `stage.generationProgress.*` i18n keys in all 12 locales.
- Purely client-side: no `/api/generate/*` changes, no streaming/SSE, no
  persistence changes. Failure overlay and course-complete overlay untouched.
