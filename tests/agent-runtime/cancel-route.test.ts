import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestCancel: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-1',
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    requestCancel: mocks.requestCancel,
  }),
}));

import { POST } from '@/app/api/agent/sessions/[id]/cancel/route';

function call() {
  return POST(new NextRequest('http://localhost/api/agent/sessions/session-1/cancel'), {
    params: Promise.resolve({ id: 'session-1' }),
  });
// 登录是标准流程：withRequestOwnerId 现在以登录会话为所有者分区来源，
// 测试固定一个会话用户，让身份解析不依赖真实数据库。
vi.mock('@/lib/server/auth', () => ({
  isAuthRequired: () => true,
  resolveSessionUser: async () => ({ id: 'u1', name: 'lei' }),
}));

}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'running' });
});

describe('POST agent session cancellation', () => {
  it('durably requests cancellation for an owned live session', async () => {
    const response = await call();

    expect(response.status).toBe(202);
    expect(mocks.requestCancel).toHaveBeenCalledWith('session-1');
    await expect(response.json()).resolves.toEqual({ id: 'session-1', cancelRequested: true });
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'returns a structured terminal conflict for %s',
    async (status) => {
      mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status });

      const response = await call();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: 'SESSION_ALREADY_TERMINAL',
        status,
        error: `session is already ${status}`,
      });
      expect(mocks.requestCancel).not.toHaveBeenCalled();
    },
  );

  it('hides a foreign session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-2', status: 'running' });

    expect((await call()).status).toBe(404);
    expect(mocks.requestCancel).not.toHaveBeenCalled();
  });
});
