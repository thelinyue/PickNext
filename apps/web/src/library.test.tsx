import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryPage } from './library.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const counts = { personal: 1, repertoire: 1, learning: 0, global: 1 };
const personalSong = {
  scope: 'personal', id: 1, title: '晴天', artist: '周杰伦', version: null,
  language: '国语', genre: '流行', performanceType: 'solo', titleInitial: 'Q', collectionType: 'repertoire',
  personalDifficulty: 'medium', rating: 4, keyShift: 0, playCount: 0,
  lastPlayedAt: null, hasLyrics: false, hasNote: false, hasMemoryCue: false, snoozedUntil: null
};
const globalSong = {
  scope: 'global', id: 2, title: '全站歌曲', artist: '歌手', version: null,
  language: '国语', genre: '流行', performanceType: 'solo', titleInitial: 'Q', collectionType: null,
  referenceDifficulty: 'medium', aggregateRating: null, aggregateRatingCount: null
};

function stubLibraryApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/api/search?')) {
      const scope = new URL(path, 'http://localhost').searchParams.get('scope');
      return new Response(JSON.stringify({
        songs: [scope === 'global' ? globalSong : personalSong], total: 1, hasMore: false, counts,
        facets: { languages: [], genres: [] }, alphabetIndex: [{ initial: 'Q', count: 1, offset: 0 }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.includes('/api/playlists/next-ktv')) return new Response(JSON.stringify({ playlist: null, songs: [] }), { status: 200 });
    return new Response(JSON.stringify({ playlists: [] }), { status: 200 });
  }));
}

function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LibraryPage notify={vi.fn()} canEditGlobal={false} /></QueryClientProvider>);
}

describe('移动端曲库标签', () => {
  it('可以切换会唱、待学和全部曲库', async () => {
    stubLibraryApi();
    renderLibrary();

    const repertoire = await screen.findByRole('tab', { name: /会唱/ });
    const learning = screen.getByRole('tab', { name: /待学/ });
    const global = screen.getByRole('tab', { name: /全部曲库/ });
    expect(repertoire).toHaveAttribute('data-state', 'active');

    fireEvent.mouseDown(learning, { button: 0, ctrlKey: false });
    expect(learning).toHaveAttribute('data-state', 'active');
    expect(repertoire).toHaveAttribute('data-state', 'inactive');

    fireEvent.mouseDown(global, { button: 0, ctrlKey: false });
    expect(global).toHaveAttribute('data-state', 'active');
  });

  it('问号提示可点击、不会切换标签，并支持 Escape 关闭', async () => {
    stubLibraryApi();
    renderLibrary();

    const repertoire = await screen.findByRole('tab', { name: /会唱/ });
    const helpCases = [
      ['显示全部曲库说明', '全站共享歌曲，只展示公共资料和匿名评分。'],
      ['显示会唱说明', '普通 Pick 只从会唱曲库选择歌曲。'],
      ['显示待学说明', '正在学习的歌曲不会进入普通 Pick。']
    ] as const;
    for (const [label, message] of helpCases) {
      const help = screen.getByRole('button', { name: label });
      fireEvent.click(help);
      expect(repertoire).toHaveAttribute('data-state', 'active');
      expect(help).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('tooltip')).toHaveTextContent(message);
      fireEvent.click(help);
      expect(screen.queryByRole('tooltip')).toBeNull();
    }

    const help = screen.getByRole('button', { name: '显示会唱说明' });
    fireEvent.click(help);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(help).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseDown(screen.getByRole('tab', { name: /待学/ }), { button: 0, ctrlKey: false });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
