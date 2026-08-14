import { expect, test } from '@playwright/test';

test('空会唱曲库可进入全部曲库并完成搜索收录', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('用户名').fill('library-ux-user');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '完成初始化' }).click();

  await page.getByRole('button', { name: '曲库', exact: true }).click();
  await expect(page.getByRole('button', { name: '去全部曲库选歌' })).toBeVisible();
  await page.getByRole('button', { name: '去全部曲库选歌' }).click();
  await expect(page.getByRole('tab', { name: /全部曲库/ })).toHaveAttribute('data-state', 'active');

  await page.locator('header').getByRole('button', { name: '添加歌曲' }).click();
  const addSong = page.getByRole('dialog', { name: '添加歌曲' });
  await addSong.locator('select[name="collectionType"]').selectOption({ label: '仅添加到全部曲库（不加入我的个人曲库）' });
  await addSong.getByLabel('歌名').fill('防抖测试歌曲');
  await addSong.getByLabel('歌手').fill('测试歌手');
  await addSong.getByRole('button', { name: '添加歌曲' }).click();

  const search = page.getByRole('textbox', { name: '搜索歌曲' });
  await search.fill('防');
  await search.fill('防抖测试');
  await expect(page.getByText('防抖测试歌曲')).toBeVisible();
  const alphabetRail = page.locator('.alphabet-rail');
  await expect(alphabetRail).toBeVisible();
  const railBefore = await alphabetRail.boundingBox();
  expect(await alphabetRail.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
  expect(Math.abs((railBefore!.y + railBefore!.height / 2) - 844 / 2)).toBeLessThan(2);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const railAfter = await alphabetRail.boundingBox();
  expect(Math.abs(railAfter!.y - railBefore!.y)).toBeLessThan(2);
  await page.getByRole('button', { name: '查看防抖测试歌曲详情' }).click();
  await page.getByRole('button', { name: '我会唱，加入会唱曲库' }).click();
  await expect(page.getByRole('status')).toContainText('已加入会唱曲库');
  await expect(page.locator('.collection-badge.repertoire')).toHaveText('会唱');
});
