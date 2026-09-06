import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import {
  createSession,
  findUserByName,
  sessionCookieHeader,
  verifyPassword,
} from '@/lib/server/auth';

const log = createLogger('AuthLogin');

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; password?: unknown }
      | null;
    if (!body) return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name || !password) return apiError('INVALID_REQUEST', 400, '请输入用户名和密码');

    const record = await findUserByName(name);
    const ok = record ? await verifyPassword(password, record.passwordHash) : false;
    if (!record || !ok) {
      // 统一延迟，弱化用户名枚举的时间侧信道
      await new Promise((resolve) => setTimeout(resolve, 300));
      return apiError('INVALID_CREDENTIALS', 401, '用户名或密码不正确');
    }

    const session = await createSession(record.id);
    log.info(`[auth] user logged in: ${record.name}`);
    return new Response(
      JSON.stringify({ success: true, user: { id: record.id, name: record.name } }),
      {
        status: 200,
        headers: {
          'Set-Cookie': sessionCookieHeader(session.cookieValue),
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (error) {
    log.error('Login failed', error);
    return apiError('INTERNAL_ERROR', 500, '登录失败');
  }
}
