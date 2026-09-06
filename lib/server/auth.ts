/**
 * 用户登录认证（本地账户体系）
 *
 * 为可信小组部署提供每人独立的身份分区：登录后设置（account 作用域 KV）和
 * 运行时会话跟随 `user:<id>` 分区，课程文档仍按部署配置（共享或按人）分区。
 *
 * 存储：复用持久化的 PostgreSQL 连接（DATABASE_URL），auth_users /
 * auth_sessions 两张表懒建。会话 token 只存 SHA-256 哈希——数据库泄露
 * 不等于会话泄露。密码用 Node 内置 scrypt + 每用户随机盐。
 *
 * 边界：中间件（Edge）验证 cookie 自包含 HMAC 签名并拦截未登录请求；
 * 身份相关的真实校验（会话是否仍有效、吊销）都在 Node 运行时（本模块）
 * 查库完成。
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE = 'openmaic_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const SESSION_USER_ID_HEX_LENGTH = 16; // 8 bytes
const SESSION_TOKEN_HEX_LENGTH = 64; // 32 bytes
const SCRYPT_KEYLEN = 64;

/** 登录认证开关（运行时环境变量，服务端生效）。 */
export function isAuthRequired(): boolean {
  const raw = process.env.OPENMAIC_AUTH_REQUIRED?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export interface AuthUser {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Schema（懒建 + 进程内单例）
// ---------------------------------------------------------------------------

let schemaReady: Promise<void> | undefined;

export async function ensureAuthSchema(pool: Pool): Promise<void> {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_id ON auth_sessions(user_id);
    `);
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

async function authPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('OPENMAIC_AUTH_REQUIRED needs DATABASE_URL');
  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureAuthSchema(pool);
  return pool;
}

// ---------------------------------------------------------------------------
// 密码
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 会话签名密钥：OPENMAIC_SESSION_SECRET 优先；未设置时退回到开发令牌并告警。
 * 中间件（Edge，见 middleware.ts）用同一密钥验签 cookie，因此两边必须一致。
 */
export function sessionSigningSecret(): string {
  const secret = process.env.OPENMAIC_SESSION_SECRET?.trim();
  if (secret) return secret;
  if (!sessionSigningSecretWarned) {
    sessionSigningSecretWarned = true;
    console.warn('[auth] OPENMAIC_SESSION_SECRET 未设置，退回使用 PERSISTENCE_DEV_TOKEN 签名');
  }
  return process.env.PERSISTENCE_DEV_TOKEN ?? '';
}
let sessionSigningSecretWarned = false;

function hmacHex(payload: string): string {
  return createHmac('sha256', sessionSigningSecret()).update(payload).digest('hex');
}

export interface IssuedSession {
  userId: string;
  /** 数据库令牌（仅服务端使用，不下发到 cookie 明文以外的任何地方）。 */
  token: string;
  /** 写入 cookie 的完整值：`<userId>.<token>.<hmac>`。 */
  cookieValue: string;
}

export async function createSession(userId: string): Promise<IssuedSession> {
  const pool = await authPool();
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await pool.query(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), userId, expiresAt],
  );
  // 顺手清理过期会话，失败不影响主流程
  pool.query('DELETE FROM auth_sessions WHERE expires_at < now()').catch(() => {});
  return { userId, token, cookieValue: `${userId}.${token}.${hmacHex(`${userId}.${token}`)}` };
}

/** 验证 cookie 值的签名并拆出。middleware.ts 里有一份 Edge 版实现，两边保持一致。 */
export function parseSessionCookieValue(
  value: string | undefined,
): { userId: string; token: string } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, token, signature] = parts;
  if (
    userId.length !== SESSION_USER_ID_HEX_LENGTH ||
    token.length !== SESSION_TOKEN_HEX_LENGTH ||
    signature.length !== 64 ||
    !/^[0-9a-f]+$/.test(userId + token + signature)
  ) {
    return null;
  }
  const expected = hmacHex(`${userId}.${token}`);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
    ? { userId, token }
    : null;
}

export async function resolveSessionUserByToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token || token.length !== SESSION_TOKEN_HEX_LENGTH || !/^[0-9a-f]+$/.test(token)) {
    return null;
  }
  const pool = await authPool();
  const { rows } = await pool.query(
    `SELECT u.id, u.name
       FROM auth_sessions s
       JOIN auth_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      LIMIT 1`,
    [tokenHash(token)],
  );
  return rows[0] ?? null;
}

/** 从任意来源的 cookie 原始值解析用户（验签 + 查库）。 */
export async function resolveSessionUserFromCookieValue(
  value: string | undefined,
): Promise<AuthUser | null> {
  const parsed = parseSessionCookieValue(value);
  if (!parsed) return null;
  return resolveSessionUserByToken(parsed.token);
}

function readCookie(headers: Headers, name: string): string | undefined {
  const encoded = headers.get('cookie');
  if (!encoded) return undefined;
  for (const item of encoded.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

export async function resolveSessionUser(req: Pick<Request, 'headers'>): Promise<AuthUser | null> {
  return resolveSessionUserFromCookieValue(readCookie(req.headers, SESSION_COOKIE));
}

export async function deleteSessionByToken(token: string | undefined): Promise<void> {
  if (!token) return;
  const pool = await authPool();
  await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
}

/** 拼接 Set-Cookie；maxAgeSeconds 传 0 用于清除。 */
export function sessionCookieHeader(
  cookieValue: string,
  maxAgeSeconds = SESSION_TTL_SECONDS,
): string {
  const parts = [
    `${SESSION_COOKIE}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^\S{2,32}$/;

export function validateCredentials(name: unknown, password: unknown): string | undefined {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name.trim())) {
    return '用户名需为 2-32 个字符（不含空格）';
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return '密码需为 8-128 个字符';
  }
  return undefined;
}

export async function createUser(name: string, password: string): Promise<AuthUser> {
  const pool = await authPool();
  const id = randomBytes(8).toString('hex');
  const passwordHash = await hashPassword(password);
  const { rowCount } = await pool.query(
    'INSERT INTO auth_users (id, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
    [id, name.trim(), passwordHash],
  );
  if (!rowCount) throw new Error('USER_EXISTS');
  return { id, name: name.trim() };
}

export async function findUserByName(name: string): Promise<{ id: string; name: string; passwordHash: string } | null> {
  const pool = await authPool();
  const { rows } = await pool.query(
    'SELECT id, name, password_hash AS "passwordHash" FROM auth_users WHERE name = $1 LIMIT 1',
    [name.trim()],
  );
  return rows[0] ?? null;
}
