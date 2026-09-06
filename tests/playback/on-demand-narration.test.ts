import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateAndStoreTTS: vi.fn(),
}));

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  generateAndStoreTTS: mocks.generateAndStoreTTS,
}));

import { PlaybackEngine } from '@/lib/playback/engine';
import { useSettingsStore } from '@/lib/store/settings';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';

/**
 * Narration bytes live in the generating browser's local store (the server
 * asset pool is empty and documents still carry legacy tts_-ids), so a second
 * browser resolves nothing. The engine must regenerate the clip on demand
 * under the SAME id instead of silently skipping to the reading timer.
 */

function speechWithAudio(id: string, audioId: string, text = '你好世界，欢迎来到课堂。'): Action {
  return { id, type: 'speech', text, audioId } as SpeechAction;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function createActionEngine() {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

/** play() returns false for the first call (bytes missing) then `sequence`. */
function createAudioPlayer(sequence: boolean[] = []) {
  const calls: string[] = [];
  let ended: (() => void) | null = null;
  const outcomes = [...sequence];
  const player = {
    play: vi.fn(async (audioId: string) => {
      calls.push(audioId);
      return outcomes.length > 0 ? (outcomes.shift() as boolean) : false;
    }),
    onEnded: vi.fn((callback: () => void) => {
      ended = callback;
    }),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  } as unknown as AudioPlayer;
  return { player, calls, fireEnded: () => ended?.() };
}

function enableServerTTS(): void {
  const { ttsProvidersConfig } = useSettingsStore.getState();
  useSettingsStore.setState({
    ttsEnabled: true,
    ttsProviderId: 'minimax-tts',
    ttsProvidersConfig: {
      ...ttsProvidersConfig,
      'minimax-tts': { ...ttsProvidersConfig?.['minimax-tts'], enabled: true, apiKey: 'test-key' },
    },
  });
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('on-demand narration regeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateAndStoreTTS.mockReset();
    enableServerTTS();
  });

  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({ ttsEnabled: false });
  });

  it('regenerates a missing clip under its existing id and replays it', async () => {
    mocks.generateAndStoreTTS.mockResolvedValue('tts_s1_a');
    const actionEngine = createActionEngine();
    const { player, calls } = createAudioPlayer([false, true]);
    const engine = new PlaybackEngine(
      [scene([speechWithAudio('a', 'tts_s1_a')])],
      actionEngine,
      player,
    );

    engine.start();
    await flushPromises();

    // First attempt misses locally; regeneration reuses the document's id so
    // every later replay on this browser resolves the bytes directly.
    expect(mocks.generateAndStoreTTS).toHaveBeenCalledWith(
      'tts_s1_a',
      '你好世界，欢迎来到课堂。',
      undefined,
      undefined,
      undefined,
      'tts_s1_a',
      'stage-1',
    );
    expect(calls).toEqual(['tts_s1_a', 'tts_s1_a']);
  });

  it('caches a failed regeneration and falls back to the reading timer', async () => {
    vi.useFakeTimers();
    mocks.generateAndStoreTTS.mockRejectedValue(new Error('provider unavailable'));
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer([false]);
    const onSpeechEnd = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speechWithAudio('a', 'tts_s1_a')])],
      actionEngine,
      player,
      { onSpeechEnd },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.generateAndStoreTTS).toHaveBeenCalledTimes(1);

    // The reading timer carries the line when regeneration cannot.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);

    // A replay in the same session does not hammer the failing provider.
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.generateAndStoreTTS).toHaveBeenCalledTimes(1);
  });

  it('keeps the reading-timer path when TTS is disabled', async () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ ttsEnabled: false });
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer([false]);
    const onSpeechEnd = vi.fn();
    const engine = new PlaybackEngine(
      [scene([speechWithAudio('a', 'tts_s1_a')])],
      actionEngine,
      player,
      { onSpeechEnd },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.generateAndStoreTTS).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  it('does not regenerate for speech lines without a stored audio id', async () => {
    vi.useFakeTimers();
    const actionEngine = createActionEngine();
    const { player } = createAudioPlayer([false]);
    const engine = new PlaybackEngine(
      [scene([{ id: 'a', type: 'speech', text: '纯文本台词' } as SpeechAction])],
      actionEngine,
      player,
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.generateAndStoreTTS).not.toHaveBeenCalled();
  });
});
