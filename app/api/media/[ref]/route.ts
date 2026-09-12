/**
 * /api/media/[ref] — 单条生成媒体字节的云存储读写。
 *
 * 生成的课件媒体（图片 / 视频及封面 / TTS 旁白）由客户端在生成完成后
 * PUT 上来（本地 IndexedDB 降级为缓存），任何一台浏览器上缺字节时 GET
 * 回填。ref 是文档内的媒体引用（元素 id / audioId），所有权分区与课件
 * 文档一致（登录用户）；公开课件的媒体对旁听者可读（与文档读取策略
 * 一致）。未配置 DATABASE_URL 的部署整体 404，客户端留在纯本地模式。
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isPersistenceConfigured } from '@/lib/config/feature-flags';
import { resolveSessionUser } from '@/lib/server/auth';
import {
  deleteStageMediaBytes,
  getStageMediaBytes,
  isMediaBytesKind,
  MAX_MEDIA_BYTES_LENGTH,
  putStageMediaBytes,
} from '@/lib/server/media-bytes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ ref: string }> };

function readKind(req: NextRequest): 'media' | 'poster' | 'audio' | null {
  const raw = req.nextUrl.searchParams.get('kind') ?? 'media';
  return isMediaBytesKind(raw) ? raw : null;
}

export async function GET(req: NextRequest, { params }: Params) {
  if (!isPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const kind = readKind(req);
  if (!kind) return NextResponse.json({ error: 'bad_kind' }, { status: 400 });

  const user = await resolveSessionUser(req).catch(() => null);
  const { ref } = await params;
  const result = await getStageMediaBytes(user, { ref, kind });
  if (result.status === 'resolved') {
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        'Content-Type': result.mimeType,
        // 随写入即时更新，任何一层缓存都可能让回填拿到旧字节。
        'Cache-Control': 'no-store',
      },
    });
  }
  if (result.status === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const kind = readKind(req);
  if (!kind) return NextResponse.json({ error: 'bad_kind' }, { status: 400 });

  const stageId = req.nextUrl.searchParams.get('stageId');
  if (!stageId) return NextResponse.json({ error: 'stage_required' }, { status: 400 });

  const user = await resolveSessionUser(req).catch(() => null);
  const { ref } = await params;
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'empty_body' }, { status: 400 });
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES_LENGTH) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }
  const mimeType = req.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';

  const result = await putStageMediaBytes(user, { stageId, ref, kind, mimeType, bytes });
  switch (result.status) {
    case 'stored':
      return new Response(null, { status: 204 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    case 'forbidden':
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    case 'stage-not-found':
      return NextResponse.json({ error: 'stage_not_found' }, { status: 409 });
    case 'too-large':
      return NextResponse.json({ error: 'too_large' }, { status: 413 });
    default:
      return NextResponse.json({ error: 'unconfigured' }, { status: 404 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const kind = readKind(req);
  if (!kind) return NextResponse.json({ error: 'bad_kind' }, { status: 400 });

  const user = await resolveSessionUser(req).catch(() => null);
  const { ref } = await params;
  const result = await deleteStageMediaBytes(user, { ref, kind });
  if (result.status === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
