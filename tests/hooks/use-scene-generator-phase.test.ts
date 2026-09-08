import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Stage } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  poolPut: vi.fn(),
  poolReplace: vi.fn(),
  poolRemove: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  toastWarning: vi.fn(),
  generateMediaForOutlines: vi.fn(),
  applyGeneratedAgentsToRegistry: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: mocks.settingsState,
  },
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      put: mocks.audioPut,
      delete: mocks.audioDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.poolPut,
  replaceAsset: mocks.poolReplace,
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: {
    getState: () => ({
      listAgents: mocks.listAgents,
    }),
  },
  applyGeneratedAgentsToRegistry: mocks.applyGeneratedAgentsToRegistry,
}));

vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: mocks.generateMediaForOutlines,
}));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

import { useStageStore } from '@/lib/store/stage';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';

const stage = { id: 'stage-1', title: 'Phase Course' } as unknown as Stage;

const outline1 = {
  id: 'outline-1',
  type: 'slide',
  title: 'First Scene',
  description: 'First',
  keyPoints: ['one'],
  order: 1,
} as SceneOutline;

const outline2 = {
  id: 'outline-2',
  type: 'slide',
  title: 'Second Scene',
  description: 'Second',
  keyPoints: ['two'],
  order: 2,
} as SceneOutline;

type GenerationParams = Parameters<
  ReturnType<typeof useSceneGenerator>['generateRemaining']
>[0];

const params: GenerationParams = {
  stageInfo: { name: 'Phase Course', language: 'English' },
};

function makeScene(order: number) {
  return {
    id: `scene-${order}`,
    stageId: 'stage-1',
    type: 'slide',
    title: `Scene ${order}`,
    order,
    content: { type: 'slide', canvas: { id: `canvas-${order}`, elements: [] } },
    actions: [],
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
  };
}

function contentSuccess() {
  return jsonResponse(200, { success: true, content: { elements: [] } });
}

function actionsSuccess(order: number) {
  return jsonResponse(200, {
    success: true,
    scene: makeScene(order),
    previousSpeeches: [],
  });
}

interface PhaseObservation {
  phase: string;
  startedAt: number;
  order: number;
}

/** Records every distinct consecutive phase transition with its store context. */
function recordPhases() {
  const seen: PhaseObservation[] = [];
  // Seed the dedup baseline with the phase AT SUBSCRIBE TIME so the listener's
  // first emission (any store write, not just phase writes) doesn't record the
  // leftover pre-run value as a fake transition.
  let last = useStageStore.getState().currentGeneratingPhase as string;
  useStageStore.subscribe((state) => {
    const phase = state.currentGeneratingPhase as string;
    if (phase === last) return;
    last = phase;
    seen.push({
      phase,
      startedAt: state.currentGeneratingStartedAt,
      order: state.currentGeneratingOrder,
    });
  });
  return seen;
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useStageStore.setState({
    stage,
    scenes: [],
    outlines: [outline1],
    generatingOutlines: [],
    failedOutlines: [],
    currentSceneId: null,
    mode: 'playback',
    generationStatus: 'idle',
    generationComplete: false,
    currentGeneratingOrder: -1,
    currentGeneratingPhase: 'idle',
    currentGeneratingStartedAt: 0,
    ...overrides,
  } as unknown as Parameters<typeof useStageStore.setState>[0]);
}

/** Renders a probe that captures the hook API (callbacks survive static render). */
function captureHook() {
  const captured: { api?: ReturnType<typeof useSceneGenerator> } = {};
  function Probe() {
    // eslint-disable-next-line react-hooks/immutability -- test probe deliberately captures the hook API during static render; effects never run there
    captured.api = useSceneGenerator();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!captured.api) throw new Error('hook api not captured');
  return captured.api;
}

describe('useSceneGenerator pipeline phase transitions', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset();
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset().mockResolvedValue('ast_audio_allocated');
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset();
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
    mocks.generateMediaForOutlines.mockReset().mockResolvedValue(undefined);
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsEnabled: true,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key', modelId: 'tts-model' } },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    seedStore();
  });

  it('walks content → actions → tts → idle on the happy path with TTS enabled', async () => {
    const api = captureHook();
    const seen = recordPhases();
    mockFetch
      .mockResolvedValueOnce(contentSuccess())
      .mockResolvedValueOnce(actionsSuccess(1));

    await api.generateRemaining(params);

    expect(seen.map((s) => s.phase)).toEqual(['content', 'actions', 'tts', 'idle']);
    const state = useStageStore.getState();
    expect(state.generationStatus).toBe('completed');
    expect(state.generationComplete).toBe(true);
    expect(state.currentGeneratingPhase).toBe('idle');
    expect(state.scenes).toHaveLength(1);
    // startedAt/order are seeded alongside the first content phase for the timer UI.
    expect(seen[0].startedAt).toBeGreaterThan(0);
    expect(seen[0].order).toBe(1);
  });

  it('never enters the tts phase when TTS is disabled', async () => {
    mocks.settingsState.mockReturnValue({
      ...mocks.settingsState(),
      ttsEnabled: false,
    });
    const api = captureHook();
    const seen = recordPhases();
    mockFetch
      .mockResolvedValueOnce(contentSuccess())
      .mockResolvedValueOnce(actionsSuccess(1));

    await api.generateRemaining(params);

    expect(seen.map((s) => s.phase)).toEqual(['content', 'actions', 'idle']);
    expect(useStageStore.getState().currentGeneratingPhase).toBe('idle');
  });

  it('resets the phase to idle when a serial content failure pauses the batch', async () => {
    const api = captureHook();
    const seen = recordPhases();
    // 401 is permanent — no retry, serial loop pauses.
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));

    await api.generateRemaining(params);

    expect(seen.map((s) => s.phase)).toEqual(['content', 'idle']);
    const state = useStageStore.getState();
    expect(state.generationStatus).toBe('paused');
    expect(state.currentGeneratingPhase).toBe('idle');
    expect(state.failedOutlines.map((o) => o.id)).toEqual(['outline-1']);
  });

  it('resets the phase to idle when stop() aborts an in-flight content fetch', async () => {
    const api = captureHook();
    const seen = recordPhases();
    let resolveContent!: (value: ReturnType<typeof contentSuccess>) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContent = resolve;
        }),
    );

    const generating = api.generateRemaining(params);
    await vi.waitFor(() => expect(seen.map((s) => s.phase)).toContain('content'));

    api.stop();
    resolveContent(contentSuccess());
    await generating;

    expect(seen[seen.length - 1].phase).toBe('idle');
    const state = useStageStore.getState();
    expect(state.generationStatus).toBe('paused');
    expect(state.currentGeneratingPhase).toBe('idle');
  });

  it('mirrors the phase transitions on retrySingleOutline and resets to idle', async () => {
    // A paused batch with two pending outlines leaves outline-1 failed and
    // primes lastParamsRef, exactly like the production retry flow.
    seedStore({ outlines: [outline1, outline2] });
    const api = captureHook();
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    await api.generateRemaining(params);
    expect(useStageStore.getState().failedOutlines).toHaveLength(1);

    const seen = recordPhases();
    // Retry (content + actions) then the auto-resumed run for outline-2.
    mockFetch
      .mockResolvedValueOnce(contentSuccess())
      .mockResolvedValueOnce(actionsSuccess(1))
      .mockResolvedValueOnce(contentSuccess())
      .mockResolvedValueOnce(actionsSuccess(2));

    await api.retrySingleOutline('outline-1');
    // The retry flow resumes the remaining outline WITHOUT awaiting it — wait
    // for the resumed run to land before asserting the full phase history.
    await vi.waitFor(() => {
      expect(useStageStore.getState().generationStatus).toBe('completed');
    });

    expect(seen.map((s) => s.phase)).toEqual([
      'content',
      'actions',
      'tts',
      'idle',
      // Resumed generateRemaining for the remaining outline-2.
      'content',
      'actions',
      'tts',
      'idle',
    ]);
    expect(seen[0].order).toBe(1);
    expect(seen[0].startedAt).toBeGreaterThan(0);
    const state = useStageStore.getState();
    expect(state.currentGeneratingPhase).toBe('idle');
    expect(state.scenes).toHaveLength(2);
    expect(state.generationStatus).toBe('completed');
  });

  it('resets the phase to idle when retry fails at the actions step', async () => {
    const api = captureHook();
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    await api.generateRemaining(params);

    const seen = recordPhases();
    mockFetch
      .mockResolvedValueOnce(contentSuccess())
      .mockResolvedValueOnce(jsonResponse(400, { error: 'actions rejected' }));

    await api.retrySingleOutline('outline-1');

    expect(seen.map((s) => s.phase)).toEqual(['content', 'actions', 'idle']);
    const state = useStageStore.getState();
    expect(state.currentGeneratingPhase).toBe('idle');
    expect(state.failedOutlines.map((o) => o.id)).toEqual(['outline-1']);
  });
});
