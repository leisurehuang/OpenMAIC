import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

// 登录会话在测试里固定为「当前用户 / 其他用户 / 未登录」三态，身份策略
// （仅所有者可写、所有者必得、公开课件旁听者可读）不依赖真实数据库会话。
const sessionUser = vi.fn<(id?: string) => { id: string; name: string } | null>();

vi.mock('@/lib/server/auth', () => ({
  isAuthRequired: () => true,
  resolveSessionUser: async () => sessionUser(),
}));

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  deleteStageMediaBytes,
  deleteStageMediaBytesByStage,
  ensureMediaBytesSchema,
  getStageMediaBytes,
  putStageMediaBytes,
} from '@/lib/server/media-bytes';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

function courseDocument(id: string, name = 'Media course') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function ownerStore(pool: PGlitePool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

describe('media bytes server store', () => {
  let pool: PGlitePool;
  const stageId = 'stage-media-bytes';

  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://media-bytes-test');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    // Provider ensure 建起 document/stage_meta 全套 schema（真实路径与
    // 生产一致），随后真实文档保存写入所有权行。
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ownerStore(pool, 'user:u1').saveDocument(courseDocument(stageId));
    await ensureMediaBytesSchema(pool as unknown as Parameters<typeof ensureMediaBytesSchema>[0]);
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM media_bytes');
    // 共享的 stage_meta 会带着上一个测试的公开/墓碑状态，逐个测试复位。
    await pool.query('UPDATE stage_meta SET is_public = false, deleted_at = NULL WHERE stage_id = $1', [
      stageId,
    ]);
  });

  it('stores bytes for the owner and reads them back', async () => {
    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    const put = await putStageMediaBytes({ id: 'u1' }, {
      stageId,
      ref: 'gen_img_1',
      kind: 'media',
      mimeType: 'image/png',
      bytes: Buffer.from('image-bytes'),
    });
    expect(put).toEqual({ status: 'stored' });

    const got = await getStageMediaBytes({ id: 'u1' }, { ref: 'gen_img_1', kind: 'media' });
    expect(got.status).toBe('resolved');
    expect(got).toMatchObject({ mimeType: 'image/png' });
  });

  it('refuses writes from a foreign user and reads from a stranger', async () => {
    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await putStageMediaBytes({ id: 'u1' }, {
      stageId,
      ref: 'gen_img_1',
      kind: 'media',
      mimeType: 'image/png',
      bytes: Buffer.from('image-bytes'),
    });

    sessionUser.mockReturnValue({ id: 'u2', name: 'other' });
    await expect(
      putStageMediaBytes({ id: 'u2' }, {
        stageId,
        ref: 'gen_img_1',
        kind: 'media',
        mimeType: 'image/png',
        bytes: Buffer.from('hijack'),
      }),
    ).resolves.toEqual({ status: 'forbidden' });
    await expect(
      getStageMediaBytes({ id: 'u2' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('serves a public course media to a signed-in visitor, tombstoned to nobody', async () => {
    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await putStageMediaBytes({ id: 'u1' }, {
      stageId,
      ref: 'gen_img_1',
      kind: 'media',
      mimeType: 'image/png',
      bytes: Buffer.from('image-bytes'),
    });
    await pool.query('UPDATE stage_meta SET is_public = true WHERE stage_id = $1', [stageId]);

    sessionUser.mockReturnValue({ id: 'u2', name: 'other' });
    await expect(
      getStageMediaBytes({ id: 'u2' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toMatchObject({ status: 'resolved' });

    await pool.query('UPDATE stage_meta SET deleted_at = now() WHERE stage_id = $1', [stageId]);
    await expect(
      getStageMediaBytes({ id: 'u2' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'missing' });
    // 已删除的课：写入按不存在拒绝。
    await expect(
      putStageMediaBytes({ id: 'u1' }, {
        stageId,
        ref: 'gen_img_2',
        kind: 'media',
        mimeType: 'image/png',
        bytes: Buffer.from('late'),
      }),
    ).resolves.toEqual({ status: 'stage-not-found' });
  });

  it('rejects sessionless writes and reads, and deletes per ref and per stage', async () => {
    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await putStageMediaBytes({ id: 'u1' }, {
      stageId,
      ref: 'gen_img_1',
      kind: 'media',
      mimeType: 'image/png',
      bytes: Buffer.from('a'),
    });
    await putStageMediaBytes({ id: 'u1' }, {
      stageId,
      ref: 'audio-1',
      kind: 'audio',
      mimeType: 'audio/mpeg',
      bytes: Buffer.from('b'),
    });

    await expect(
      putStageMediaBytes(null, {
        stageId,
        ref: 'gen_img_1',
        kind: 'media',
        mimeType: 'image/png',
        bytes: Buffer.from('anon'),
      }),
    ).resolves.toEqual({ status: 'unauthenticated' });
    await expect(
      getStageMediaBytes(null, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'unauthenticated' });

    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await expect(
      deleteStageMediaBytes({ id: 'u1' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(
      getStageMediaBytes({ id: 'u1' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'missing' });

    sessionUser.mockReturnValue({ id: 'u2', name: 'other' });
    // 他人按课清理清不到 u1 的行。
    await expect(
      deleteStageMediaBytesByStage({ id: 'u2' }, { stageId }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(
      getStageMediaBytes({ id: 'u1' }, { ref: 'audio-1', kind: 'audio' }),
    ).resolves.toMatchObject({ status: 'resolved' });

    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await expect(
      deleteStageMediaBytesByStage({ id: 'u1' }, { stageId }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(
      getStageMediaBytes({ id: 'u1' }, { ref: 'audio-1', kind: 'audio' }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('reports unconfigured without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '');
    sessionUser.mockReturnValue({ id: 'u1', name: 'lei' });
    await expect(
      putStageMediaBytes({ id: 'u1' }, {
        stageId,
        ref: 'gen_img_1',
        kind: 'media',
        mimeType: 'image/png',
        bytes: Buffer.from('x'),
      }),
    ).resolves.toEqual({ status: 'unconfigured' });
    await expect(
      getStageMediaBytes({ id: 'u1' }, { ref: 'gen_img_1', kind: 'media' }),
    ).resolves.toEqual({ status: 'unconfigured' });
  });
});
