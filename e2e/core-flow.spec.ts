import { expect, test } from '@playwright/test';

test('移动端曲库收录 → 下一次 KTV → Pick 主按钮切歌 → 唱完 → 历史', async ({ page }) => {
  const requestedPorts = new Set<string>();
  page.on('request', (request) => requestedPorts.add(new URL(request.url()).port));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => fetch('/api/health').then((response) => response.status))).toBe(200);
  await page.getByLabel('用户名').fill('singing-lover');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '完成初始化' }).click();

  await page.getByRole('button', { name: '我的' }).click();
  await page.getByRole('button', { name: /用户与权限/ }).click();
  await page.getByRole('button', { name: '新增用户' }).click();
  await page.getByLabel('用户名').last().fill('e2e-user');
  await page.getByLabel('初始密码').fill('e2e-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByText('e2e-user')).toBeVisible();
  await page.getByRole('dialog', { name: '用户与权限' }).getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '曲库', exact: true }).click();
  await page.locator('header').getByRole('button', { name: '添加歌曲' }).click();
  const performanceSelect = page.getByLabel('演唱类型');
  const collectionSelect = page.getByLabel('先放到');
  await expect(performanceSelect.locator('option')).toHaveText(['独唱', '对唱', '合唱']);
  await expect(collectionSelect.locator('option')).toHaveText(['待学清单', '会唱曲库']);
  await performanceSelect.selectOption('chorus');
  await expect(performanceSelect).toHaveValue('chorus');
  await performanceSelect.selectOption('solo');
  const optionColors = await performanceSelect.locator('option').first().evaluate((option) => {
    const style = getComputedStyle(option);
    return { color: style.color, backgroundColor: style.backgroundColor };
  });
  expect(optionColors.color).not.toBe(optionColors.backgroundColor);
  await page.getByLabel('歌名').fill('晴天');
  await page.getByLabel('歌手').fill('周杰伦');
  await page.getByRole('button', { name: '收进曲库' }).click();
  await expect(page.getByText('晴天')).toBeVisible();
  await page.getByRole('button', { name: '将晴天加入下一次 KTV' }).click();
  await expect(page.getByText('已经准备 1 首 · Pick 时优先')).toBeVisible();
  await page.getByRole('button', { name: /下一次 KTV/ }).first().click();
  await expect(page.getByRole('dialog', { name: '下一次 KTV' }).getByText('晴天')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '下一次 KTV' }).getByRole('button', { name: '添加歌曲' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '下一次 KTV' }).getByRole('button', { name: '清空歌单' })).toBeVisible();
  await page.getByRole('dialog', { name: '下一次 KTV' }).getByRole('button', { name: '关闭' }).click();

  await page.evaluate(async () => {
    const created = await fetch('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: '海阔天空', artist: 'Beyond', language: '粤语', genre: '摇滚', difficulty: 'medium', collectionType: 'learning'
    }) }).then((response) => response.json());
    await fetch(`/api/user-songs/${created.songId}`, { method: 'DELETE' });
  });
  await page.getByRole('tab', { name: /全部曲库/ }).click();
  await expect(page.getByText('海阔天空')).toBeVisible();
  await page.getByRole('button', { name: '＋ 收录' }).click();
  await page.getByRole('button', { name: '加入会唱曲库' }).click();
  await page.getByRole('tab', { name: /我的曲库/ }).click();
  await expect(page.getByText('海阔天空')).toBeVisible();

  await page.getByRole('button', { name: 'Pick 一首' }).click();
  await expect(page.getByRole('heading', { name: '晴天' })).toBeVisible();
  await page.getByRole('button', { name: '换一首' }).click();
  await expect(page.getByRole('heading', { name: '海阔天空' })).toBeVisible();
  await page.getByRole('button', { name: '唱完了' }).click();
  await page.getByRole('button', { name: '保存并下一首' }).click();

  await page.getByRole('button', { name: '我的' }).click();
  await expect(page.getByText('点歌历史')).toBeVisible();
  await expect(page.getByText('海阔天空')).toBeVisible();
  expect([...requestedPorts]).toEqual(['5560']);
});
