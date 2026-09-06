import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertJsonValue } from '../../packages/@openmaic/storage/src/runtime/json-value';

/**
 * settings store 的持久化负载必须能通过 KV 写边界的纯 JSON 校验
 * （HttpKVStore.set / BrowserKVStore → assertJsonValue，违规拒绝整个写入
 * → KeyState 判定存储故障 → 用户看到“更改未被保存”告警）。
 *
 * 驱动真实 seam：createKVPersistStorage('account', { kv: 记录型 KV })，
 * 先 getItem 让 KeyState settle，再 setItem 写入 zustand persist 的真实
 * 负载，断言“通过校验的写入真正落地”。注意 kv-persist 的 Outcome 机制
 * 会吞掉写异常（转成健康信号），所以断言必须观察落地与否，而非期待抛错。
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

/** 校验通过才记录落地的 KV 后端。 */
function gatedKv(received: unknown[]) {
  return {
    get: () => Promise.resolve(null),
    set: (key: string, value: unknown) => {
      assertJsonValue(value, `kv value for key ${JSON.stringify(key)}`);
      received.push(value);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  };
}

describe('settings store persisted payload survives the KV JSON gate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());
  });

  async function writeThroughSeam(state: object): Promise<unknown[]> {
    const received: unknown[] = [];
    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const adapter = createKVPersistStorage('account', { kv: gatedKv(received) });
    await adapter.getItem('settings-storage'); // settle：打开写门
    await adapter.setItem('settings-storage', { state, version: 0 });
    return received;
  }

  it('default state passes the write-boundary gate', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    const received = await writeThroughSeam(useSettingsStore.getState());
    // zustand persist 缺省 partialize 语义：整个 state（含 action 函数成员）。
    // seam 必须把它规范化成能过校验的负载并真正落地。
    expect(received).toHaveLength(1);
  });

  it('state after fetchServerProviders passes the write-boundary gate', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    // 与真实部署同构的 /api/server-providers 响应（glm 有模型，其余为空）。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          providers: { glm: { models: ['glm-5.2', 'glm-5.1'] } },
          tts: {},
          asr: {},
          pdf: {},
          image: {},
          video: {},
          webSearch: {},
          generation: { parallelSceneConcurrency: 0 },
        }),
      ),
    );
    await useSettingsStore.getState().fetchServerProviders();
    const received = await writeThroughSeam(useSettingsStore.getState());
    expect(received).toHaveLength(1);
  });

  it('a genuinely non-JSON value still fails loudly (health signal, no landing)', async () => {
    const { subscribeToPersistHealth } = await import('@/lib/store/persist-health');
    const events: string[] = [];
    const unsubscribe = subscribeToPersistHealth((event) =>
      events.push(`${event.name}:${event.status}`),
    );
    const received = await writeThroughSeam({ level: 0, bad: new Date(0) } as object);
    // Date 不是 JSON 会静默丢弃的成员，而是真正的非 JSON 值：规范化不碰它，
    // 写边界拒绝 → 不落地 → 经健康通道上报（用户可见告警的来源）。
    // 健康事件经 setTimeout(0) 异步投递，等一个宏任务再断言。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(0);
    expect(events).toContain('settings-storage:unavailable');
    unsubscribe();
  });
});
