import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * account 作用域 KV 的服务端唯一存储契约。
 *
 * account 数据（用户设置）只存服务端，浏览器不保留任何本地副本：
 * 未登录（登录页 / 登出后 / 会话失效）或服务端未配置持久化时，account
 * 读写是静默 no-op——读为空、写丢弃、不发任何 /api/persistence 请求
 * （未登录时请求只会拿到 401，被持久化层误报成「更改未被保存」）。
 * 探测失败（网络 / 5xx）≠ 登出：保持服务端路径，让真实故障如实上报。
 * device 作用域永远留在本机 localStorage；遗留的本机 account 副本在
 * 创建默认 KVStore 时一次性清除。
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
    vi.stubGlobal('window', {
      __OPENMAIC_PERSISTENCE_CONFIGURED__: true,
      localStorage: memoryStorage(),
    });
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('turns account reads and writes into no-ops when no user is signed in', async () => {
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
    // 写被丢弃：不落本地，也没有任何服务端 entries 请求。
    expect(await kv.get('settings-storage', 'account')).toBeNull();
    expect(await kv.keys('', 'account')).toEqual([]);
    await kv.remove('settings-storage', 'account');
    expect(localStorage.getItem('maic:account:settings-storage')).toBeNull();

    // 认证探测只发生一次（按页面缓存）；KV 面仅有冷启动预热的可用性
    // 探测一次（未登录时它拿 401，但结论不影响 no-op 的决定）。
    expect(log.meCalls).toBe(1);
    expect(log.persistenceCalls).toEqual(['GET /api/persistence/kv/keys?prefix=__probe__']);
    // no-op 不应触发任何持久化健康事件（那是两条用户可见告警的来源）。
    expect(healthEvents).toEqual([]);
    unsubscribe();
  });

  it('serves authenticated account traffic from the server only', async () => {
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
    // 服务端唯一存储：写成功后本地也没有 account 副本。
    expect(localStorage.getItem('maic:account:settings-storage')).toBeNull();
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

  it('keeps the device scope on the machine even when the account scope is unavailable', async () => {
    stubFetch(() => jsonResponse({ success: true, user: null }));
    const { createDefaultAppKVStore } = await import('@/lib/persistence/browser-kv');

    const kv = createDefaultAppKVStore();
    await kv.set('learner-key', 'anon-123', 'device');
    expect(await kv.get('learner-key', 'device')).toBe('anon-123');
    expect(localStorage.getItem('maic:device:learner-key')).toBe('"anon-123"');
    expect(await kv.keys('', 'device')).toEqual(['learner-key']);
    await kv.remove('learner-key', 'device');
    expect(await kv.get('learner-key', 'device')).toBeNull();
  });

  it('purges legacy local account entries once, keeping device entries', async () => {
    const storage = memoryStorage();
    storage.setItem('maic:account:settings-storage', '{"state":{"theme":"dark"}}');
    storage.setItem('maic:account:user-profile-storage', '{"state":{"name":"lei"}}');
    storage.setItem('maic:device:learner-key', '"anon-123"');
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      __OPENMAIC_PERSISTENCE_CONFIGURED__: true,
      localStorage: storage,
    });
    stubFetch(() => jsonResponse({ success: true, user: null }));

    const { createDefaultAppKVStore } = await import('@/lib/persistence/browser-kv');
    createDefaultAppKVStore();

    expect(storage.getItem('maic:account:settings-storage')).toBeNull();
    expect(storage.getItem('maic:account:user-profile-storage')).toBeNull();
    expect(storage.getItem('maic:device:learner-key')).toBe('"anon-123"');
  });
});
