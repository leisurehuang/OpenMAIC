/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations.
 * Resolves pre-generated TTS audio bytes pool-first through the shared read
 * path, with the Dexie `audioFiles` table as the legacy fallback.
 *
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

/**
 * A 44-byte 8 kHz mono WAV holding a single zero sample. Playing it is
 * inaudible, but on Safari it is the standard way to unlock an audio element
 * for later programmatic playback: unmuted `play()` outside a user gesture is
 * rejected there (even seconds after an earlier click — Chrome only requires
 * that the user interacted with the page at some point), and narration is
 * played from async chains (IndexedDB reads, TTS fetches) that can never keep
 * the gesture's call stack. Priming the element itself inside a gesture is
 * what unlocks it; a primed element stays unlocked across later `src` swaps.
 */
const SILENT_PRIME_WAV_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

/** Elements already primed inside some gesture; a WeakSet keeps the registry
 * GC-friendly without touching element identity. */
const primedElements = new WeakSet<object>();
/** Live prime hooks, one per AudioPlayer instance with an element. */
const primeHooks = new Set<() => void>();
/** The window the gesture listeners are installed on, if any. */
let unlockWindow: Window | undefined;

/**
 * Install the global gesture listeners once per window. Every
 * `pointerdown`/`keydown` re-broadcasts: elements minted after the first
 * gesture are caught by the next one, and hooks no-op in a microtask once
 * their element is primed.
 */
function installUnlockListeners(): void {
  if (typeof window === 'undefined' || unlockWindow === window) return;
  unlockWindow = window;
  const broadcast = (): void => {
    for (const hook of primeHooks) hook();
  };
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, broadcast, { capture: true, passive: true });
  }
}

/**
 * Register a per-instance prime hook; returns its unsubscriber.
 *
 * The hook (not a bare element) is what gets registered because priming must
 * consult the player's live playback state: an element holding a paused
 * narration position has already played real audio — it is unlocked, and
 * priming it would silently discard the resumable position.
 */
function registerAudioPrimeHook(hook: () => void): () => void {
  primeHooks.add(hook);
  installUnlockListeners();
  return () => {
    primeHooks.delete(hook);
  };
}

/** How long a legacy narration URL fetch may take before the media element
 * fallback takes over. Bounded like the converter's URL probes: one stalled
 * endpoint must not pin a playback line indefinitely. */
const LEGACY_URL_FETCH_TIMEOUT_MS = 15_000;

/** Bytes an audio id currently resolves to, pool first. Loaded lazily to keep
 * this module importable without the media graph. */
async function resolveBytes(audioId: string): Promise<Blob | null> {
  try {
    const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
    return await resolveAudioBlob(audioId);
  } catch {
    return null;
  }
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  /**
   * The one element this player reuses for every narration. A fresh element
   * per play would re-enter Safari's locked state each time (see
   * {@link SILENT_PRIME_WAV_URL}); a persistent element keeps whatever unlock
   * the first gesture granted it.
   */
  private audio: HTMLAudioElement | null = null;
  /**
   * Whether the element holds narration state (playing or paused mid-line,
   * not ended/stopped). This, not element existence, is what callers mean by
   * "has active audio" now that the element persists.
   */
  private active = false;
  private readonly unregisterPrimeHook: () => void;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private requestToken: number = 0;
  /** The object URL backing the current audio element, if any. */
  private blobUrl: string | null = null;
  /**
   * The in-flight legacy narration fetch of the current play, if any. Aborted
   * when the play is superseded (a replacement play, stop, or destroy), so a
   * stale fetch is cancelled at the network layer instead of settling before
   * its supersession is noticed.
   */
  private fetchAbort: AbortController | null = null;

  /** Abort the in-flight legacy narration fetch, if one exists. */
  private abortLegacyFetch(): void {
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }
  }

  /**
   * Revoke an object URL this player created, forgetting it when it is still
   * the current source. Idempotent: natural end, rejected play, stop, and
   * replacement each call it once for their own URL.
   */
  private releaseBlobUrl(blobUrl: string | null | undefined): void {
    if (!blobUrl) return;
    URL.revokeObjectURL(blobUrl);
    if (this.blobUrl === blobUrl) this.blobUrl = null;
  }

  /** The persistent element, minted (and gesture-primable) on first use. */
  private ensureAudioElement(): HTMLAudioElement {
    if (!this.audio) {
      const element = new Audio();
      element.preload = 'auto';
      this.audio = element;
    }
    return this.audio;
  }

  /**
   * Prime the element inside a user gesture if it is idle, so a later async
   * `play()` is not rejected by Safari's autoplay policy. A no-op once primed,
   * while narration is loaded, or when this browser imposes no such policy.
   */
  private primeIfIdle(): void {
    const element = this.audio;
    if (!element || this.active || primedElements.has(element)) return;
    if (element.src === SILENT_PRIME_WAV_URL) return; // a prime is already in flight
    element.src = SILENT_PRIME_WAV_URL;
    const settle = (): void => {
      primedElements.add(element);
      if (element.src === SILENT_PRIME_WAV_URL) {
        element.pause();
        element.removeAttribute('src');
      }
    };
    // Old Safari returns undefined from play(); both shapes settle the prime.
    const started = element.play();
    if (started && typeof started.then === 'function') {
      started.then(settle, () => {
        // The policy still blocks this element (or the decode failed); a
        // later gesture retries — nothing is cached as unlocked.
      });
    } else {
      settle();
    }
  }

  constructor() {
    // Mint the element eagerly: the first narration play() is always async
    // (byte resolution first), so the ONLY chance to prime the element inside
    // the starting gesture is for it to already exist when that gesture fires.
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.unregisterPrimeHook = registerAudioPrimeHook(() => this.primeIfIdle());
  }

  private stopAudioElement(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.onended = null;
    }
    this.active = false;
    // Stop or replacement before natural end must not leak the fetched
    // narration: the position is dropped here, so its URL is released with it.
    this.releaseBlobUrl(this.blobUrl);
  }

  /**
   * Play audio for a speech reference.
   *
   * The reference is resolved pool-first through the shared read path, so a
   * stable-id regeneration whose mirror write failed does not keep serving
   * superseded narration; the Dexie `audioFiles` table remains the fallback
   * for legacy and imported rows that were never pool-backed.
   *
   * Conversion to allocated ids is best-effort: a document whose conversion
   * was skipped (the lock-free load path) or deferred (a transient fetch
   * failure) still holds its legacy pair, and an `audioId` with no local
   * bytes is not silence while the URL beside it may still be live. That URL
   * is the fallback of last resort, fetched at playback time; a converted
   * document never carries one.
   *
   * @param audioId Audio asset reference (allocated asset id, or a legacy TTS-derived id)
   * @param legacyUrl The legacy `audioUrl` of an unconverted pair, if present
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, legacyUrl?: string): Promise<boolean> {
    const requestToken = ++this.requestToken;
    // A new play supersedes any in-flight legacy fetch of the previous one.
    this.abortLegacyFetch();
    try {
      let blob = await resolveBytes(audioId);
      if (requestToken !== this.requestToken) return false;

      let directUrl: string | undefined;
      if (!blob && legacyUrl) {
        const controller = new AbortController();
        this.fetchAbort = controller;
        const timeout = setTimeout(() => controller.abort(), LEGACY_URL_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(legacyUrl, { signal: controller.signal });
          const fetched = response.ok ? await response.blob() : null;
          // Zero-byte responses are not narration: fall back to the URL so a
          // later attempt can retry, and never play silence.
          if (fetched && fetched.size > 0) blob = fetched;
        } catch {
          blob = null;
        } finally {
          clearTimeout(timeout);
          if (this.fetchAbort === controller) this.fetchAbort = null;
        }
        if (requestToken !== this.requestToken) return false;
        if (!blob) {
          // A cross-origin legacy URL without CORS headers cannot be fetched,
          // but a media element is not CORS-bound: hand it the URL directly.
          // A superseded play never reaches here -- the token check above
          // already returned false -- so only ordinary fetch/CORS/timeout
          // failures fall back to the element.
          directUrl = legacyUrl;
        }
      }

      if (!blob && !directUrl) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Stop current playback (the element itself persists — see class docs)
      this.stopAudioElement();
      if (requestToken !== this.requestToken) return false;

      // Create/reuse audio element
      const audio = this.ensureAudioElement();

      // Set audio source
      const blobUrl = blob ? URL.createObjectURL(blob) : undefined;
      this.blobUrl = blobUrl ?? null;
      audio.src = blobUrl ?? (directUrl as string);
      if (this.muted) audio.volume = 0;
      else audio.volume = this.volume;

      // Apply playback rate
      audio.defaultPlaybackRate = this.playbackRate;
      audio.playbackRate = this.playbackRate;

      // Set ended callback. Property assignment, not addEventListener: the
      // element is reused across plays, so a listener would stack once per
      // narration; assignment replaces.
      audio.onended = () => {
        this.active = false;
        this.releaseBlobUrl(blobUrl);
        this.onEndedCallback?.();
      };

      // Play. If play() rejects (autoplay policy, decode error, interrupted
      // load) the 'ended' handler never fires, so revoke the blob URL here to
      // avoid leaking it for the lifetime of the document.
      try {
        await audio.play();
      } catch (playError) {
        this.releaseBlobUrl(blobUrl);
        throw playError;
      }
      if (requestToken !== this.requestToken) {
        this.releaseBlobUrl(blobUrl);
        return false;
      }
      this.active = true;
      // Re-apply after play() — some browsers reset during load
      audio.playbackRate = this.playbackRate;
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    this.requestToken += 1;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    this.requestToken += 1;
    // Cancel a still-fetching legacy narration instead of waiting for it to
    // settle: the play was superseded and its result is unwanted.
    this.abortLegacyFetch();
    this.stopAudioElement();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.active && this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused && this.active;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.active;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.active && this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.active && this.audio && !isNaN(this.audio.duration)
      ? this.audio.duration * 1000
      : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
    this.unregisterPrimeHook();
    this.audio = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
