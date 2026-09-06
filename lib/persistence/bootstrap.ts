import { BrowserKVStore, HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';

let deviceKv: BrowserKVStore | undefined;
let learnerKeyPromise: Promise<string> | undefined;

export function isBrowserPersistenceEnabled(): boolean {
  return typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1';
}

/**
 * Build-time opt-in for single-library deployments: when set, every browser
 * resolves the same learner partition instead of a per-device anonymous key,
 * so account-scoped settings (provider/model configuration) sync across the
 * trusted learning group. Must be empty for per-learner deployments.
 */
function sharedLearnerKeyOverride(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SHARED_LEARNER_KEY;
  return raw?.trim() || undefined;
}

/**
 * 登录认证模式（NEXT_PUBLIC_AUTH_REQUIRED 编译期开关）：学习者分区来自
 * 服务端验证的会话（/api/auth/me），设置跟随登录用户而非浏览器——
 * 同一账户在不同设备上看到同一套配置。优先级：登录用户 > 共享键 > 匿名设备键。
 */
function loginLearnerKey(): Promise<string | undefined> {
  const enabled = /^(1|true)$/i.test((process.env.NEXT_PUBLIC_AUTH_REQUIRED ?? '').trim());
  if (!enabled) return Promise.resolve(undefined);
  authLearnerKeyPromise ??= fetch('/api/auth/me', { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return undefined;
      const body = (await res.json().catch(() => null)) as
        | { user?: { id?: string; name?: string; learnerKey?: string } | null }
        | null;
      const learnerKey = body?.user?.learnerKey;
      return typeof learnerKey === 'string' && learnerKey ? learnerKey : undefined;
    })
    .catch(() => undefined);
  return authLearnerKeyPromise;
}

let authLearnerKeyPromise: Promise<string | undefined> | undefined;

export function getPersistenceLearnerKey(): Promise<string> {
  if (!isBrowserPersistenceEnabled()) {
    return Promise.reject(new Error('Browser persistence is not enabled'));
  }
  if (learnerKeyPromise) return learnerKeyPromise;
  learnerKeyPromise = (async () => {
    const loginKey = await loginLearnerKey();
    if (loginKey) return loginKey;
    const shared = sharedLearnerKeyOverride();
    if (shared) return shared;
    return getLearnerKey((deviceKv ??= new BrowserKVStore()));
  })().catch(
    (error) => {
      learnerKeyPromise = undefined;
      throw error;
    },
  );
  return learnerKeyPromise;
}

export async function getPersistenceRequestHeaders(): Promise<Record<string, string>> {
  if (!isBrowserPersistenceEnabled()) return {};
  const resolvedLearnerKey = await getPersistenceLearnerKey();
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': resolvedLearnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

if (isBrowserPersistenceEnabled()) {
  const learnerKey = getPersistenceLearnerKey;
  const headers = getPersistenceRequestHeaders;

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };
  try {
    // All checks are mutation-free. Once they pass, the synchronous configure
    // calls cannot leave only a subset of the persistence seams configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
