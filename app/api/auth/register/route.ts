import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import {
  createSession,
  createUser,
  sessionCookieHeader,
  validateCredentials,
} from '@/lib/server/auth';

const log = createLogger('AuthRegister');

export const runtime = 'nodejs';

/** 注册：设置了 OPENMAIC_REGISTER_INVITE_CODE 时必须携带匹配的邀请码。 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; password?: unknown; inviteCode?: unknown }
      | null;
    if (!body) return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');

    const inviteCode = process.env.OPENMAIC_REGISTER_INVITE_CODE?.trim();
    if (inviteCode && body.inviteCode !== inviteCode) {
      return apiError('INVALID_CREDENTIALS', 403, '邀请码不正确');
    }

    const validationError = validateCredentials(body.name, body.password);
    if (validationError) return apiError('INVALID_REQUEST', 400, validationError);

    const user = await createUser(String(body.name), String(body.password));
    const session = await createSession(user.id);
    log.info(`[auth] user registered: ${user.name}`);
    return new Response(JSON.stringify({ success: true, user }), {
      status: 201,
      headers: {
        'Set-Cookie': sessionCookieHeader(session.cookieValue),
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_EXISTS') {
      return apiError('INVALID_REQUEST', 409, '用户名已存在');
    }
    log.error('Registration failed', error);
    return apiError('INTERNAL_ERROR', 500, '注册失败');
  }
}
