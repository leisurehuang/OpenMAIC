import { SESSION_COOKIE, deleteSessionByToken, parseSessionCookieValue, sessionCookieHeader } from '@/lib/server/auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const encoded = request.headers.get('cookie') ?? '';
  const match = encoded
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  const parsed = parseSessionCookieValue(match?.slice(SESSION_COOKIE.length + 1));
  await deleteSessionByToken(parsed?.token).catch(() => {});
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Set-Cookie': sessionCookieHeader('', 0),
      'Content-Type': 'application/json',
    },
  });
}
