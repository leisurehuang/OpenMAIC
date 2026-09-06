/**
 * 服务端 account 作用域 KV 合约（`/api/persistence/kv/...`）。
 *
 * 浏览器端 `HttpKVStore`（packages/@openmaic/storage/src/kv/http.ts）的对应
 * 服务端实现。设置存储（zustand persist → KVStore account 作用域）通过
 * 这组合约落到 PostgreSQL，按 `principal.learnerKey` 分区——登录认证部署
 * 中即 `user:<id>`，每个账户一份设置，跨浏览器同步。
 *
 * 合约（与 HttpKVStore 逐条对应）：
 *   GET    /kv/entries/<key>   → 200 {value} | 404 KEY_NOT_FOUND
 *   PUT    /kv/entries/<key>   → 204（body 为 {value}）
 *   DELETE /kv/entries/<key>   → 204（键不存在也成功）
 *   GET    /kv/keys?prefix=p   → 200 ["key", ...]
 * 错误体统一 `{error: {code, message}}`。
 */
import type { Pool } from 'pg';

import { nodeRequest } from './node-request';
import { getServerPersistenceProvider } from './server-provider';
import { authenticatePersistenceRequest } from './server-auth';

let schemaReady: Promise<void> | undefined;

export async function ensureAccountKvSchema(pool: Pool): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_account_entries (
        learner_key TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (learner_key, key)
      );
    `);
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export function isAccountKvPath(relativePath: string): boolean {
  return relativePath === '/kv/keys' || relativePath.startsWith('/kv/entries/');
}

function kvError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** LIKE 模式转义：前缀匹配里 % _ \ 是字面字符，不是通配符。 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function decodeKeySegment(segment: string): string | null {
  try {
    const key = decodeURIComponent(segment);
    return key === '' ? null : key;
  } catch {
    return null;
  }
}

/** 处理一条 KV 请求；调用方保证 relativePath 已通过 isAccountKvPath。 */
export async function handleAccountKvRequest(
  request: Request,
  relativePath: string,
  connectionString: string,
): Promise<Response> {
  // 先读 body 再桥接认证：Readable.fromWeb 会锁定 Web 流，若先构造
  // IncomingMessage 再 request.json()，流已被消费，PUT 必报 INVALID_JSON。
  let parsedBody: unknown;
  if (request.method === 'PUT') {
    try {
      parsedBody = await request.json();
    } catch {
      return kvError(400, 'INVALID_JSON', 'request body is not valid JSON');
    }
  }

  // 身份来自与 runtime/document 相同的认证路径：登录会话（auth 模式）或
  // 开发令牌 + x-learner-key。分区键取 principal.learnerKey，客户端提供的
  // 头在 auth 模式下被完全忽略，不能跨分区读写。
  const principal = await authenticatePersistenceRequest(
    nodeRequest(request, undefined, { withBody: false }),
  );
  if (!principal?.learnerKey) {
    return kvError(401, 'UNAUTHENTICATED', 'authentication required');
  }
  const learnerKey = principal.learnerKey;

  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureAccountKvSchema(pool);

  const method = request.method;
  const url = new URL(request.url);

  if (method === 'GET' && relativePath === '/kv/keys') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const { rows } = await pool.query(
      `SELECT key FROM kv_account_entries
        WHERE learner_key = $1 AND key LIKE $2 ESCAPE '\\'
        ORDER BY key`,
      [learnerKey, `${escapeLikePrefix(prefix)}%`],
    );
    return Response.json(rows.map((row: { key: string }) => row.key));
  }

  if (relativePath.startsWith('/kv/entries/')) {
    const key = decodeKeySegment(relativePath.slice('/kv/entries/'.length));
    if (key === null) return kvError(404, 'ROUTE_NOT_FOUND', 'kv key segment is not addressable');

    if (method === 'GET') {
      const { rows } = await pool.query(
        'SELECT value FROM kv_account_entries WHERE learner_key = $1 AND key = $2',
        [learnerKey, key],
      );
      if (rows.length === 0) {
        return kvError(404, 'KEY_NOT_FOUND', '@openmaic/storage: no entry for key');
      }
      return Response.json({ value: rows[0].value });
    }

    if (method === 'PUT') {
      const body = parsedBody;
      if (typeof body !== 'object' || body === null || !('value' in body)) {
        return kvError(400, 'MALFORMED_REQUEST', 'body must be an object carrying "value"');
      }
      await pool.query(
        `INSERT INTO kv_account_entries (learner_key, key, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (learner_key, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [learnerKey, key, JSON.stringify((body as { value: unknown }).value)],
      );
      return new Response(null, { status: 204 });
    }

    if (method === 'DELETE') {
      await pool.query('DELETE FROM kv_account_entries WHERE learner_key = $1 AND key = $2', [
        learnerKey,
        key,
      ]);
      return new Response(null, { status: 204 });
    }
  }

  return kvError(404, 'ROUTE_NOT_FOUND', 'kv route not found');
}
