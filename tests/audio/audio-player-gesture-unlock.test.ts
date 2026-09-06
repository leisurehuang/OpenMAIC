import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAudioBlob: vi.fn(),
}));

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: mocks.resolveAudioBlob,
}));

import { AudioPlayer } from '@/lib/utils/audio-player';

/**
 * Safari rejects unmuted play() outside a user gesture, and narration is always
 * played from async chains. These tests pin the unlock machinery: one eager,
 * persistent element per player, primed with a silent WAV inside gestures, and
 * the "active" semantics that replaced element-existence checks.
 */

class AudioElementStub {
  static instances: AudioElementStub[] = [];
  src = '';
  currentTime = 0;
  paused = true;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preload = '';
  onended: (() => void) | null = null;
  readonly playCalls: string[] = [];

  constructor() {
    AudioElementStub.instances.push(this);
  }

  play(): Promise<void> {
    this.paused = false;
    this.playCalls.push(this.src);
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

function stubAudio(): typeof AudioElementStub {
  vi.stubGlobal('Audio', AudioElementStub as unknown as typeof Audio);
  return AudioElementStub;
}

function stubObjectUrl(): void {
  const realURL = globalThis.URL;
  class URLStub extends realURL {}
  Object.assign(URLStub, {
    createObjectURL: vi.fn(() => `blob:audio-${Math.random()}`),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal('URL', URLStub);
}

/** The test env is node, not jsdom: hand the module a gesture-capable window. */
function stubWindow(): EventTarget {
  const scope = new EventTarget();
  vi.stubGlobal('window', scope as unknown as Window & typeof globalThis);
  return scope;
}

function fireGesture(scope: EventTarget): void {
  scope.dispatchEvent(new Event('pointerdown'));
}

describe('AudioPlayer gesture unlock', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    stubAudio();
    stubObjectUrl();
    stubWindow();
    mocks.resolveAudioBlob.mockResolvedValue(new Blob(['bytes'], { type: 'audio/mpeg' }));
  });

  it('mints one persistent element and keeps active semantics across plays', async () => {
    const player = new AudioPlayer();
    // The constructor eagerly mints the (not yet primed) element.
    expect(AudioElementStub.instances).toHaveLength(1);

    expect(player.hasActiveAudio()).toBe(false);
    expect(await player.play('narration-1')).toBe(true);
    expect(player.hasActiveAudio()).toBe(true);
    expect(await player.play('narration-2')).toBe(true);
    // One element for the player's whole life, not one per play.
    expect(AudioElementStub.instances).toHaveLength(1);

    player.stop();
    expect(player.hasActiveAudio()).toBe(false);
    expect(player.isPlaying()).toBe(false);
    expect(player.getCurrentTime()).toBe(0);
    expect(player.getDuration()).toBe(0);
  });

  it('primes the idle element inside a user gesture, exactly once', async () => {
    const scope = stubWindow();
    const player = new AudioPlayer();
    fireGesture(scope);
    await Promise.resolve(); // let the prime settle

    const element = AudioElementStub.instances.at(-1)!;
    expect(element.playCalls).toHaveLength(1);
    expect(element.playCalls[0]).toMatch(/^data:audio\/wav/); // silent WAV, not narration
    expect(element.paused).toBe(true);
    expect(element.src).toBe(''); // primed src cleared again

    // A second gesture is a no-op for an already-primed element.
    fireGesture(scope);
    await Promise.resolve();
    expect(element.playCalls).toHaveLength(1);

    // And a real narration still plays through the same, primed element.
    expect(await player.play('narration-1')).toBe(true);
    expect(element.playCalls.at(-1)).toMatch(/^blob:/);
  });

  it('never primes an element holding live narration state', async () => {
    const scope = stubWindow();
    const player = new AudioPlayer();
    expect(await player.play('narration-1')).toBe(true);
    player.pause(); // paused mid-line: resumable position must survive

    const element = AudioElementStub.instances.at(-1)!;
    const srcBefore = element.src;
    fireGesture(scope);
    await Promise.resolve();

    expect(element.playCalls).toHaveLength(1); // only the real narration play
    expect(element.src).toBe(srcBefore);
    expect(player.hasActiveAudio()).toBe(true);
  });

  it('wires onEnded per play without stacking on the reused element', async () => {
    const player = new AudioPlayer();
    const ended = vi.fn();
    player.onEnded(ended);

    await player.play('narration-1');
    const element = AudioElementStub.instances.at(-1)!;
    await player.play('narration-2'); // replaces, does not stack

    element.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(player.hasActiveAudio()).toBe(false);
  });

  it('unregisters its prime hook on destroy', async () => {
    const scope = stubWindow();
    const player = new AudioPlayer();
    const element = AudioElementStub.instances.at(-1)!;
    player.destroy();
    const callsBefore = element.playCalls.length;

    fireGesture(scope);
    await Promise.resolve();
    expect(element.playCalls).toHaveLength(callsBefore);
  });
});
