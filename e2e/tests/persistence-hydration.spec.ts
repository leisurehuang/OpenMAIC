// 冷启动竞态回归：登录态下刷新首页，设置 store 的首次读完成前若发生
// 初始化器写，会打出 "Refusing to persist ... unhydrated"（ERROR）。
// 并行探测 + 模块加载预热把首次读收敛到并行单往返后，该窗口不再触发。
import { expect, test as baseTest } from '@playwright/test';

const USERNAME = process.env.E2E_USERNAME ?? 'lei';
const PASSWORD = process.env.E2E_PASSWORD ?? 'test12345';

// 本地 chromium 下载不可用时回退系统 Chrome；优先仓库默认 chromium。
const test = baseTest.extend({});
if (process.env.E2E_USE_SYSTEM_CHROME === '1') {
  test.use({ channel: 'chrome' });
}

test('cold start does not refuse settings persistence while unhydrated', async ({ page }) => {
  const refusals: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') refusals.push(msg.text());
  });

  await page.goto('/login');
  await page.getByPlaceholder('用户名').fill(USERNAME);
  await page.getByPlaceholder('密码').fill(PASSWORD);
  await page
    .getByRole('button', { name: /登录|注册并登录|Sign in|Log in/i })
    .first()
    .click();
  await page.waitForURL('/');

  // 再硬刷新一次：真正的冷启动（模块加载 → persist hydrate → 初始化器写）。
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const unhydrated = refusals.filter((t) => t.includes('Refusing to persist'));
  expect(unhydrated, unhydrated.join('\n')).toEqual([]);
});
