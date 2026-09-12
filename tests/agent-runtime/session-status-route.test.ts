import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  listSessionsByOwner: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
  isAgentRuntimeConfigured: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: () => 'owner-1',
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ listSessionsByOwner: mocks.listSessionsByOwner }),
}));

import { GET } from '@/app/api/agent/sessions/status/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.listSessionsByOwner.mockResolvedValue([
    { id: 'session-queued', status: 'queued' },
    { id: 'session-running', status: 'running' },
    { id: 'session-done', status: 'succeeded' },
  ]);
});
// 登录是标准流程：withRequestOwnerId 现在以登录会话为所有者分区来源，
// 测试固定一个会话用户，让身份解析不依赖真实数据库。
vi.mock('@/lib/server/auth', () => ({
  isAuthRequired: () => true,
  resolveSessionUser: async () => ({ id: 'u1', name: 'lei' }),
}));


describe('GET agent session status map', () => {
  it('builds an id-to-status mapping from the owner session list', async () => {
    const response = await GET(new NextRequest('http://localhost/api/agent/sessions/status'));

    expect(response.status).toBe(200);
    expect(mocks.listSessionsByOwner).toHaveBeenCalledWith('owner-1');
    await expect(response.json()).resolves.toEqual({
      'session-queued': 'queued',
      'session-running': 'running',
      'session-done': 'succeeded',
    });
  });

  it('stays behind the runtime feature gate', async () => {
    mocks.runtimeEnabled = false;

    expect((await GET(new NextRequest('http://localhost/api/agent/sessions/status'))).status).toBe(
      404,
    );
    expect(mocks.listSessionsByOwner).not.toHaveBeenCalled();
  });
});
