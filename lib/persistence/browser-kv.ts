/**
 * 浏览器端默认 KVStore 的选择。
 *
 * account 作用域（用户设置，如 `settings-storage`）**只存远端**：服务端
 * 持久化（DATABASE_URL）可用且当前已登录时走 `HttpKVStore` →
 * `/api/persistence/kv/...`，按登录用户分区，跨浏览器同步。浏览器本地
 * 不保留任何 account 副本——没有回退写入，也没有旧数据迁移；切换到该
 * 模式前留在本机的 `maic:account:*` 键在模块加载时一次性清除（其中含
 * 明文提供商密钥）。
 *
 * 两个已知的 no-op 状态：未登录（登录页 / 登出后 / 会话失效）与运行时
 * 探测到服务端未配置持久化。此时 account 读返回空（store 水合默认值）、
 * 写静默丢弃——这两种状态下用户本就无设置可写，而请求服务端只会拿到
 * 401 / 404，被持久化层当成存储故障误报成「更改未被保存」的告警。
 * device 作用域不受影响，永远留在本机 localStorage。
 */
import {
  BrowserKVStore,
  HttpKVStore,
  type KVScope,
  type KVStore,
} from '@openmaic/storage';

import { createLogger } from '@/lib/logger';
import {
  getPersistenceRequestHeaders,
  isAccountScopeServerBacked,
  isBrowserPersistenceEnabled,
  isLoginAuthSignedOut,
} from './bootstrap';

const log = createLogger('BrowserKV');

class AccountServerOnlyKvStore implements KVStore {
  readonly isLocalKVStore = false as const;
  readonly servesDeviceScopeLocally = true as const;

  /** 本会话内已提示过 no-op 写入的键，避免每次写都刷日志。 */
  static readonly droppedWriteWarned = new Set<string>();

  constructor(
    private readonly http: HttpKVStore,
    private readonly local: BrowserKVStore,
  ) {}

  private isDeviceScope(scope: KVScope | undefined): boolean {
    return scope === 'device';
  }

  /**
   * account 数据的唯一合法去处（服务端 + 已登录会话）本次会话是否可用。
   * 两个结论并行取得、按页面缓存：冷启动水合的首读与初始化器写竞争，
   * 串行探测会把「未就绪拒写」的窗口拉长到必现。
   */
  private async accountReady(): Promise<boolean> {
    if (!isBrowserPersistenceEnabled()) return false;
    const [signedOut, serverBacked] = await Promise.all([
      isLoginAuthSignedOut(),
      isAccountScopeServerBacked(),
    ]);
    return !signedOut && serverBacked;
  }

  async get<T>(key: string, scope?: KVScope): Promise<T | null> {
    if (this.isDeviceScope(scope)) return this.local.get<T>(key, 'device');
    if (!(await this.accountReady())) return null;
    return this.http.get<T>(key);
  }

  async set<T>(key: string, value: T, scope?: KVScope): Promise<void> {
    if (this.isDeviceScope(scope)) return this.local.set<T>(key, value, 'device');
    if (!(await this.accountReady())) {
      if (!AccountServerOnlyKvStore.droppedWriteWarned.has(key)) {
        AccountServerOnlyKvStore.droppedWriteWarned.add(key);
        log.info(
          `Dropping the account write for "${key}": the server-side account store is not ` +
            `available in this session (signed out or persistence not configured)`,
        );
      }
      return;
    }
    return this.http.set<T>(key, value);
  }

  async remove(key: string, scope?: KVScope): Promise<void> {
    if (this.isDeviceScope(scope)) return this.local.remove(key, 'device');
    if (!(await this.accountReady())) return;
    return this.http.remove(key);
  }

  async keys(prefix = '', scope?: KVScope): Promise<string[]> {
    if (this.isDeviceScope(scope)) return this.local.keys(prefix, 'device');
    if (!(await this.accountReady())) return [];
    return this.http.keys(prefix);
  }
}

/**
 * 一次性清除遗留的本机 account 副本（`<namespace>:account:*`）。
 *
 * account 数据只存服务端之后，这些键永远是死数据，且旧值里含明文提供商
 * 密钥——留在浏览器里纯属负债。不做迁移：按约定，切换后的首次使用允许
 * 用户重新配置一次。device 键不受影响。fire-and-forget，失败不阻塞加载。
 */
function purgeLegacyLocalAccountEntries(): void {
  if (typeof window === 'undefined') return;
  try {
    const storage = window.localStorage;
    const legacy: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const full = storage.key(i);
      if (full !== null && full.startsWith('maic:account:')) legacy.push(full);
    }
    for (const full of legacy) storage.removeItem(full);
    if (legacy.length > 0) log.info(`Removed ${legacy.length} legacy local account KV entries`);
  } catch (error) {
    log.warn('Could not purge legacy local account KV entries:', error);
  }
}

export function createDefaultAppKVStore(): KVStore {
  purgeLegacyLocalAccountEntries();
  const local = new BrowserKVStore();
  const http = new HttpKVStore({
    baseUrl: '/api/persistence',
    deviceStore: local,
    // 认证头与 runtime/document 相同：x-learner-key（登录模式下服务端以
    // 会话为准，忽略客户端头中的身份）。
    headers: () => getPersistenceRequestHeaders(),
  });
  return new AccountServerOnlyKvStore(http, local);
}
