import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminConsole } from './admin-console.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderConsole(user: { role: 'admin' | 'user'; isMaintainer: boolean; username: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AdminConsole user={{ ...user, nickname: null, displayName: user.username, avatarUrl: null }} onBack={vi.fn()} notify={vi.fn()} /></QueryClientProvider>);
}

describe('管理后台工作台', () => {
  it('管理员显示完整导航，并可从工作台进入审核队列', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/reviews/count')) return new Response(JSON.stringify({ count: 2 }), { status: 200 });
      if (url.includes('/api/admin/overview')) return new Response(JSON.stringify({ songs: 128, deletedSongs: 3, covers: 100, songsWithoutCover: 4, songsWithoutLyrics: 6, pendingDeletionReviews: 1, pendingLyricsReviews: 1, pendingSongReviews: 0, runningTasks: 1, recentBatches: [] }), { status: 200 });
      if (url.includes('/api/admin/reviews')) return new Response(JSON.stringify({ reviews: [], total: 2, hasMore: false }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderConsole({ role: 'admin', isMaintainer: false, username: 'admin' });
    expect(await screen.findByRole('heading', { name: '今天要处理什么？' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '用户与权限' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '系统设置' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '审核队列' }));
    expect((await screen.findAllByRole('heading', { name: '审核队列' })).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/条待审核内容/)).not.toBeNull();
  });

  it('曲库管家不显示管理员专属模块', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/reviews/count')) return new Response(JSON.stringify({ count: 0 }), { status: 200 });
      return new Response(JSON.stringify({ songs: 0, deletedSongs: 0, covers: 0, songsWithoutCover: 0, songsWithoutLyrics: 0, pendingDeletionReviews: 0, pendingLyricsReviews: 0, pendingSongReviews: 0, runningTasks: 0, recentBatches: [] }), { status: 200 });
    }));

    renderConsole({ role: 'user', isMaintainer: true, username: 'maintainer' });
    expect(await screen.findByRole('heading', { name: '今天要处理什么？' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: '用户与权限' })).toBeNull();
    expect(screen.queryByRole('button', { name: '系统设置' })).toBeNull();
  });
});
