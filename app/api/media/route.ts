/**
 * /api/media?stageId= — 按课清理整组生成媒体字节。
 *
 * 课件删除 / 资源回收时由客户端 best-effort 调用；仅所有者可清。
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isPersistenceConfigured } from '@/lib/config/feature-flags';
import { resolveSessionUser } from '@/lib/server/auth';
import { deleteStageMediaBytesByStage } from '@/lib/server/media-bytes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(req: NextRequest) {
  if (!isPersistenceConfigured()) return new Response('Not found', { status: 404 });

  const stageId = req.nextUrl.searchParams.get('stageId');
  if (!stageId) return NextResponse.json({ error: 'stage_required' }, { status: 400 });

  const user = await resolveSessionUser(req).catch(() => null);
  const result = await deleteStageMediaBytesByStage(user, { stageId });
  if (result.status === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
