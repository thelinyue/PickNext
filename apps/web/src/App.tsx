import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mic2 } from 'lucide-react';
import { api, ApiError } from './api.js';
import { AuthScreen } from './auth.js';
import { AppShell, NetworkBanner, Toast, type NavigationPage, type PickNavState } from './components.js';
import { LibraryPage, type SongPrefill } from './library.js';
import { PickPage, usePickController } from './pick.js';
import { MePage } from './me.js';
import { AdminConsole } from './admin-console.js';

interface User { id: number; username: string; nickname: string | null; displayName: string; avatarUrl: string | null; role: 'admin' | 'user'; isMaintainer: boolean; canAddSongs: boolean }

/** 将系统分享目标中的标题、文本转换为可编辑的收歌预填值，不在接收分享时直接写入数据库。 */
export function parseSharedSong(params: URLSearchParams): SongPrefill | null {
  const title = params.get('title')?.trim() ?? '';
  const text = params.get('text')?.trim() ?? '';
  const candidate = [text, title].find((value) => /\s*[-—|｜]\s*/.test(value)) ?? '';
  const parts = (candidate || [title, text].filter(Boolean).join(' - '))
    .split(/\s*[-—|｜]\s*/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const result: SongPrefill = { title: parts[0]! };
  if (parts[1]) result.artist = parts[1];
  if (parts.length > 2) result.version = parts.slice(2).join(' - ');
  return result;
}

export default function App() {
  const client = useQueryClient();
  const [page, setPage] = useState<NavigationPage>('pick');
  const [libraryScope, setLibraryScope] = useState<'personal' | 'global'>('personal');
  const [sharedSong, setSharedSong] = useState<SongPrefill | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [toast, setToast] = useState<string | null>(null);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ required: boolean; registrationOpen: boolean }>('/api/setup/status') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: User }>('/api/auth/me'), retry: false, enabled: setup.data?.required === false });
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(null), 3200); }, []);
  const pickController = usePickController(notify, Boolean(me.data?.user));
  const navigate = useCallback((target: NavigationPage) => { if (target === 'library') setLibraryScope('personal'); setPage(target); }, []);
  const openGlobalLibrary = useCallback(() => { setLibraryScope('global'); setPage('library'); }, []);
  const openAdmin = useCallback(() => {
    history.pushState({ page: 'admin' }, '');
    setPage('admin');
  }, []);
  const closeAdmin = useCallback(() => {
    // 管理后台是应用内状态，不需要通过浏览器历史回退，避免回退时触发旧页面的网络恢复逻辑。
    history.replaceState({}, '', location.pathname);
    setPage('me');
  }, []);
  const pickState: PickNavState = pickController.busy || pickController.initializing
    ? 'loading'
    : pickController.exhausted || pickController.ktvExhausted
      ? 'exhausted'
      : pickController.current
        ? page === 'pick' ? 'switch' : 'continue'
        : 'idle';
  const runPickAction = useCallback(() => {
    if (pickState === 'loading') return;
    setPage('pick');
    if (pickState === 'continue') return;
    if (pickState === 'exhausted') { pickController.setExhaustedOpen(true); return; }
    navigator.vibrate?.(10);
    void pickController.pick();
  }, [pickController.pick, pickController.setExhaustedOpen, pickState]);
  const refreshAuth = async () => { await client.invalidateQueries({ queryKey: ['setup'] }); await client.invalidateQueries({ queryKey: ['me'] }); };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const parsed = parseSharedSong(params);
    if (parsed) {
      setSharedSong(parsed);
      setLibraryScope('global');
      setPage('library');
      notify(`已打开分享歌曲：${parsed.title}${parsed.artist ? ` · ${parsed.artist}` : ''}，请确认后收录。`);
      history.replaceState({}, '', location.pathname);
    }
  }, []);
  useEffect(() => {
    const handleOffline = () => setOnline(false);
    const handleOnline = () => {
      setOnline(true);
      notify('网络已恢复，正在刷新数据。');
      void client.invalidateQueries();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => { window.removeEventListener('offline', handleOffline); window.removeEventListener('online', handleOnline); };
  }, [client, notify]);
  useEffect(() => {
    const handlePopState = () => setPage((current) => current === 'admin' ? 'me' : current);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  // 启动阶段使用与登录页一致的线性话筒图标，避免 emoji 在不同系统上的渲染差异。
  if (setup.isLoading || (setup.data?.required === false && me.isLoading)) return <div className="splash"><div className="splash-brand" aria-hidden="true"><span className="splash-orbit splash-orbit-one" /><span className="splash-orbit splash-orbit-two" /><span className="brand-pulse"><Mic2 /></span></div><span className="splash-wordmark">PickNext</span><span className="splash-caption">正在准备你的下一首</span></div>;
  if (setup.isError) return <div className="fatal"><span>{setup.error instanceof Error ? setup.error.message : '无法连接 PickNext 服务。'}</span><button className="button" onClick={() => void setup.refetch()}>重新连接</button></div>;
  if (setup.data?.required || me.error instanceof ApiError && me.error.status === 401) return <AuthScreen setupRequired={Boolean(setup.data?.required)} registrationOpen={Boolean(setup.data?.registrationOpen)} onSuccess={refreshAuth} />;
  if (!me.data?.user) return <div className="fatal"><span>{me.error instanceof Error ? me.error.message : '读取账号信息失败。'}</span><button className="button" onClick={() => void me.refetch()}>重新连接</button></div>;
  return <AppShell page={page} onNavigate={navigate} onPickAction={runPickAction} pickState={pickState}>{!online && <NetworkBanner />}{page === 'library' && <LibraryPage notify={notify} canEditGlobal={me.data.user.role === 'admin' || me.data.user.isMaintainer} initialScope={libraryScope} initialAddSong={sharedSong} onSharedSongConsumed={() => setSharedSong(null)} />}{page === 'pick' && <PickPage notify={notify} controller={pickController} onOpenGlobalLibrary={openGlobalLibrary} canAddSongs={me.data.user.canAddSongs} />}{page === 'me' && <MePage user={me.data.user} notify={notify} onOpenAdmin={openAdmin} onLogout={() => { client.clear(); location.reload(); }} />}{page === 'admin' && <AdminConsole user={me.data.user} onBack={closeAdmin} notify={notify} />}<Toast message={toast} /></AppShell>;
}
