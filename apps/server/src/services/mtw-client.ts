import { basename } from 'node:path';
import type { MtwSongMetadata } from '@picknext/shared';

export interface MtwClientOptions {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export interface MtwHealthResult {
  ok: boolean;
  message: string;
}

export interface MtwFileEntry {
  path?: string;
  file_full_path?: string;
  full_path?: string;
  is_dir?: boolean;
  type?: string;
  icon?: string;
  name?: string;
}

export interface MtwScanProgress {
  phase: 'authenticating' | 'listing' | 'metadata' | 'completed';
  completed: number;
  total: number;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function entryPath(entry: MtwFileEntry): string | null {
  return entry.path ?? entry.file_full_path ?? entry.full_path ?? null;
}

function isDirectory(entry: MtwFileEntry): boolean {
  return entry.is_dir === true || entry.icon === 'icon-folder' || ['dir', 'directory', 'folder'].includes(String(entry.type ?? '').toLowerCase());
}

function joinMtwPath(parent: string, child: string): string {
  if (child.startsWith('/') || /^[a-z]:[\\/]/i.test(child)) return child;
  return `${parent.replace(/[\\/]$/, '')}/${child}`;
}

function responseRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body) || !isRecord(body.data)) return [];
  if (Array.isArray(body.data.list)) return body.data.list;
  return [];
}

/**
 * MTW 访问适配器：网关接口使用 Bearer Token，管理接口先登录换 JWT。
 * MTW 的 file_list/file_id3_list 并不接受网关 Bearer Token，这是扫描失败的根因。
 */
export class MtwClient {
  private readonly timeoutMs: number;
  private jwtToken: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(private readonly options: MtwClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async health(): Promise<MtwHealthResult> {
    try {
      const response = await this.request('/apigw/info/health/', { method: 'GET' }, 'bearer');
      const body = await response.json().catch(() => ({})) as { health?: string };
      return body.health === 'ok'
        ? { ok: true, message: 'MTW 服务正常。' }
        : { ok: false, message: 'MTW 服务返回了无法识别的健康状态。' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'MTW 健康检查失败。' };
    }
  }

  async lyrics(title: string, artist: string, album: string): Promise<Array<{ id: string; title: string; artist: string; album: string; lyrics: string }>> {
    const query = new URLSearchParams({ title, artist, album });
    const response = await this.request(`/apigw/lyrics/?${query.toString()}`, { method: 'GET' }, 'bearer');
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error('MTW 歌词接口返回格式不正确。');
    return body.filter((item): item is { id: string; title: string; artist: string; album: string; lyrics: string } =>
      isRecord(item) && typeof item.id !== 'undefined' && typeof item.title === 'string'
      && typeof item.artist === 'string' && typeof item.album === 'string' && typeof item.lyrics === 'string'
    );
  }

  /** 按 MTW 的真实请求结构读取一个艺术家/专辑目录的 ID3 列表。 */
  async listMetadata(path: string): Promise<MtwSongMetadata[]> {
    const name = basename(path.replace(/[\\/]$/, ''));
    const parent = path.replace(/[\\/][^\\/]+$/, '') || '/';
    const response = await this.request('/apimt/file_id3_list/', {
      method: 'POST',
      body: JSON.stringify({
        file_full_path: parent,
        select_data: [{ icon: 'icon-folder', name, title: name }],
        mode: 'all',
        limit: 100,
        depth: 1,
        sorted_fields: [],
        search_word: '',
        refresh: false,
        page: 1,
        page_size: 1000
      })
    }, 'jwt');
    const body = await response.json() as unknown;
    return responseRows(body).filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.title === 'string' && typeof item.artist === 'string')
      .map((item) => ({
        title: String(item.title).trim(),
        artist: String(item.artist).trim(),
        album: typeof item.album === 'string' ? item.album.trim() || null : null,
        version: typeof item.albumversion === 'string' ? item.albumversion.trim() || null : null,
        language: typeof item.language === 'string' ? item.language.trim() || null : null,
        genre: typeof item.genre === 'string' ? item.genre.trim() || null : null,
        lyrics: typeof item.lyrics === 'string' ? item.lyrics : null,
        path: typeof item.path === 'string' ? item.path : null,
        artworkAvailable: typeof item.artwork === 'string' && item.artwork.startsWith('data:image/')
      }));
  }

  /** 读取 MTW 目录树，并把 children 展平为带完整路径的文件/目录条目。 */
  async listFiles(path: string): Promise<MtwFileEntry[]> {
    const response = await this.request('/apimt/file_list/', {
      method: 'POST',
      body: JSON.stringify({ file_path: path, sorted_fields: [], search_word: '', refresh: false })
    }, 'jwt');
    const body = await response.json() as unknown;
    const raw = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.file_list_data) ? body.data.file_list_data : [];
    const result: MtwFileEntry[] = [];
    const visit = (entries: unknown[], parentPath: string, isRoot = false) => {
      for (const value of entries) {
        if (!isRecord(value)) continue;
        const name = typeof value.name === 'string' ? value.name : typeof value.title === 'string' ? value.title : '';
        const currentPath = entryPath(value) ?? (isRoot && name === basename(path.replace(/[\\/]$/, '')) ? path : name ? joinMtwPath(parentPath, name) : parentPath);
        const entry: MtwFileEntry = { ...value, path: currentPath, is_dir: value.is_dir === true || value.icon === 'icon-folder' };
        result.push(entry);
        if (Array.isArray(value.children)) visit(value.children, currentPath);
      }
    };
    visit(raw, path, true);
    return result;
  }

  /** 按“艺术家/专辑”目录读取元数据；扁平目录仍保留根目录兜底。 */
  async scanMetadata(rootPath: string, onProgress?: (progress: MtwScanProgress) => void): Promise<{ metadata: MtwSongMetadata[]; files: MtwFileEntry[] }> {
    const allFiles: MtwFileEntry[] = [];
    const metadata: MtwSongMetadata[] = [];
    const seenMetadata = new Set<string>();
    const seenDirectories = new Set<string>();
    const addMetadata = (rows: MtwSongMetadata[]) => {
      for (const row of rows) {
        const key = `${row.path ?? ''}\u0000${row.title}\u0000${row.artist}\u0000${row.version ?? ''}`;
        if (!seenMetadata.has(key)) { seenMetadata.add(key); metadata.push(row); }
      }
    };
    const addDirectories = (parent: string, entries: MtwFileEntry[]) => entries.filter(isDirectory).map(entryPath).filter((value): value is string => Boolean(value)).filter((value) => value !== parent);

    onProgress?.({ phase: 'authenticating', completed: 0, total: 0, message: '正在登录 MTW...' });
    onProgress?.({ phase: 'listing', completed: 0, total: 0, message: '正在读取媒体目录...' });
    const rootFiles = await this.listFiles(rootPath);
    allFiles.push(...rootFiles);
    addMetadata(await this.listMetadata(rootPath).catch(() => []));
    const artists = addDirectories(rootPath, rootFiles);
    let completed = 0;
    let total = artists.length;
    onProgress?.({ phase: 'metadata', completed, total, message: `已发现 ${total} 个艺术家目录，正在读取专辑...` });
    for (const artistPath of artists) {
      if (seenDirectories.has(artistPath)) continue;
      seenDirectories.add(artistPath);
      const artistFiles = await this.listFiles(artistPath).catch(() => []);
      allFiles.push(...artistFiles);
      const albums = addDirectories(artistPath, artistFiles);
      if (!albums.length) {
        addMetadata(await this.listMetadata(artistPath).catch(() => []));
        completed += 1;
      }
      total += albums.length;
      onProgress?.({ phase: 'metadata', completed, total, message: `正在读取 ${artistPath.split(/[\\/]/).pop() ?? '艺术家'}...` });
      for (const albumPath of albums) {
        if (seenDirectories.has(albumPath)) continue;
        seenDirectories.add(albumPath);
        addMetadata(await this.listMetadata(albumPath).catch(() => []));
        allFiles.push(...await this.listFiles(albumPath).catch(() => []));
        completed += 1;
        onProgress?.({ phase: 'metadata', completed, total, message: `已读取 ${completed}/${total} 个目录` });
      }
    }
    onProgress?.({ phase: 'completed', completed: total, total, message: `目录扫描完成，共找到 ${metadata.length} 首歌曲。` });
    return { metadata, files: allFiles };
  }

  /** 封面只能通过已认证的二进制响应导入，不抓取 MTW detail 页面。 */
  async fetchImage(path: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (!/\.(?:jpe?g|png|webp)$/i.test(path)) {
      const response = await this.request('/apimt/get_original_artwork/', {
        method: 'POST',
        body: JSON.stringify({ file_full_path: path })
      }, 'jwt');
      const body = await response.json().catch(() => ({})) as { data?: { artwork?: unknown } };
      const artwork = body.data?.artwork;
      if (typeof artwork !== 'string' || !artwork.startsWith('data:image/')) throw new Error('MTW 未找到这首歌的封面。');
      const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(artwork);
      if (!match) throw new Error('MTW 返回的封面格式不受支持。');
      const encoded = match[2];
      const mimeType = match[1];
      if (!encoded || !mimeType) throw new Error('MTW 返回的封面格式不受支持。');
      const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
      if (!bytes.length) throw new Error('MTW 返回了空封面。');
      return { bytes, mimeType };
    }
    const response = await this.request(path, { method: 'GET' }, 'jwt');
    const mimeType = ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error('MTW 封面响应不是图片。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error('MTW 返回了空封面。');
    return { bytes, mimeType };
  }

  private async ensureJwt(): Promise<string> {
    if (this.jwtToken) return this.jwtToken;
    if (!this.options.username || !this.options.password) throw new Error('请配置 MTW 用户名和密码后再扫描歌曲。');
    this.loginPromise ??= this.login();
    try { this.jwtToken = await this.loginPromise; return this.jwtToken; }
    finally { this.loginPromise = null; }
  }

  private async login(): Promise<string> {
    const response = await this.request('/apimt/token/', {
      method: 'POST',
      body: JSON.stringify({ username: this.options.username, password: this.options.password })
    }, 'none');
    const body = await response.json().catch(() => ({})) as { token?: unknown; result?: boolean };
    if (typeof body.token !== 'string' || !body.token) throw new Error('MTW 登录失败，用户名或密码不正确。');
    return body.token;
  }

  private async request(path: string, init: RequestInit, auth: 'bearer' | 'jwt' | 'none' = 'bearer'): Promise<Response> {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json, image/*');
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (auth === 'bearer' && this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    if (auth === 'jwt') headers.set('authorization', `jwt ${await this.ensureJwt()}`);
    try {
      const response = await fetch(url, { ...init, headers, signal: controller.signal });
      if (!response.ok) throw new Error(`MTW 请求失败（HTTP ${response.status}）。`);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('MTW 请求超时，请检查服务地址和网络。');
      throw error instanceof Error ? error : new Error('MTW 请求失败。');
    } finally {
      clearTimeout(timer);
    }
  }
}
