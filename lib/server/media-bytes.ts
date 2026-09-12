/**
 * 服务端媒体字节存储（生成的课件产物：图片 / 视频及其封面 / TTS 旁白）。
 *
 * 生成的媒体字节原本只存在于生成它的那台浏览器的 IndexedDB（Dexie
 * mediaFiles / audioFiles），课件文档（已服务端化）里的媒体引用换一台
 * 浏览器就全部失配。本模块把字节落到 PostgreSQL，按登录用户分区
 * （owner_id = `user:<id>`，与 withRequestOwnerId 的文档分区一致），本地
 * IndexedDB 降级为缓存。
 *
 * 键设计：PRIMARY KEY (owner_id, ref, kind)。ref 是文档里的媒体引用
 * （mediaFileKey 的元素 id / 语音 audioId），全局唯一；stage_id 只作
 * 所有权校验与按课清理的索引列，不参与键——读取端（播放 / 渲染）常常
 * 只持有 ref，不持有 stageId。
 *
 * 与 asset_entries 注册表的关系：那是 @openmaic/storage 的通用资产合约
 * （分配 / 版本 / 回收 collector），当前应用流不经过它（见
 * resolve-server-asset.ts 的说明）；这是应用层的直接字节仓，避免把
 * Dexie 的 ref 空间硬塞进注册表的分配模型。
 */
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

let schemaReady: Promise<void> | undefined;

const MEDIA_BYTES_SCHEMA = `
      CREATE TABLE IF NOT EXISTS media_bytes (
        owner_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        bytes BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, ref, kind)
      );
      CREATE INDEX IF NOT EXISTS media_bytes_stage_idx ON media_bytes (owner_id, stage_id)
`;

export async function ensureMediaBytesSchema(pool: Pool): Promise<void> {
  schemaReady ??= (async () => {
    // pg 的 prepared statement 不接受多语句，逐条执行。
    for (const statement of MEDIA_BYTES_SCHEMA.split(';')) {
      const sql = statement.trim();
      if (sql !== '') await pool.query(sql);
    }
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export type MediaBytesKind = 'media' | 'poster' | 'audio';

export const MEDIA_BYTE_KINDS: readonly MediaBytesKind[] = ['media', 'poster', 'audio'];

export function isMediaBytesKind(value: unknown): value is MediaBytesKind {
  return typeof value === 'string' && (MEDIA_BYTE_KINDS as readonly string[]).includes(value);
}

/** 单条媒体字节上限。生成视频是最大项，逐条远大于它是滥用而非正常使用。 */
export const MAX_MEDIA_BYTES_LENGTH = 256 * 1024 * 1024;

export type MediaBytesWriteResult =
  | { status: 'stored' }
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'stage-not-found' }
  | { status: 'forbidden' }
  | { status: 'too-large' };

export type MediaBytesReadResult =
  | { status: 'resolved'; bytes: Buffer; mimeType: string }
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'missing' };

/**
 * 写入一条媒体字节。仅课件所有者可写；stage 必须已存在（媒体生成发生在
 * 课件保存之后）且未删除。
 */
export async function putStageMediaBytes(
  user: { id: string } | null,
  input: {
    stageId: string;
    ref: string;
    kind: MediaBytesKind;
    mimeType: string;
    bytes: Buffer;
  },
): Promise<MediaBytesWriteResult> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };
  if (!user) return { status: 'unauthenticated' };
  if (input.bytes.byteLength > MAX_MEDIA_BYTES_LENGTH) return { status: 'too-large' };

  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureMediaBytesSchema(pool);

  const meta = await pool.query(
    'SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1',
    [input.stageId],
  );
  const row = meta.rows[0] as { owner_id: string; deleted_at: Date | string | null } | undefined;
  if (!row) return { status: 'stage-not-found' };
  if (row.deleted_at !== null) return { status: 'stage-not-found' };
  if (row.owner_id !== `user:${user.id}`) return { status: 'forbidden' };

  await pool.query(
    `INSERT INTO media_bytes (owner_id, ref, kind, stage_id, mime_type, byte_size, bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_id, ref, kind)
     DO UPDATE SET stage_id = EXCLUDED.stage_id, mime_type = EXCLUDED.mime_type,
                   byte_size = EXCLUDED.byte_size, bytes = EXCLUDED.bytes, updated_at = now()`,
    [
      `user:${user.id}`,
      input.ref,
      input.kind,
      input.stageId,
      input.mimeType,
      input.bytes.byteLength,
      input.bytes,
    ],
  );
  return { status: 'stored' };
}

/**
 * 读取一条媒体字节。所有者必得；否则仅当课件已公开且未删除时可用
 * （与文档读取的公开策略一致——公开课件对旁听者的媒体可见性）。
 */
export async function getStageMediaBytes(
  user: { id: string } | null,
  input: { ref: string; kind: MediaBytesKind },
): Promise<MediaBytesReadResult> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };
  if (!user) return { status: 'unauthenticated' };

  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureMediaBytesSchema(pool);

  const { rows } = await pool.query(
    `SELECT m.mime_type, m.bytes
       FROM media_bytes m
      WHERE m.ref = $1 AND m.kind = $2
        AND (m.owner_id = $3 OR EXISTS (
          SELECT 1 FROM stage_meta s
           WHERE s.stage_id = m.stage_id AND s.is_public AND s.deleted_at IS NULL))
      LIMIT 1`,
    [input.ref, input.kind, `user:${user.id}`],
  );
  const row = rows[0] as { mime_type: string; bytes: Buffer } | undefined;
  if (!row) return { status: 'missing' };
  return { status: 'resolved', bytes: row.bytes, mimeType: row.mime_type };
}

/** 删除一条媒体字节。仅所有者可删；键不存在同样按成功处理。 */
export async function deleteStageMediaBytes(
  user: { id: string } | null,
  input: { ref: string; kind: MediaBytesKind },
): Promise<{ status: 'deleted' | 'unconfigured' | 'unauthenticated' }> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };
  if (!user) return { status: 'unauthenticated' };

  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureMediaBytesSchema(pool);
  await pool.query('DELETE FROM media_bytes WHERE owner_id = $1 AND ref = $2 AND kind = $3', [
    `user:${user.id}`,
    input.ref,
    input.kind,
  ]);
  return { status: 'deleted' };
}

/** 按课清理整组媒体字节（课件删除 / 资源回收）。仅所有者可清。 */
export async function deleteStageMediaBytesByStage(
  user: { id: string } | null,
  input: { stageId: string },
): Promise<{ status: 'deleted' | 'unconfigured' | 'unauthenticated' }> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };
  if (!user) return { status: 'unauthenticated' };

  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureMediaBytesSchema(pool);
  await pool.query('DELETE FROM media_bytes WHERE owner_id = $1 AND stage_id = $2', [
    `user:${user.id}`,
    input.stageId,
  ]);
  return { status: 'deleted' };
}
