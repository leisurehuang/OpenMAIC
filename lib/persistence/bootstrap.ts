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
 * 登录认证探测结果。
 * - `'disabled'`：构建期未启用登录认证（开发令牌模式，无需探测）。
 * - `'signed-out'`：登录认证开启，且 `/api/auth/me` 明确报告没有登录用户
 *   （HTTP 200 且 `user` 为空）。这是服务端给出的确定性结论；区别于下面
 *   的探测失败——网络故障或 5xx 不能算登出，否则一次抖动就会让客户端把
 *   account 数据悄悄写到本机，等服务端恢复后又被服务端旧值遮蔽。
 * - `'probe-failed'`：`/api/auth/me` 不可达或非 2xx。结论未知，保持原有
 *   行为：请求服务端，失败如实上报。
 * - 字符串：已登录用户的学习者分区键（`user:<id>`）。
 */
export type LoginAuthProbe = 'disabled' | 'signed-out' | 'probe-failed' | (string & {});

let loginAuthProbePromise: Promise<LoginAuthProbe> | undefined;

function probeLoginAuth(): Promise<LoginAuthProbe> {
  const enabled = /^(1|true)$/i.test((process.env.NEXT_PUBLIC_AUTH_REQUIRED ?? '').trim());
  if (!enabled) return Promise.resolve('disabled');
  // 按页面缓存一次：登录 / 注册 / 登出都伴随整页跳转（页面级缓存不会跨
  // 身份切换失效），而每次 KV 读写都重新探测会把 /api/auth/me 变成热点。
  loginAuthProbePromise ??= fetch('/api/auth/me', { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return 'probe-failed' as const;
      const body = (await res.json().catch(() => null)) as
        | { user?: { id?: string; name?: string; learnerKey?: string } | null }
        | null;
      const learnerKey = body?.user?.learnerKey;
      return typeof learnerKey === 'string' && learnerKey ? learnerKey : ('signed-out' as const);
    })
    .catch(() => 'probe-failed' as const);
  return loginAuthProbePromise;
}

/**
 * 登录认证开启且服务端明确报告未登录（登录页 / 登出后 / 会话已失效）。
 *
 * 此时 account 作用域不应再请求服务端 KV：认证中间件对未登录请求一律
 * 401，持久化层会把它当成存储故障，向用户弹出“更改未被保存”的告警。
 * 消费方（browser-kv）据此把 account 读写留在本机 localStorage，登录后
 * 整页跳转重新探测，再回到服务端并走既有迁移路径回填。
 */
export async function isLoginAuthSignedOut(): Promise<boolean> {
  return (await probeLoginAuth()) === 'signed-out';
}

function loginLearnerKey(): Promise<string | undefined> {
  return probeLoginAuth().then((probe) =>
    probe === 'disabled' || probe === 'signed-out' || probe === 'probe-failed' ? undefined : probe,
  );
}

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
