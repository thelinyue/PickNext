import { afterEach, describe, expect, it, vi } from 'vitest';
import { MtwClient } from './mtw-client.js';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('MTW 客户端', () => {
  it('先用登录 JWT 读取真实 file_list 和 file_id3_list 参数', async () => {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '', authorization: headers.get('authorization') });
      if (url.endsWith('/apimt/token/')) return new Response(JSON.stringify({ result: true, token: 'jwt-token' }), { status: 200 });
      if (url.endsWith('/apimt/file_list/')) return new Response(JSON.stringify({ result: true, data: { file_list_data: [{ name: 'media', title: 'media', icon: 'icon-folder', children: [{ name: 'Artist', title: 'Artist', icon: 'icon-folder', children: [] }] }] } }), { status: 200 });
      if (url.endsWith('/apimt/file_id3_list/')) return new Response(JSON.stringify({ result: true, data: { list: [{ title: '歌曲', artist: '歌手', album: '专辑', albumversion: '', language: '', genre: '', lyrics: '', path: '/app/media/Artist/专辑/歌曲.mp3', artwork: 'data:image/jpeg;base64,/9j/' }] } }), { status: 200 });
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const client = new MtwClient({ baseUrl: 'http://mtw.test', token: 'bearer-token', username: 'user', password: 'password' });
    const files = await client.listFiles('/app/media');
    const metadata = await client.listMetadata('/app/media/Artist/专辑');

    expect(files).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/app/media', is_dir: true }), expect.objectContaining({ path: '/app/media/Artist', is_dir: true })]));
    expect(metadata[0]).toMatchObject({ title: '歌曲', artist: '歌手', album: '专辑', artworkAvailable: true });
    expect(calls[0]).toMatchObject({ url: 'http://mtw.test/apimt/token/', authorization: null });
    expect(calls[1]).toMatchObject({ url: 'http://mtw.test/apimt/file_list/', authorization: 'jwt jwt-token' });
    expect(JSON.parse(calls[1].body)).toMatchObject({ file_path: '/app/media' });
    expect(calls[2]).toMatchObject({ url: 'http://mtw.test/apimt/file_id3_list/', authorization: 'jwt jwt-token' });
    expect(JSON.parse(calls[2].body)).toMatchObject({ file_full_path: '/app/media/Artist', mode: 'all', page: 1 });
  });

  it('从 MTW get_original_artwork 返回的 data URI 读取图片二进制', async () => {
    globalThis.fetch = vi.fn(async (input) => String(input).endsWith('/apimt/token/')
      ? new Response(JSON.stringify({ result: true, token: 'jwt-token' }), { status: 200 })
      : new Response(JSON.stringify({ result: true, data: { artwork: 'data:image/png;base64,iVBORw0KGgo=' } }), { status: 200 })) as typeof fetch;
    const client = new MtwClient({ baseUrl: 'http://mtw.test', username: 'user', password: 'password' });
    const cover = await client.fetchImage('/app/media/Artist/专辑/歌曲.mp3');
    expect(cover.mimeType).toBe('image/png');
    expect([...cover.bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
