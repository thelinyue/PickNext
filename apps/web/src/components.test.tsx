import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, Button, EmptyState, NetworkBanner, Sheet, SongCard } from './components.js';
import { FirstUseGuide } from './pick.js';

afterEach(cleanup);

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
});
