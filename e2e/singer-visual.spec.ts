import { expect, test } from '@playwright/test';

test('歌手端深浅主题共用同一组视觉 token', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('用户名').fill('theme-checker');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '完成初始化' }).click();
  await expect(page.locator('.nav-pick-orb')).toBeVisible();

  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const orb = getComputedStyle(document.querySelector('.nav-pick-orb')!);
      const primaryButton = getComputedStyle(document.querySelector('.button')!);
      return {
        bg: root.getPropertyValue('--bg').trim(),
        surface: root.getPropertyValue('--surface').trim(),
        accent: root.getPropertyValue('--accent').trim(),
        orbImage: orb.backgroundImage,
        primaryImage: primaryButton.backgroundImage,
      };
    });
    expect(tokens.bg).not.toBe(tokens.surface);
    expect(tokens.accent).not.toBe('');
    expect(tokens.orbImage).toBe('none');
    expect(tokens.primaryImage).toBe('none');
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animationDuration = await page.locator('.nav-pick-orb').evaluate((element) => getComputedStyle(element, '::before').animationDuration);
  const seconds = animationDuration.endsWith('ms') ? Number.parseFloat(animationDuration) / 1000 : Number.parseFloat(animationDuration);
  expect(seconds).toBeLessThanOrEqual(.001);

  await page.getByRole('button', { name: '我的' }).click();
  await page.getByRole('button', { name: '编辑个人信息' }).click();
  const themeSelect = page.getByLabel('界面主题');
  await expect(themeSelect).toBeVisible();
  await themeSelect.selectOption('dark');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('picknext-theme'))).toBe('dark');
  await themeSelect.selectOption('light');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('light');
  await themeSelect.selectOption('system');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(null);
});
