import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, EmptyState, Sheet, SongCard } from './components.js';

afterEach(cleanup);

describe('基础界面组件', () => {
  it('空状态提供清晰说明和操作', () => {
    render(<EmptyState title="曲库还是空的" description="先添加一首歌" action={<button>添加歌曲</button>} />);
    expect(screen.getByText('曲库还是空的')).not.toBeNull();
    expect(screen.getByRole('button', { name: '添加歌曲' }).textContent).toBe('添加歌曲');
  });

  it('SongCard 保留至少一个明确的可点击入口', () => {
    const click = vi.fn();
    render(<SongCard variant="personal-repertoire" song={{
      scope: 'personal', id: 1, title: '晴天', artist: '周杰伦', version: null,
      language: '国语', genre: '流行', performanceType: 'solo', collectionType: 'repertoire',
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
      language: '粤语', genre: '摇滚', performanceType: 'duet', collectionType: null,
      referenceDifficulty: 'hard', aggregateRating: 4.3, aggregateRatingCount: 3
    }} />);
    expect(screen.getByText('未收录')).not.toBeNull();
    expect(screen.getByText('★ 4.3 · 3人')).not.toBeNull();
    expect(screen.queryByText(/Key/)).toBeNull();
  });

  it('底部 Pick 主按钮在其他页面点击时发出 Pick 导航动作', () => {
    const navigate = vi.fn();
    render(<AppShell page="library" onNavigate={navigate}><p>曲库</p></AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Pick 一首' }));
    expect(navigate).toHaveBeenCalledWith('pick');
  });

  it('Sheet 可关闭且标题可访问', () => {
    const change = vi.fn();
    render(<Sheet open onOpenChange={change} title="Pick 筛选"><p>筛选内容</p></Sheet>);
    expect(screen.getByRole('dialog', { name: 'Pick 筛选' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(change).toHaveBeenCalledWith(false);
  });
});
