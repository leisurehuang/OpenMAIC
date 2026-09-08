import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 登录认证部署中“未登录”状态下的 account 作用域 KV 行为。
 *
 * 未登录（登录页 / 登出后 / 会话失效）时服务端中间件对 /api/persistence
 * 一律 401；若客户端仍请求服务端 KV，持久化层（kv-persist 的 KeyState）
 * 会把它当存储故障上报，向用户弹出“更改未被保存”告警。期望：探测到
 * signed-out 后 account 读写全部留在本机 localStorage，不发任何
 * /api/persistence 请求；探测失败（网络 / 5xx）则保持原有服务端路径。
 */

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => void values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

interface FetchLog {
  meCalls: number;
  persistenceCalls: string[];
}

function stubFetch(
  meResponse: () => Response | Promise<Response>,
  persistenceResponse?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): FetchLog {
  const log: FetchLog = { meCalls: 0, persistenceCalls: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        log.meCalls += 1;
        return meResponse();
      }
      if (url.startsWith('/api/persistence')) {
        log.persistenceCalls.push(`${init?.method ?? 'GET'} ${url}`);
        return (
          persistenceResponse?.(url, init) ??
          Response.json({ error: { code: 'UNAUTHENTICATED', message: 'auth required' } }, { status: 401 })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return log;
}

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status });

describe('browser-kv account scope under login auth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // RootLayout SSR 注入的服务端配置标志：模拟配了 DATABASE_URL 的部署。
    vi.stubGlobal('window', { __OPENMAIC_PERSISTENCE_CONFIGURED__: true });
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('keeps account reads and writes local when the server says no user is signed in', async () => {
    const log = stubFetch(() => jsonResponse({ success: true, user: null }));
    const { createDefaultAppKVStore } = await import('@/lib/persistence/browser-kv');
    const { subscribeToPersistHealth } = await import('@/lib/store/persist-health');

    const healthEvents: string[] = [];
    const unsubscribe = subscribeToPersistHealth((event) =>
      healthEvents.push(`${event.name}:${event.status}`),
    );

    const kv = createDefaultAppKVStore();
    expect(await kv.get('settings-storage', 'account')).toBeNull();
    await kv.set('settings-storage', { state: { theme: 'dark' }, version: 1 }, 'account');
    expect(await kv.get<{ state: { theme: string } }>('settings-storage', 'account')).toEqual({
      state: { theme: 'dark' },
      version: 1,
    });
    expect(await kv.keys('', 'account')).toEqual(['settings-storage']);
    await kv.remove('settings-storage', 'account');
    expect(await kv.get('settings-storage', 'account')).toBeNull();

    // 认证探测只发生一次（按页面缓存），且全程没有任何服务端 KV 请求。
    expect(log.meCalls).toBe(1);
    expect(log.persistenceCalls).toEqual([]);
    // 本地读写不应触发任何持久化健康事件（那是两条用户可见告警的来源）。
    expect(healthEvents).toEqual([]);
    unsubscribe();
  });

  it('still serves authenticated account traffic from the server', async () => {
    const log = stubFetch(
      () => jsonResponse({ success: true, user: { id: 'u1', name: 'a', learnerKey: 'user:u1' } }),
      (url, init) =>
        init?.method === 'PUT'
          ? new Response(null, { status: 204 })
          : url.includes('/kv/keys')
            ? jsonResponse(['settings-storage'])
            : jsonResponse({ value: { state: { theme: 'light' } } }),
    );
    const { createDefaultAppKVStore } = await import('@/lib/persistence/browser-kv');

    const kv = createDefaultAppKVStore();
    expect(await kv.get<{ state: { theme: string } }>('settings-storage', 'account')).toEqual({
      state: { theme: 'light' },
    });
    await kv.set('settings-storage', { state: { theme: 'blue' }, version: 1 }, 'account');
    expect(await kv.keys('', 'account')).toEqual(['settings-storage']);

    expect(log.meCalls).toBe(1);
    expect(log.persistenceCalls.length).toBeGreaterThan(0);
    expect(log.persistenceCalls.every((entry) => entry.startsWith('GET ') || entry.startsWith('PUT '))).toBe(true);
  });

  it('falls back to the server path (old behavior) when the auth probe fails', async () => {
    const log = stubFetch(() => jsonResponse({ error: 'boom' }, 500), () =>
      jsonResponse({ value: { probe: 'server' } }),
    );
    const { createDefaultAppKVStore } = await import('@/lib/persistence/browser-kv');

    const kv = createDefaultAppKVStore();
    // 探测失败 ≠ 登出：仍走服务端，让真实故障如实上报。
    expect(await kv.get<{ probe: string }>('settings-storage', 'account')).toEqual({
      probe: 'server',
    });
    expect(log.persistenceCalls).toEqual([
      // 运行时探测（页面级缓存一次）：确认服务端配了持久化。
      'GET /api/persistence/kv/keys?prefix=__probe__',
      'GET /api/persistence/kv/entries/settings-storage',
    ]);
  });
});
