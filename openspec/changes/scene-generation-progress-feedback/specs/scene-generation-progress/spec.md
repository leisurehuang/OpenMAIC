# Scene Generation Progress capability delta

## ADDED Requirements

### Requirement: Generation progress panel replaces the static pending overlay

While a scene is generating on the classroom playback page, the system SHALL
replace the spinner-plus-static-text pending overlay in the canvas with a
generation progress panel composed of: a stage step indicator, page progress,
overall completion, parallel media status, elapsed time, and a long-wait
reassurance line.

#### Scenario: Panel visible while the pending scene is the current scene

- **WHEN** the current scene is the pending slot and a scene is generating
- **THEN** the progress panel renders in place of the former spinner overlay
- **AND** the failure overlay and the course-complete overlay are unchanged in
  appearance and behavior

### Requirement: Page progress and overall completion

The panel SHALL show which page is generating (第 X / N 页) and the batch-level
completion (completed page count and remaining queue count), derived from
`currentGeneratingOrder`, `outlines`, `scenes`, and `generatingOutlines`.

#### Scenario: Page numbers reflect the generating outline

- **WHEN** the generator is working on the outline at order X of N total
- **THEN** the panel shows 第 (X+1) / N 页 style progress

#### Scenario: Completion counts update as scenes land

- **WHEN** a scene is added to the store
- **THEN** the completed count and remaining queue count update immediately

### Requirement: Stage step indicator follows the serial pipeline

The panel SHALL show a step indicator for the stages 撰写内容 → 编排动作 → 合成配音
with the current stage highlighted, driven by a transient
`currentGeneratingPhase` store field written by `useSceneGenerator`.

#### Scenario: Phase transitions

- **WHEN** the serial loop starts fetching a scene's content, then actions,
  then TTS
- **THEN** the phase becomes `content`, then `actions`, then `tts`, and the
  step indicator highlights the matching stage

#### Scenario: TTS-disabled courses

- **WHEN** TTS is disabled or the provider is not enabled
- **THEN** the TTS step is hidden and the phase never enters `tts`

#### Scenario: Parallel content pre-warm does not skew the indicator

- **WHEN** parallel scene content fetches are pre-warmed ahead of the serial
  consumption loop
- **THEN** the phase still follows the serial consumption point (the outline
  currently being assembled), not the pre-warm start

#### Scenario: Phase resets

- **WHEN** a scene lands, the batch completes, or generation pauses/aborts
- **THEN** `currentGeneratingPhase` resets to `idle`

### Requirement: Parallel media status section

The panel SHALL show a media section with in-progress and completed counts from
the media generation store when media tasks exist for the stage.

#### Scenario: Media section visibility

- **WHEN** there are media tasks for the current stage
- **THEN** the section shows generating/done counts
- **WHEN** there are no media tasks
- **THEN** the section is hidden

### Requirement: Elapsed time and long-wait reassurance

The panel SHALL show the elapsed time (mm:ss) since the current page's
generation started (from a transient `currentGeneratingStartedAt` timestamp),
and after 30 seconds SHALL display a reassurance line.

#### Scenario: Elapsed timer

- **WHEN** the panel is visible and the current page has been generating for
  72 seconds
- **THEN** the timer shows 01:12

#### Scenario: Reassurance after threshold

- **WHEN** the current page has been generating for more than 30 seconds
- **THEN** a reassurance line appears below the step indicator

### Requirement: Pure client-side implementation with full locale coverage

The feature SHALL be implemented entirely client-side (no `/api/generate/*`
request or protocol changes, no streaming) and all user-facing copy SHALL be
added to every locale file in `lib/i18n/locales/`.

#### Scenario: No server changes

- **WHEN** the feature is complete
- **THEN** no server route, request body, or response shape has changed

#### Scenario: Locale completeness

- **WHEN** `pnpm check:i18n-keys` runs
- **THEN** all new keys resolve in all 12 locales
