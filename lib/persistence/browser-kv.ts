/**
 * 浏览器端默认 KVStore 的选择。
 *
 * 服务端持久化由运行时探测决定（不再有构建期开关）：探测 /api/persistence
 * 返回 404（未配 DATABASE_URL）时，与上游一致：纯 localStorage。服务端
 * 可用时，account 作用域改走 `HttpKVStore` → `/api/persistence/kv/...`，
 * 按登录用户（或部署的共享键）分区，设置随账户跨浏览器同步；device
 * 作用域永远留在本机 localStorage。
 *
 * 一次性迁移：切换到服务端 KV 之前，account 值都在本地 localStorage。
 * 远端没有某个键而本地有（旧浏览器）时，首次读取会把本地值回填到服务
 * 端并返回——谁先读到，谁的本地配置成为账户基线，用户无需手动重配。
 * 回填失败不阻塞读取（本会话仍用本地值），下次读取再试。
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

/**
 * 登录认证部署里当前是否未登录（登录页 / 登出后 / 会话已失效）。
 *
 * 未登录时服务端中间件对 /api/persistence 一律 401，那会被持久化层当成
 * 存储故障上报成“更改未被保存”。此时 account 作用域留在本机
 * localStorage：登录 / 注册成功后整页跳转，新页面重新探测认证状态回到
 * 服务端，本地值经既有迁移路径回填。
 */

class AccountMigratingKVStore implements KVStore {
  readonly isLocalKVStore = false as const;
  readonly servesDeviceScopeLocally = true as const;

  /** 遗留数据归属标记：本地 account 值属于哪个学习者分区。 */
  static readonly MIGRATION_OWNER_KEY = '__openmaic:kv-migration-owner';
  private migrationOwnerKnown = false;
  private migrationOwnerMatches = false;

  constructor(
    private readonly http: HttpKVStore,
    private readonly local: BrowserKVStore,
  ) {}

  private isDeviceScope(scope: KVScope | undefined): boolean {
    return scope === 'device';
  }

  /**
   * 本地遗留的 account 值是否属于当前登录身份。首个在此浏览器使用服务端
   * KV 的身份认领遗留数据（标记写入本地）；后来者不匹配则跳过迁移，
   * 避免把前一个账户的配置（含提供商密钥）带回填到新账户分区。
   */
  private async legacyOwnedByCurrentUser(): Promise<boolean> {
    if (this.migrationOwnerKnown) return this.migrationOwnerMatches;
    this.migrationOwnerKnown = true;
    try {
      const headers = await getPersistenceRequestHeaders();
      const currentLearner = headers['x-learner-key'];
      if (!currentLearner) return (this.migrationOwnerMatches = false);
      const marker = await this.local.get<string>(AccountMigratingKVStore.MIGRATION_OWNER_KEY, 'account');
      if (marker === null) {
        await this.local.set(AccountMigratingKVStore.MIGRATION_OWNER_KEY, currentLearner, 'account');
        return (this.migrationOwnerMatches = true);
      }
      this.migrationOwnerMatches = marker === currentLearner;
    } catch {
      this.migrationOwnerMatches = false;
    }
    return this.migrationOwnerMatches;
  }

  async get<T>(key: string, scope?: KVScope): Promise<T | null> {
    if (this.isDeviceScope(scope)) return this.local.get<T>(key, 'device');
    if (await accountScopeStaysLocal()) return this.local.get<T>(key, 'account');
    const remote = await this.http.get<T>(key);
    if (remote !== null) return remote;
    if (!(await this.legacyOwnedByCurrentUser())) return null;
    const legacy = await this.local.get<T>(key, 'account');
    if (legacy === null) return null;
    try {
      await this.http.set<T>(key, legacy);
      log.info(`Migrated local account KV entry "${key}" to the server`);
    } catch (error) {
      // 回填失败不阻塞本次读取；键仍在本地，下次读取重试。
      log.warn(`Could not migrate local account KV entry "${key}" to the server:`, error);
    }
    return legacy;
  }

  async set<T>(key: string, value: T, scope?: KVScope): Promise<void> {
    if (this.isDeviceScope(scope)) return this.local.set<T>(key, value, 'device');
    if (await accountScopeStaysLocal()) return this.local.set<T>(key, value, 'account');
    return this.http.set<T>(key, value);
  }

  async remove(key: string, scope?: KVScope): Promise<void> {
    if (this.isDeviceScope(scope)) return this.local.remove(key, 'device');
    if (await accountScopeStaysLocal()) {
      await this.local.remove(key, 'account');
      return;
    }
    await this.http.remove(key);
    // 同步清掉本地遗留，避免删除的设置经迁移路径复活。
    await this.local.remove(key, 'account').catch(() => {});
  }

  async keys(prefix = '', scope?: KVScope): Promise<string[]> {
    if (this.isDeviceScope(scope)) return this.local.keys(prefix, 'device');
    if (await accountScopeStaysLocal()) return this.local.keys(prefix, 'account');
    return this.http.keys(prefix);
  }
}

/**
 * account 作用域本次会话留在本机：未登录（服务端会 401，避免误报存储
 * 故障），或运行时探测到服务端未配置持久化（无 DATABASE_URL）。
 * 两个结论都按页面缓存，探测结果不随单次请求抖动翻转。
 */
async function accountScopeStaysLocal(): Promise<boolean> {
  // 同步标志明确未配置时短路：未配库的部署零网络请求，留在本机。
  if (!isBrowserPersistenceEnabled()) return true;
  return (await isLoginAuthSignedOut()) || !(await isAccountScopeServerBacked());
}

export function createDefaultAppKVStore(): KVStore {
  const local = new BrowserKVStore();
  const http = new HttpKVStore({
    baseUrl: '/api/persistence',
    deviceStore: local,
    // 认证头与 runtime/document 相同：authorization 开发令牌 + x-learner-key
    // （登录模式下服务端以会话为准，忽略客户端头中的身份）。
    headers: () => getPersistenceRequestHeaders(),
  });
  return new AccountMigratingKVStore(http, local);
}
