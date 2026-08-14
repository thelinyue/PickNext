import { expect, test } from '@playwright/test';

test('移动端 PWA 管理后台顶部按钮可见且可点击', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))).toBeTruthy();

  await page.getByLabel('用户名').fill('browser-admin');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '完成初始化' }).click();
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: /管理后台/ }).click();

  const topbar = page.locator('.admin-topbar');
  await expect(topbar).toBeVisible();
  const viewport = page.viewportSize()!;
  for (const button of [
    page.getByRole('button', { name: '打开管理模块' }),
    page.getByRole('button', { name: '刷新管理后台' }),
    page.getByRole('button', { name: '返回用户端' }),
  ]) {
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }

  await page.getByRole('button', { name: '打开管理模块' }).click();
  await expect(page.locator('.admin-mobile-drawer')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.admin-mobile-drawer')).toBeHidden();

  await page.getByRole('button', { name: '刷新管理后台' }).click();
  await expect(page.getByText('管理后台数据已刷新。')).toBeVisible();
  await page.getByRole('button', { name: '返回用户端' }).click();
  await expect(page.getByRole('heading', { name: 'browser-admin' })).toBeVisible();
});
