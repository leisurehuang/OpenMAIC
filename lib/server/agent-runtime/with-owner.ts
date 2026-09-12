import { isAuthRequired, resolveSessionUser } from '@/lib/server/auth';

import { resolveRequestOwnerId } from './owner';

/**
 * Resolve the request's owner identity and run a handler with its response
 * headers.
 *
 * Login auth is the standard flow, so ownership comes from the login session
 * (`user:<id>`): courseware documents, materials and stage meta partition per
 * account and follow the user across browsers. A sessionless request is
 * rejected with 401 rather than silently landing in a fresh anonymous
 * partition. With the auth switch off (dev-token deployments) the identity
 * falls back to the anonymous cookie inside resolveRequestOwnerId.
 *
 * The Set-Cookie minted by resolveRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different owner.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  let ownerId: string | undefined;
  if (isAuthRequired()) {
    const user = await resolveSessionUser(req).catch(() => null);
    if (!user) {
      return unauthorized(responseHeaders);
    }
    ownerId = await resolveRequestOwnerId(req, responseHeaders, `user:${user.id}`);
  } else {
    ownerId = await resolveRequestOwnerId(req, responseHeaders);
  }
  if (ownerId === undefined) {
    return unauthorized(responseHeaders);
  }
  try {
    return await handler(ownerId, responseHeaders);
  } catch (error) {
    console.error('[agent-runtime] request failed under an owner partition', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}

function unauthorized(responseHeaders: Headers): Response {
  return new Response(
    JSON.stringify({ success: false, errorCode: 'UNAUTHENTICATED', error: 'Authentication required' }),
    { status: 401, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(responseHeaders) } },
  );
}
