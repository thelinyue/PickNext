import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, Button, EmptyState, NetworkBanner, Sheet, SongCard } from './components.js';
import { FirstUseGuide, SkipSuggestionSheet } from './pick.js';
import { parseSharedSong } from './App.js';
import { ImportSheet } from './me.js';
import { AdminUsersPage } from './admin-users.js';
import { AuthScreen } from './auth.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('基础界面组件', () => {
  it('禁用按钮不冒充加载状态', () => {
    const view = render(<Button disabled>创建歌单</Button>);
    expect(screen.getByRole('button', { name: '创建歌单' }).getAttribute('aria-busy')).toBeNull();
    expect(view.container.querySelector('.spin')).toBeNull();
    view.rerender(<Button loading>创建歌单</Button>);
    expect(screen.getByRole('button', { name: '创建歌单' }).getAttribute('aria-busy')).toBe('true');
    expect(view.container.querySelector('.spin')).not.toBeNull();
  });
  it('空状态提供清晰说明和操作', () => {
    render(<EmptyState title="曲库还是空的" description="先添加一首歌" action={<button>添加歌曲</button>} />);
    expect(screen.getByText('曲库还是空的')).not.toBeNull();
    expect(screen.getByRole('button', { name: '添加歌曲' }).textContent).toBe('添加歌曲');
  });

  it('SongCard 保留至少一个明确的可点击入口', () => {
    const click = vi.fn();
    render(<SongCard variant="personal-repertoire" song={{
      scope: 'personal', id: 1, title: '晴天', artist: '周杰伦', version: null,
      language: '国语', genre: '流行', performanceType: 'solo', titleInitial: 'Q', collectionType: 'repertoire',
      personalDifficulty: 'medium', rating: 4, keyShift: -1, playCount: 3,
      lastPlayedAt: null, hasLyrics: true, hasNote: true, hasMemoryCue: false, snoozedUntil: null
    }} onClick={click} />);
    fireEvent.click(screen.getByText('晴天'));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByText('★★★★☆')).not.toBeNull();
    expect(screen.getByText('唱过 3 次')).not.toBeNull();
  });

  it('全部曲库卡片只展示公共资料和匿名聚合评分', () => {
    render(<SongCard variant="global" song={{
      scope: 'global', id: 2, title: '全站歌曲', artist: '歌手', version: 'Live',
      language: '粤语', genre: '摇滚', performanceType: 'duet', titleInitial: 'Q', collectionType: null,
      referenceDifficulty: 'hard', aggregateRating: 4.3, aggregateRatingCount: 3
    }} />);
    expect(screen.getByText('未收录')).not.toBeNull();
    expect(screen.getByText('★ 4.3 · 3人')).not.toBeNull();
    expect(screen.queryByText(/Key/)).toBeNull();
  });

  it('底部 Pick 主按钮展示五种状态并发出独立动作', () => {
    const navigate = vi.fn();
    const pickAction = vi.fn();
    const view = render(<AppShell page="library" onNavigate={navigate} onPickAction={pickAction} pickState="idle"><p>曲库</p></AppShell>);
    fireEvent.click(screen.getByRole('button', { name: '开始 Pick' }));
    expect(pickAction).toHaveBeenCalledOnce();
    view.rerender(<AppShell page="library" onNavigate={navigate} onPickAction={pickAction} pickState="continue"><p>曲库</p></AppShell>);
    expect(screen.getByRole('button', { name: '返回当前歌曲' })).not.toBeNull();
    view.rerender(<AppShell page="pick" onNavigate={navigate} onPickAction={pickAction} pickState="switch"><p>Pick</p></AppShell>);
    expect(screen.getByRole('button', { name: '跳过这首' })).not.toBeNull();
    view.rerender(<AppShell page="pick" onNavigate={navigate} onPickAction={pickAction} pickState="loading"><p>Pick</p></AppShell>);
    expect(screen.getByRole('button', { name: '正在抽取' }).getAttribute('aria-busy')).toBe('true');
    view.rerender(<AppShell page="pick" onNavigate={navigate} onPickAction={pickAction} pickState="exhausted"><p>Pick</p></AppShell>);
    expect(screen.getByRole('button', { name: '处理本场' })).not.toBeNull();
  });

  it('Sheet 可关闭且标题可访问', () => {
    const change = vi.fn();
    render(<Sheet open onOpenChange={change} title="Pick 筛选"><p>筛选内容</p></Sheet>);
    expect(screen.getByRole('dialog', { name: 'Pick 筛选' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(change).toHaveBeenCalledWith(false);
  });

  it('首次使用引导解释曲库状态并直达选歌', () => {
    const open = vi.fn();
    render(<FirstUseGuide globalCount={3} canAddSongs={false} onOpenGlobalLibrary={open} />);
    expect(screen.getByText(/会唱歌曲会进入普通 Pick/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '去全部曲库选歌' }));
    expect(open).toHaveBeenCalledOnce();
  });

  it('离线横幅说明已加载内容仍可查看', () => {
    render(<NetworkBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('已加载内容仍可查看');
  });

  it('独立用户管理页展示服务端统计并支持进入多选模式', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/setup/status')) return new Response(JSON.stringify({ required: false, registrationOpen: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        users: [{ id: 2, username: 'linyue', role: 'user', isMaintainer: false, canAddSongs: true, createdAt: '2026-08-01 12:00:00', lastLoginAt: null, personalSongCount: 12 }],
        total: 1, hasMore: false, summary: { total: 1, maintainers: 0, addSongsDenied: 0, neverLoggedIn: 1 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AdminUsersPage onBack={vi.fn()} notify={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByText('linyue')).not.toBeNull();
    expect(screen.getByLabelText('允许普通用户注册')).not.toBeNull();
    expect(screen.getByText(/12 首个人歌曲 · 可添加歌曲/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    fireEvent.click(screen.getByRole('button', { name: '选择linyue' }));
    expect(screen.getByText('已选 1/50')).not.toBeNull();
    expect(screen.getByRole('button', { name: /删除/ })).not.toBeNull();
  });

  it('开放注册时登录页显示普通用户注册入口', () => {
    render(<AuthScreen setupRequired={false} registrationOpen onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: '没有账号？立即注册' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '没有账号？立即注册' }));
    expect(screen.getByRole('heading', { name: '注册账号' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '注册并登录' })).not.toBeNull();
  });

  it('分享内容转换为可编辑的收歌预填值', () => {
    expect(parseSharedSong(new URLSearchParams({ text: '晴天 - 周杰伦 - Live' }))).toEqual({ title: '晴天', artist: '周杰伦', version: 'Live' });
    expect(parseSharedSong(new URLSearchParams({ title: '富士山下', text: '陈奕迅' }))).toEqual({ title: '富士山下', artist: '陈奕迅' });
    expect(parseSharedSong(new URLSearchParams())).toBeNull();
  });

  it('连续跳过建议提供三个可执行处理动作', () => {
    const action = vi.fn();
    render(<SkipSuggestionSheet suggestion={{ songId: 7, title: '晴天', artist: '周杰伦', version: null }} busy={null} onOpenChange={vi.fn()} onAction={action} />);
    expect(screen.getByText(/晴天.*连续三个不同场次被跳过/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '冷藏 30 天' }));
    fireEvent.click(screen.getByRole('button', { name: '移至待学清单' }));
    fireEvent.click(screen.getByRole('button', { name: '继续保留' }));
    expect(action.mock.calls.map(([value]) => value)).toEqual(['snooze', 'learning', 'keep']);
  });

  it('批量导入展示异步任务完成结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/imports')) return new Response(JSON.stringify({ taskId: '00000000-0000-0000-0000-000000000001' }), { status: 202, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', type: 'song_import', status: 'done', result: JSON.stringify({ imported: 1, reused: 2, needsConfirmation: [] }), error: null, createdAt: '2026-08-13 18:00:00', updatedAt: '2026-08-13 18:00:01' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ImportSheet open onOpenChange={vi.fn()} notify={vi.fn()} /></QueryClientProvider>);
    fireEvent.change(document.querySelector('textarea.import-area')!, { target: { value: '晴天 - 周杰伦' } });
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }));
    expect(await screen.findByText('导入完成')).not.toBeNull();
    expect(screen.getByText('新增 1 首 · 复用 2 首')).not.toBeNull();
  });
});
