import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    ttsEnabled: true,
    ttsProviderId: 'server-tts',
    ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key' } },
  } as Record<string, unknown>,
  ttsProviderEnabled: true,
  stageState: {} as Record<string, unknown>,
  mediaState: { tasks: {} as Record<string, unknown> },
}));

// English mirrors of the stage.generationProgress.* copy so assertions match
// what a user reads, while {{var}} interpolation behaves like the real i18n.
const translations: Record<string, string> = {
  'stage.generationProgress.title': 'Generating course content',
  'stage.generationProgress.stepContent': 'Writing content',
  'stage.generationProgress.stepActions': 'Arranging actions',
  'stage.generationProgress.stepTts': 'Synthesizing voiceover',
  'stage.generationProgress.pageProgress': 'Page {{page}} of {{total}}',
  'stage.generationProgress.completedCount': '{{count}} pages done',
  'stage.generationProgress.remainingCount': '{{count}} pages remaining',
  'stage.generationProgress.mediaGenerating': '{{count}} media generating',
  'stage.generationProgress.mediaDone': '{{count}} media done',
  'stage.generationProgress.reassurance': 'Still working, please hold on…',
};

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (translations[key] ?? key).replace(
        /\{\{(\w+)\}\}/g,
        (_, name: string) => String(options?.[name] ?? ''),
      ),
  }),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.settings),
    { getState: () => mocks.settings },
  ),
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: () => mocks.ttsProviderEnabled,
}));

// Plain-object stand-ins for the zustand stores: the real hooks read
// getInitialState() under server rendering (zustand v5), which would hide the
// seeded state from renderToStaticMarkup. The panel only needs the
// selector/getState surface, so a synchronous reader is equivalent here.
vi.mock('@/lib/store/stage', () => ({
  useStageStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector(mocks.stageState),
    {
      getState: () => mocks.stageState,
      setState: (partial: Record<string, unknown>) =>
        Object.assign(mocks.stageState, partial),
    },
  ),
}));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: Object.assign(
    (selector: (state: { tasks: Record<string, unknown> }) => unknown) =>
      selector(mocks.mediaState),
    { getState: () => mocks.mediaState },
  ),
}));

import { GenerationProgressPanel } from '@/components/canvas/generation-progress-panel';

const FIXED_NOW = new Date('2026-01-01T12:00:00Z').getTime();

function seedPanelStore(overrides: Record<string, unknown> = {}) {
  mocks.stageState = {
    stage: { id: 'stage-1', title: 'Course' },
    scenes: [
      { id: 'scene-1', order: 1 },
      { id: 'scene-2', order: 2 },
    ],
    outlines: [1, 2, 3, 4, 5].map((order) => ({ id: `outline-${order}`, order })),
    generatingOutlines: [3, 4, 5].map((order) => ({ id: `outline-${order}`, order })),
    failedOutlines: [],
    currentSceneId: null,
    mode: 'playback',
    generationStatus: 'generating',
    generationComplete: false,
    currentGeneratingOrder: 2,
    currentGeneratingPhase: 'actions',
    currentGeneratingStartedAt: FIXED_NOW - 5_000,
    ...overrides,
  };
}

function mediaTask(
  elementId: string,
  stageId: string,
  status: 'pending' | 'generating' | 'done' | 'failed',
) {
  return {
    elementId,
    type: 'image',
    status,
    prompt: 'a cat',
    params: {},
    retryCount: 0,
    stageId,
  };
}

function renderPanel() {
  return renderToStaticMarkup(createElement(GenerationProgressPanel));
}

function countState(markup: string, state: string): number {
  return markup.split(`data-state="${state}"`).length - 1;
}

describe('GenerationProgressPanel', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    mocks.settings = {
      ttsEnabled: true,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key' } },
    };
    mocks.ttsProviderEnabled = true;
    mocks.mediaState = { tasks: {} };
    seedPanelStore();
  });

  it('renders the step indicator, page progress, and completion counts', () => {
    const markup = renderPanel();

    expect(markup).toContain('Writing content');
    expect(markup).toContain('Arranging actions');
    expect(markup).toContain('Synthesizing voiceover');
    expect(markup).toContain('Page 3 of 5');
    expect(markup).toContain('2 pages done');
    expect(markup).toContain('3 pages remaining');
    // Phase `actions` → content is done, actions active, tts upcoming.
    expect(countState(markup, 'done')).toBe(1);
    expect(countState(markup, 'active')).toBe(1);
    expect(countState(markup, 'pending')).toBe(1);
    expect(markup).toContain('00:05');
  });

  it('hides the TTS step when TTS is disabled', () => {
    mocks.settings = { ...mocks.settings, ttsEnabled: false };
    const markup = renderPanel();

    expect(markup).not.toContain('Synthesizing voiceover');
    // Only the content + actions steps remain, content still done.
    expect(countState(markup, 'done')).toBe(1);
    expect(countState(markup, 'active')).toBe(1);
    expect(countState(markup, 'pending')).toBe(0);
  });

  it('shows media counts for the current stage only when tasks exist', () => {
    // No tasks at all → section hidden.
    expect(renderPanel()).not.toContain('data-testid="gen-progress-media"');

    // Tasks on a DIFFERENT stage → still hidden.
    mocks.mediaState = { tasks: { other: mediaTask('other', 'stage-9', 'generating') } };
    expect(renderPanel()).not.toContain('data-testid="gen-progress-media"');

    // Mixed tasks on this stage → in-progress/done counts shown, others ignored.
    mocks.mediaState = {
      tasks: {
        a: mediaTask('a', 'stage-1', 'generating'),
        b: mediaTask('b', 'stage-1', 'done'),
        other: mediaTask('other', 'stage-9', 'generating'),
      },
    };
    const markup = renderPanel();
    expect(markup).toContain('data-testid="gen-progress-media"');
    expect(markup).toContain('1 media generating');
    expect(markup).toContain('1 media done');
  });

  it('renders mm:ss elapsed from currentGeneratingStartedAt', () => {
    seedPanelStore({ currentGeneratingStartedAt: FIXED_NOW - 72_000 });
    expect(renderPanel()).toContain('01:12');
  });

  it('shows the reassurance line only after 30 seconds', () => {
    seedPanelStore({ currentGeneratingStartedAt: FIXED_NOW - 31_000 });
    expect(renderPanel()).toContain('Still working, please hold on…');

    seedPanelStore({ currentGeneratingStartedAt: FIXED_NOW - 29_999 });
    expect(renderPanel()).not.toContain('Still working, please hold on…');
  });

  it('omits the page label while no outline is being assembled', () => {
    seedPanelStore({ currentGeneratingOrder: -1, currentGeneratingStartedAt: 0 });
    const markup = renderPanel();

    expect(markup).not.toContain('Page 3 of 5');
    expect(markup).toContain('2 pages done');
    expect(markup).toContain('00:00');
  });
});
