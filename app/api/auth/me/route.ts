import { apiSuccess } from '@/lib/server/api-response';
import { resolveSessionUser } from '@/lib/server/auth';

export const runtime = 'nodejs';

/**
 * 当前会话身份。客户端持久化引导（lib/persistence/bootstrap.ts）在登录
 * 认证模式下调用本接口取得个人学习者分区键 `user:<id>`，使设置跨浏览器
 * 跟随登录用户。
 */
export async function GET(request: Request) {
  const user = await resolveSessionUser(request).catch(() => null);
  if (!user) return apiSuccess({ user: null });
  return apiSuccess({
    user: {
      id: user.id,
      name: user.name,
      learnerKey: `user:${user.id}`,
    },
  });
}
