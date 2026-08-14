import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function stubLibraryApi(options: { emptyPersonal?: boolean; noSearchResults?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const path = String(input);
    const url = new URL(path, 'http://localhost');
    const scope = url.searchParams.get('scope');
    const hasSearchResult = !options.noSearchResults || !url.searchParams.get('q');
    const songs = !hasSearchResult || (options.emptyPersonal && scope === 'personal') ? [] : [scope === 'global' ? globalSong : personalSong];
    const responseCounts = options.emptyPersonal ? { ...counts, personal: 0, repertoire: 0 } : counts;
    if (path.includes('/api/search/quick?')) {
      return new Response(JSON.stringify({ songs, hasMore: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.includes('/api/search/meta?')) {
      return new Response(JSON.stringify({ total: songs.length, counts: responseCounts, facets: { languages: [], genres: [] }, alphabetIndex: songs.length ? [{ initial: 'Q', count: 1, offset: 0 }] : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.includes('/api/search?')) {
      return new Response(JSON.stringify({
        songs, total: songs.length, hasMore: false, counts: responseCounts,
        facets: { languages: [], genres: [] }, alphabetIndex: [{ initial: 'Q', count: 1, offset: 0 }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.includes('/api/playlists/next-ktv')) return new Response(JSON.stringify({ playlist: null, songs: [] }), { status: 200 });
    return new Response(JSON.stringify({ playlists: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderLibrary(initialScope: 'personal' | 'global' = 'personal', notify = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LibraryPage notify={notify} canEditGlobal={false} initialScope={initialScope} /></QueryClientProvider>);
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
    expect(await screen.findByRole('button', { name: '查看全站歌曲详情' })).toBeVisible();
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

  it('元数据失败时保留已经到达的歌曲列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/search/quick?')) return new Response(JSON.stringify({ songs: [personalSong], hasMore: false }), { status: 200 });
      if (path.includes('/api/search/meta?')) return new Response(JSON.stringify({ message: '元数据暂时不可用' }), { status: 503 });
      if (path.includes('/api/playlists/next-ktv')) return new Response(JSON.stringify({ playlist: null, songs: [] }), { status: 200 });
      return new Response(JSON.stringify({ playlists: [] }), { status: 200 });
    }));
    renderLibrary();

    expect(await screen.findByText('晴天')).toBeVisible();
    expect(await screen.findByText(/数量和筛选项暂时无法更新/)).toBeVisible();
  });

  it('会唱曲库为空时可以直接进入全部曲库', async () => {
    stubLibraryApi({ emptyPersonal: true });
    renderLibrary();

    const goGlobal = await screen.findByRole('button', { name: '去全部曲库选歌' });
    fireEvent.click(goGlobal);
    expect(await screen.findByRole('tab', { name: /全部曲库/ })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByRole('button', { name: '查看全站歌曲详情' })).toBeVisible();
  });

  it('搜索无结果时只提供清除条件，并在清除后恢复列表', async () => {
    stubLibraryApi({ noSearchResults: true });
    renderLibrary();

    const input = screen.getByRole('textbox', { name: '搜索歌曲' });
    fireEvent.change(input, { target: { value: '不存在的歌' } });
    expect(await screen.findByText('没有符合条件的歌曲')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '清除查找条件' }));
    expect(await screen.findByText('晴天')).toBeVisible();
  });

  it('收录请求未完成时先更新状态，成功后关闭详情', async () => {
    const baseFetch = stubLibraryApi();
    let resolveCollection: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/user-songs/2/collection')) {
        return new Promise<Response>((resolve) => { resolveCollection = resolve; });
      }
      return baseFetch(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderLibrary('global');

    fireEvent.click(await screen.findByRole('button', { name: '查看全站歌曲详情' }));
    fireEvent.click(screen.getByRole('button', { name: '我会唱，加入会唱曲库' }));
    expect(await screen.findByRole('button', { name: '查看我的会唱曲库' })).toBeVisible();

    resolveCollection?.(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '歌曲操作' })).not.toBeInTheDocument());
  });

  it('收录失败时回滚歌曲状态', async () => {
    const baseFetch = stubLibraryApi();
    let rejectCollection: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/api/user-songs/2/collection')) {
        return new Promise<Response>((_resolve, reject) => { rejectCollection = reject; });
      }
      return baseFetch(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const notify = vi.fn();
    renderLibrary('global', notify);

    fireEvent.click(await screen.findByRole('button', { name: '查看全站歌曲详情' }));
    fireEvent.click(screen.getByRole('button', { name: '我会唱，加入会唱曲库' }));
    expect(await screen.findByRole('button', { name: '查看我的会唱曲库' })).toBeVisible();
    rejectCollection?.(new Error('模拟网络失败'));

    expect(await screen.findByRole('button', { name: '我会唱，加入会唱曲库' })).toBeVisible();
    expect(notify).toHaveBeenCalledWith('网络连接失败，请检查网络后重试。');
  });

  it('搜索输入经过防抖后只提交最终关键词', async () => {
    const fetchMock = stubLibraryApi();
    renderLibrary();
    await screen.findByText('晴天');
    const quickCallsBefore = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/search/quick?')).length;
    const input = screen.getByRole('textbox', { name: '搜索歌曲' });

    fireEvent.change(input, { target: { value: '晴' } });
    fireEvent.change(input, { target: { value: '晴天' } });
    expect(fetchMock.mock.calls.filter(([value]) => String(value).includes('/api/search/quick?')).length).toBe(quickCallsBefore);

    await new Promise((resolve) => window.setTimeout(resolve, 320));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([value]) => String(value).includes('/api/search/quick?')).length).toBeGreaterThan(quickCallsBefore));
    expect(fetchMock.mock.calls.some(([, init]) => Boolean(init?.signal))).toBe(true);
    const searchValues = fetchMock.mock.calls
      .map(([value]) => new URL(String(value), 'http://localhost').searchParams.get('q'))
      .filter((value): value is string => value !== null);
    expect(searchValues.at(-1)).toBe('晴天');
    expect(searchValues).not.toContain('晴');
  });
});
