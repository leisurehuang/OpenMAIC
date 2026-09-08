'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore, type GenerationPhase } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Long-wait threshold before the reassurance line appears (ms). */
const REASSURANCE_AFTER_MS = 30_000;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

interface StepDefinition {
  readonly phase: GenerationPhase;
  readonly label: string;
}

/**
 * Live generation progress panel shown in place of the former static
 * "generating next page" spinner while a scene is being assembled.
 *
 * Self-subscribes to the stage / media / settings stores — no props, no
 * consumer changes. All progress signals are written by `useSceneGenerator`
 * at the serial consumption points, so what the user sees is always the
 * outline currently being assembled (never a parallel pre-warm kickoff).
 */
export function GenerationProgressPanel() {
  const { t } = useI18n();
  const phase = useStageStore((s) => s.currentGeneratingPhase);
  const currentOrder = useStageStore((s) => s.currentGeneratingOrder);
  const totalOutlines = useStageStore((s) => s.outlines.length);
  const doneCount = useStageStore((s) => s.scenes.length);
  const remainingCount = useStageStore((s) => s.generatingOutlines.length);
  const startedAt = useStageStore((s) => s.currentGeneratingStartedAt);
  const stageId = useStageStore((s) => s.stage?.id);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);

  // Mirror the generator's TTS gate exactly so the step is only offered when
  // the phase can actually reach `tts`.
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsActive =
    ttsEnabled &&
    ttsProviderId !== 'browser-native-tts' &&
    isTTSProviderEnabled(ttsProviderId, ttsProvidersConfig?.[ttsProviderId]);

  const steps: readonly StepDefinition[] = [
    { phase: 'content', label: t('stage.generationProgress.stepContent') },
    { phase: 'actions', label: t('stage.generationProgress.stepActions') },
    ...(ttsActive
      ? [{ phase: 'tts' as const, label: t('stage.generationProgress.stepTts') }]
      : []),
  ];
  const activeStepIndex = steps.findIndex((step) => step.phase === phase);

  // Elapsed time ticks once per second; the initial value renders immediately
  // so the panel never shows 00:00 for an already-long wait.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  const showReassurance = elapsedMs >= REASSURANCE_AFTER_MS;

  const stageTasks = stageId
    ? Object.values(mediaTasks).filter((task) => task.stageId === stageId)
    : [];
  const mediaGenerating = stageTasks.filter(
    (task) => task.status === 'pending' || task.status === 'generating',
  ).length;
  const mediaDone = stageTasks.filter((task) => task.status === 'done').length;
  const showMediaSection = stageTasks.length > 0;

  const pageLabel =
    currentOrder >= 0 && totalOutlines > 0
      ? t('stage.generationProgress.pageProgress', {
          page: currentOrder + 1,
          total: totalOutlines,
        })
      : null;

  return (
    <div className="flex flex-col items-center gap-4 max-w-md px-6 text-center">
      {/* Spinner */}
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full border-2 border-gray-100 dark:border-gray-700" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 dark:border-t-purple-400 animate-spin" />
      </div>

      {/* Title */}
      <span className="text-sm text-gray-600 dark:text-gray-300 font-medium">
        {t('stage.generationProgress.title')}
      </span>

      {/* Step indicator */}
      <div className="flex items-center gap-2" data-testid="gen-progress-steps">
        {steps.map((step, index) => {
          const isActive = index === activeStepIndex;
          const isDone = activeStepIndex >= 0 && index < activeStepIndex;
          return (
            <div key={step.phase} className="flex items-center gap-2">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'w-6 h-px',
                    isDone || isActive
                      ? 'bg-purple-300 dark:bg-purple-500/60'
                      : 'bg-gray-200 dark:bg-gray-700',
                  )}
                />
              )}
              <div
                className="flex items-center gap-1.5"
                data-state={isDone ? 'done' : isActive ? 'active' : 'pending'}
              >
                {isDone ? (
                  <span className="w-4 h-4 rounded-full bg-purple-100 dark:bg-purple-500/20 flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 text-purple-500 dark:text-purple-400" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      'w-4 h-4 rounded-full border flex items-center justify-center',
                      isActive
                        ? 'border-purple-400 dark:border-purple-400'
                        : 'border-gray-300 dark:border-gray-600',
                    )}
                  >
                    {isActive && (
                      <motion.span
                        className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400"
                        animate={{ opacity: [1, 0.35, 1] }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    )}
                  </span>
                )}
                <span
                  className={cn(
                    'text-xs font-medium',
                    isActive
                      ? 'text-purple-600 dark:text-purple-400'
                      : isDone
                        ? 'text-gray-500 dark:text-gray-400'
                        : 'text-gray-400 dark:text-gray-500',
                  )}
                >
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Page progress + overall completion */}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        {pageLabel && <span data-testid="gen-progress-page">{pageLabel}</span>}
        <span data-testid="gen-progress-completion">
          {t('stage.generationProgress.completedCount', { count: doneCount })}
          {' · '}
          {t('stage.generationProgress.remainingCount', { count: remainingCount })}
        </span>
      </div>

      {/* Parallel media generation */}
      {showMediaSection && (
        <div
          className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500"
          data-testid="gen-progress-media"
        >
          <span>{t('stage.generationProgress.mediaGenerating', { count: mediaGenerating })}</span>
          <span aria-hidden="true">·</span>
          <span>{t('stage.generationProgress.mediaDone', { count: mediaDone })}</span>
        </div>
      )}

      {/* Elapsed time */}
      <span
        className="text-xs tabular-nums text-gray-400 dark:text-gray-500"
        data-testid="gen-progress-elapsed"
      >
        {formatElapsed(elapsedMs)}
      </span>

      {/* Long-wait reassurance */}
      {showReassurance && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-xs text-gray-400 dark:text-gray-500"
          data-testid="gen-progress-reassurance"
        >
          {t('stage.generationProgress.reassurance')}
        </motion.p>
      )}
    </div>
  );
}
