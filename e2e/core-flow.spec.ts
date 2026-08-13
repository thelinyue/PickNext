import { expect, test } from '@playwright/test';

test.describe.serial('PickNext v1.0 移动端核心闭环', () => {
  test('管理员建用户 → 添加维护歌曲 → KTV 清空/重加 → Pick 跟唱评分 → 唱完移出', async ({ page }) => {
    const requestedPorts = new Set<string>();
    let pickRequests = 0;
    page.on('request', (request) => requestedPorts.add(new URL(request.url()).port));
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/picks') pickRequests += 1; });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => fetch('/api/health').then((response) => response.status))).toBe(200);
    await page.getByLabel('用户名').fill('singing-lover');
    await page.getByLabel('密码').fill('password123');
    await page.getByRole('button', { name: '完成初始化' }).click();
    for (const viewport of [{ width: 360, height: 740 }, { width: 432, height: 698 }, { width: 476, height: 891 }]) {
      await page.setViewportSize(viewport);
      const pickButton = await page.getByRole('button', { name: '开始 Pick' }).boundingBox();
      const orb = await page.locator('.nav-pick-orb').boundingBox();
      const navigation = await page.getByRole('navigation', { name: '主导航' }).boundingBox();
      const library = await page.getByRole('button', { name: '曲库', exact: true }).boundingBox();
      const me = await page.getByRole('button', { name: '我的' }).boundingBox();
      expect(Math.abs(pickButton!.x + pickButton!.width / 2 - viewport.width / 2)).toBeLessThan(1);
      expect(navigation!.y - orb!.y).toBeGreaterThanOrEqual(14);
      expect(navigation!.y - orb!.y).toBeLessThanOrEqual(18);
      expect(Math.abs((viewport.width / 2 - (library!.x + library!.width / 2)) - ((me!.x + me!.width / 2) - viewport.width / 2))).toBeLessThan(1);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedDuration = await page.locator('.nav-pick-orb').evaluate((element) => getComputedStyle(element, '::before').animationDuration);
    const reducedSeconds = reducedDuration.endsWith('ms') ? Number.parseFloat(reducedDuration) / 1000 : Number.parseFloat(reducedDuration);
    expect(reducedSeconds).toBeLessThanOrEqual(.001);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.goto('/?text=分享歌曲%20-%20分享歌手%20-%20Live');
    const shareSheet = page.getByRole('dialog', { name: '添加歌曲' });
    await expect(shareSheet).toBeVisible();
    await expect(shareSheet.getByLabel('歌名')).toHaveValue('分享歌曲');
    await expect(shareSheet.getByLabel('歌手')).toHaveValue('分享歌手');
    await expect(shareSheet.getByLabel('版本')).toHaveValue('Live');
    await shareSheet.getByRole('button', { name: '关闭' }).click();
    await page.getByRole('button', { name: '我的' }).click();
    await page.getByRole('button', { name: '批量收歌' }).click();
    const importSheet = page.getByRole('dialog', { name: '批量收歌' });
    await importSheet.locator('textarea.import-area').fill('title,artist,version\nCSV导入歌曲,CSV歌手,现场版');
    await importSheet.getByLabel('导入格式').selectOption('csv');
    await importSheet.getByRole('button', { name: '开始导入' }).click();
    await expect(importSheet.getByText('导入完成')).toBeVisible();
    await expect(importSheet.getByText('新增 1 首 · 复用 0 首')).toBeVisible();
    await importSheet.getByRole('button', { name: '关闭' }).click();

    await page.getByRole('button', { name: '我的' }).click();
    await page.getByRole('button', { name: /用户与权限/ }).click();
    await page.getByLabel('允许普通用户注册').click();
    await expect(page.getByLabel('允许普通用户注册')).toBeChecked();
    await page.getByRole('button', { name: '新增用户' }).click();
    const createUser = page.getByRole('dialog', { name: '新增用户' });
    await createUser.getByLabel('用户名').fill('e2e-user');
    await createUser.getByLabel('初始密码').fill('e2e-password');
    await createUser.getByRole('button', { name: '创建账号' }).click();
    await expect(page.getByText('e2e-user')).toBeVisible();
    await page.getByRole('button', { name: /e2e-user/ }).click();
    await page.getByRole('dialog', { name: 'e2e-user' }).getByRole('button', { name: '永久删除该用户' }).click();
    const deleteUser = page.getByRole('dialog', { name: '永久删除用户' });
    await deleteUser.getByLabel('当前管理员密码').fill('password123');
    await deleteUser.getByLabel('我了解这些个人数据无法恢复').check();
    await deleteUser.getByRole('button', { name: '永久删除该用户' }).click();
    await expect(page.getByText('e2e-user')).toHaveCount(0);
    await page.getByRole('button', { name: '返回我的页面' }).click();

    await page.getByRole('button', { name: '曲库', exact: true }).click();
    await page.locator('header').getByRole('button', { name: '添加歌曲' }).click();
    const globalOnlySheet = page.getByRole('dialog', { name: '添加歌曲' });
    await globalOnlySheet.locator('select[name="collectionType"]').selectOption({ label: '仅添加到全部曲库（不加入我的个人曲库）' });
    await globalOnlySheet.getByLabel('歌名').fill('全局维护歌曲');
    await globalOnlySheet.getByLabel('歌手').fill('维护歌手');
    await globalOnlySheet.getByRole('button', { name: '添加歌曲' }).click();
    await page.getByRole('tab', { name: /全部曲库/ }).click();
    await expect(page.getByText('全局维护歌曲')).toBeVisible();
    await expect(page.locator('.collection-badge.uncollected')).toHaveText('未收录');
    await page.getByRole('tab', { name: /我的曲库/ }).click();
    await page.locator('header').getByRole('button', { name: '添加歌曲' }).click();
    await page.getByText('高级选项', { exact: true }).click();
    await page.getByLabel('演唱类型').selectOption('solo');
    await page.locator('select[name="collectionType"]').selectOption('repertoire');
    await page.getByLabel('歌名').fill('晴天');
    await page.getByLabel('歌手').fill('周杰伦');
    await page.getByRole('button', { name: '添加歌曲' }).click();
    await expect(page.getByText('晴天')).toBeVisible();

    await page.getByRole('button', { name: '查看晴天详情' }).click();
    await page.getByRole('button', { name: '编辑全局歌曲信息' }).click();
    const editSong = page.getByRole('dialog', { name: '编辑全局歌曲' });
    await editSong.getByLabel('版本').fill('原版');
    await editSong.getByLabel('语种').fill('国语');
    await editSong.getByLabel('曲风').fill('流行');
    await editSong.getByLabel('参考难度').selectOption('medium');
    await editSong.getByLabel('LRC / 歌词').fill('[00:01.00]故事的小黄花\n[00:03.00]从出生那年就飘着\n[00:05.00]童年的荡秋千');
    await editSong.getByRole('button', { name: '保存全局信息' }).click();
    await expect(editSong).toBeHidden();

    await page.getByRole('button', { name: '将晴天加入下一次 KTV' }).click();
    await expect(page.getByText('已经准备 1 首 · Pick 时优先')).toBeVisible();
    await page.getByRole('button', { name: /下一次 KTV/ }).first().click();
    const ktvSheet = page.getByRole('dialog', { name: '下一次 KTV' });
    await ktvSheet.getByRole('button', { name: '清空歌单' }).click();
    await ktvSheet.getByRole('button', { name: '确认清空' }).click();
    await expect(ktvSheet.getByText('还没有准备歌曲')).toBeVisible();
    await ktvSheet.getByRole('button', { name: '关闭' }).click();
    await page.getByRole('button', { name: '将晴天加入下一次 KTV' }).click();

    await page.evaluate(async () => {
      const created = await fetch('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        title: '海阔天空', artist: 'Beyond', language: '粤语', genre: '摇滚', difficulty: 'medium', collectionType: 'learning'
      }) }).then((response) => response.json());
      await fetch(`/api/user-songs/${created.songId}`, { method: 'DELETE' });
    });
    await page.getByRole('tab', { name: /全部曲库/ }).click();
    await expect(page.getByText('海阔天空')).toBeVisible();
    await page.getByRole('button', { name: '查看海阔天空详情' }).click();
    await page.getByRole('button', { name: '加入会唱曲库' }).click();

    await page.getByRole('tab', { name: /我的曲库/ }).click();
    await page.getByRole('button', { name: '批量管理' }).click();
    await page.getByRole('checkbox', { name: '选择晴天' }).check();
    await page.getByRole('checkbox', { name: '选择海阔天空' }).check();
    await page.getByRole('button', { name: '选择操作' }).click();
    await page.getByRole('button', { name: '移入会唱曲库' }).click();
    await expect(page.getByRole('status')).toContainText('已批量移入会唱曲库');

    await page.getByRole('button', { name: '开始 Pick' }).click();
    await expect(page.getByRole('heading', { name: '晴天' })).toBeVisible();
    await expect(page.getByRole('button', { name: '跳过这首' })).toBeVisible();
    expect(pickRequests).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: '晴天' })).toBeVisible();
    expect(pickRequests).toBe(1);
    await page.context().setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: '当前处于离线状态' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '晴天' })).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByText('网络已恢复，正在刷新数据。')).toBeVisible();
    await expect(page.getByText('故事的小黄花')).toBeVisible();
    await page.getByRole('button', { name: /歌词计时跟唱/ }).click();
    const karaoke = page.getByRole('dialog', { name: '晴天歌词计时跟唱' });
    await karaoke.getByRole('button', { name: '开始计时' }).click();
    await karaoke.getByRole('button', { name: '暂停' }).click();
    await karaoke.getByRole('button', { name: '关闭跟唱' }).click();

    await page.getByRole('button', { name: '我的' }).click();
    await page.getByRole('button', { name: '返回当前歌曲' }).click();
    await expect(page.getByRole('heading', { name: '晴天' })).toBeVisible();
    expect(pickRequests).toBe(1);
    await page.getByRole('button', { name: '唱完了' }).click();
    const rating = page.getByRole('dialog', { name: '第一次唱完' });
    await expect(rating).toBeVisible();
    await rating.getByRole('button', { name: '保存并下一首' }).click();
    const ktvFinished = page.getByRole('dialog', { name: '下一次 KTV 已唱完' });
    await expect(ktvFinished).toBeVisible();
    await ktvFinished.getByRole('button', { name: '继续唱会唱曲库' }).click();
    await expect(page.getByRole('heading', { name: '海阔天空' })).toBeVisible();
    await page.getByRole('button', { name: '跳过这首' }).click();
    await expect(page.getByRole('button', { name: '处理本场' })).toBeVisible();

    await page.getByRole('button', { name: '曲库', exact: true }).click();
    await page.getByRole('button', { name: /下一次 KTV/ }).first().click();
    await expect(page.getByRole('dialog', { name: '下一次 KTV' }).getByText('还没有准备歌曲')).toBeVisible();
    await page.getByRole('dialog', { name: '下一次 KTV' }).getByRole('button', { name: '关闭' }).click();
    await page.getByRole('button', { name: '我的' }).click();
    await expect(page.getByText('点歌历史')).toBeVisible();
    await page.getByRole('button', { name: /点歌历史/ }).click();
    const historyDialog = page.getByRole('dialog', { name: '点歌历史' });
    await historyDialog.locator('details').first().locator('summary').click();
    await expect(historyDialog.getByText('晴天')).toBeVisible();
    await expect(historyDialog.getByText('海阔天空')).toBeVisible();
    await expect(historyDialog.locator('.history-status.skipped')).toHaveText('未唱');
    expect([...requestedPorts]).toEqual([process.env.E2E_PORT ?? '5560']);
  });

  test('开放注册后普通用户可注册、自动登录、使用个人曲库并重新登录', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '没有账号？立即注册' }).click();
    await page.getByLabel('用户名').fill('registered-user');
    await page.getByLabel('密码').fill('registered-password');
    await page.getByRole('button', { name: '注册并登录' }).click();
    await expect(page.getByText('先准备你的会唱曲库')).toBeVisible();
    await page.getByRole('button', { name: '去全部曲库选歌' }).click();
    await expect(page.getByRole('tab', { name: /全部曲库/ })).toHaveAttribute('data-state', 'active');
    await page.locator('header').getByRole('button', { name: '添加歌曲' }).click();
    await page.getByRole('textbox', { name: '歌名', exact: true }).fill('普通用户的歌');
    await page.getByLabel('歌手').fill('测试歌手');
    await page.locator('select[name="collectionType"]').selectOption('repertoire');
    await page.getByRole('button', { name: '添加歌曲' }).click();
    await expect(page.getByText('普通用户的歌')).toBeVisible();
    expect(await page.evaluate(() => fetch('/api/songs/1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '越权', artist: '测试', performanceType: 'solo' }) }).then((response) => response.status))).toBe(403);
    await page.getByRole('button', { name: '开始 Pick' }).click();
    await expect(page.getByRole('heading', { name: '普通用户的歌' })).toBeVisible();
    await page.getByRole('button', { name: '唱完了' }).click();
    await page.getByRole('dialog', { name: '第一次唱完' }).getByRole('button', { name: '保存并下一首' }).click();
    await expect(page.getByRole('button', { name: '处理本场' })).toBeVisible();
    await page.getByRole('button', { name: '处理本场' }).click();
    await expect(page.getByRole('dialog', { name: '本场已经唱完' })).toBeVisible();
    await page.getByRole('dialog', { name: '本场已经唱完' }).getByRole('button', { name: '结束本场' }).click();
    await page.getByRole('button', { name: '我的' }).click();
    await expect(page.getByRole('heading', { name: 'registered-user' })).toBeVisible();
    await expect(page.getByRole('button', { name: /用户与权限/ })).toHaveCount(0);
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('用户名').fill('registered-user');
    await page.getByLabel('密码').fill('registered-password');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '我的' }).click();
    await expect(page.getByRole('heading', { name: 'registered-user' })).toBeVisible();
  });

  test('连续三场跳过会唱歌曲后可从界面执行冷藏', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('用户名').fill('singing-lover');
    await page.getByLabel('密码').fill('password123');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('button', { name: '开始 Pick' })).toBeVisible();
    const sequence = await page.evaluate(async () => {
      const request = async (url: string, init?: RequestInit) => {
        const response = await fetch(url, init);
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? `请求失败：${url}`);
        return body;
      };
      const suffix = String(Date.now());
      const target = await request('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `连续建议目标${suffix}`, artist: '歌手甲', language: '连续建议语种', collectionType: 'repertoire' }) });
      const helper = await request('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `连续建议辅助${suffix}`, artist: '歌手乙', language: '连续建议语种', collectionType: 'repertoire' }) });
      const filters = { languages: ['连续建议语种'], genres: [], difficulties: [], ratings: [], performanceTypes: [] };
      const context = await request('/api/picks/context');
      if (context.sessionId) await request(`/api/pick-sessions/${context.sessionId}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      let final: any;
      for (let index = 0; index < 3; index += 1) {
        await request(`/api/user-songs/${helper.songId}/snooze`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until: '2099-01-01T00:00:00.000Z' }) });
        const picked = await request('/api/picks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), filters, avoidRecent: false }) });
        if (picked.song.id !== target.songId) throw new Error('Pick 未按测试筛选选出连续建议目标。');
        await request(`/api/user-songs/${helper.songId}/snooze`, { method: 'DELETE' });
        final = await request('/api/picks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), sessionId: picked.sessionId, currentEventId: picked.eventId, filters, avoidRecent: false }) });
        if (index < 2) await request(`/api/pick-sessions/${picked.sessionId}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      }
      return { title: target.title ?? `连续建议目标${suffix}`, suggestion: final.skipSuggestion };
    });
    expect(sequence.suggestion).toMatchObject({ title: sequence.title });
    await page.reload();
    const suggestion = page.getByRole('dialog', { name: '这首歌连续 3 场未唱' });
    await expect(suggestion).toBeVisible();
    await suggestion.getByRole('button', { name: '冷藏 30 天' }).click();
    await expect(page.getByRole('status')).toContainText('已冷藏 30 天');
  });
});
