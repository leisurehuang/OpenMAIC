import { NextRequest, NextResponse } from 'next/server';

import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Verify an HMAC-signed token using Web Crypto API (Edge-compatible) */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(timestamp);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * 验证登录会话 cookie `<userId>.<token>.<hmac>` 的签名（Edge 版，与
 * lib/server/auth.ts 的 parseSessionCookieValue / sessionSigningSecret 保持
 * 一致）。验签通过≠会话仍有效，数据库校验在 Node 路由层。
 */
async function verifySessionCookie(value: string): Promise<boolean> {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [userId, token, signature] = parts;
  if (
    userId.length !== 16 ||
    token.length !== 64 ||
    signature.length !== 64 ||
    !/^[0-9a-f]+$/.test(userId + token + signature)
  ) {
    return false;
  }
  const secret = process.env.OPENMAIC_SESSION_SECRET?.trim() || process.env.PERSISTENCE_DEV_TOKEN;
  if (!secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = bufToHex(
    await crypto.subtle.sign('HMAC', key, encode(`${userId}.${token}`).buffer as ArrayBuffer),
  );
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- 登录认证门（OPENMAIC_AUTH_REQUIRED=true 时启用，优先于访问码）---
  // Edge 无法查库：这里验签 cookie 的自包含 HMAC 签名（与
  // lib/server/auth.ts 的 parseSessionCookieValue 保持一致），保证没有
  // 密钥的访问者无法伪造任何“看起来登录了”的请求。数据库侧的会话校验
  // 与吊销仍在 Node 路由层完成。
  const authRequired = /^(true|1)$/i.test((process.env.OPENMAIC_AUTH_REQUIRED ?? '').trim());
  if (authRequired) {
    // 白名单：登录页、认证接口、健康检查
    if (pathname === '/login' || pathname.startsWith('/api/auth/') || pathname === '/api/health') {
      return NextResponse.next();
    }

    const session = request.cookies.get('openmaic_session')?.value;
    if (session && (await verifySessionCookie(session))) {
      return NextResponse.next();
    }

    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: 'Authentication required' },
        { status: 401 },
      );
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  // --- 访问码门（原有机制，登录认证未启用时生效）---

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
