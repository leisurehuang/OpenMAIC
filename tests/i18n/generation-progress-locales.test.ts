import { describe, it, expect } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'de-DE': deDE,
  'es-MX': esMX,
  'fr-FR': frFR,
  'ru-RU': ruRU,
  'pt-BR': ptBR,
  'vi-VN': viVN,
  'ar-SA': arSA,
};

// Keys introduced by the scene generation progress panel.
const KEYS = [
  'stage.generationProgress.title',
  'stage.generationProgress.stepContent',
  'stage.generationProgress.stepActions',
  'stage.generationProgress.stepTts',
  'stage.generationProgress.pageProgress',
  'stage.generationProgress.completedCount',
  'stage.generationProgress.remainingCount',
  'stage.generationProgress.mediaGenerating',
  'stage.generationProgress.mediaDone',
  'stage.generationProgress.reassurance',
];

// Interpolated copy must keep its placeholders in every locale.
const PLACEHOLDERS: Record<string, string[]> = {
  'stage.generationProgress.pageProgress': ['{{page}}', '{{total}}'],
  'stage.generationProgress.completedCount': ['{{count}}'],
  'stage.generationProgress.remainingCount': ['{{count}}'],
  'stage.generationProgress.mediaGenerating': ['{{count}}'],
  'stage.generationProgress.mediaDone': ['{{count}}'],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);

describe('Generation progress panel locale coverage', () => {
  it('every key exists, non-empty, and does not echo the key, in all 12 locales', () => {
    for (const [code, data] of Object.entries(locales)) {
      for (const k of KEYS) {
        const v = get(data, k);
        expect(typeof v, `${code} missing ${k}`).toBe('string');
        expect((v as string).trim(), `${code} empty ${k}`).not.toBe('');
        expect(v, `${code} echoes ${k}`).not.toBe(k);
      }
    }
  });

  it('interpolation placeholders survive translation in every locale', () => {
    for (const [code, data] of Object.entries(locales)) {
      for (const [k, placeholders] of Object.entries(PLACEHOLDERS)) {
        const v = String(get(data, k));
        for (const placeholder of placeholders) {
          expect(v, `${code} ${k} lost ${placeholder}`).toContain(placeholder);
        }
      }
    }
  });
});
