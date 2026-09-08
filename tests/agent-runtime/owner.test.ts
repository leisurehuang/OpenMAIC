import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';

const mocks = vi.hoisted(() => ({
  authRequired: false,
  sessionUser: undefined as { id: string } | undefined,
}));

// 注册登录是标准流程（isAuthRequired 恒 true）；owner 解析在登录态下先走
// 会话分支。这里 mock 该模块以便两条路径都可测：
// - authRequired=false 覆盖匿名 cookie 分支（代码保留）；
// - authRequired=true 验证无会话时拒绝（401 语义）。
vi.mock('@/lib/server/auth', () => ({
  isAuthRequired: () => mocks.authRequired,
  resolveSessionUser: async () => mocks.sessionUser,
}));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  mocks.authRequired = false;
  mocks.sessionUser = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveRequestOwnerId', () => {
  it('returns undefined for an anonymous request when login is the standard flow', async () => {
    mocks.authRequired = true;
    const responseHeaders = new Headers();

    const ownerId = await resolveRequestOwnerId(
      new Request('http://localhost/agent'),
      responseHeaders,
    );

    expect(ownerId).toBeUndefined();
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('resolves the session user partition when login is the standard flow', async () => {
    mocks.authRequired = true;
    mocks.sessionUser = { id: 'user-42' };
    const responseHeaders = new Headers();

    const ownerId = await resolveRequestOwnerId(
      new Request('http://localhost/agent'),
      responseHeaders,
    );

    expect(ownerId).toBe('user:user-42');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('mints a UUID-backed anonymous owner when the cookie is absent', async () => {
    const responseHeaders = new Headers();

    const ownerId = await resolveRequestOwnerId(
      new Request('http://localhost/agent'),
      responseHeaders,
    );

    expect(ownerId).toBeDefined();
    expect(ownerId!.startsWith('anon:')).toBe(true);
    expect(ownerId!.slice('anon:'.length)).toMatch(UUID_V4);
    expect(responseHeaders.get('set-cookie')).toContain(
      `anonymous_id=${ownerId!.slice('anon:'.length)}`,
    );
  });

  it('reuses a valid anonymous cookie without returning another cookie header', async () => {
    const id = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
    const responseHeaders = new Headers();
    const request = new Request('http://localhost/agent', {
      headers: { cookie: `theme=dark; anonymous_id=${id}; locale=en` },
    });

    expect(await resolveRequestOwnerId(request, responseHeaders)).toBe(`anon:${id}`);
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('sets a long-lived, HTTP-only, SameSite=Lax cookie at the root path', async () => {
    const responseHeaders = new Headers();

    await resolveRequestOwnerId(new Request('http://localhost/agent'), responseHeaders);

    expect(responseHeaders.get('set-cookie')).toMatch(
      /^anonymous_id=[0-9a-f-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/i,
    );
  });

  it('adds Secure to the cookie when COOKIE_SECURE is opted in', async () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    const responseHeaders = new Headers();

    await resolveRequestOwnerId(new Request('https://example.test/agent'), responseHeaders);

    expect(responseHeaders.get('set-cookie')).toMatch(/; Secure$/);
  });

  it('uses an explicit authenticated owner without minting an anonymous cookie', async () => {
    const responseHeaders = new Headers();

    const ownerId = await resolveRequestOwnerId(
      new Request('http://localhost/agent'),
      responseHeaders,
      'user-42',
    );

    expect(ownerId).toBe('user-42');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('prefers an authenticated owner over an existing anonymous cookie', async () => {
    const responseHeaders = new Headers();
    const request = new Request('http://localhost/agent', {
      headers: { cookie: 'anonymous_id=a652e716-0e2e-47f5-8432-4ee60f6f0977' },
    });

    expect(await resolveRequestOwnerId(request, responseHeaders, 'user-42')).toBe('user-42');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });
});
