'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Fetches server-configured providers on mount and merges into settings store.
 * Renders nothing — purely a side-effect component.
 *
 * The fetch is gated on persist hydration: zustand fires this effect before
 * the KV adapter's first read resolves (a server round-trip on the cold
 * start), and the resulting `set()` would race that read — the KV write gate
 * refuses it with an "unhydrated" refusal and the merged server flags get
 * dropped instead of replayed (the store held defaults, not the stored
 * value). Waiting for `onFinishHydration` costs nothing — the merge lands on
 * authoritative state and writes straight through.
 */
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((state) => state.fetchServerProviders);

  useEffect(() => {
    const persist = useSettingsStore.persist;
    if (persist.hasHydrated()) {
      void fetchServerProviders();
      return;
    }
    let cancelled = false;
    const unsubscribe = persist.onFinishHydration(() => {
      if (cancelled) return;
      unsubscribe();
      void fetchServerProviders();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [fetchServerProviders]);

  return null;
}
