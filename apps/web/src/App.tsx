import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.js';
import { AuthScreen } from './auth.js';
import { AppShell, NetworkBanner, Toast, type NavigationPage, type PickNavState } from './components.js';
import { LibraryPage } from './library.js';
import { PickPage, usePickController } from './pick.js';
import { MePage } from './me.js';

interface User { id: number; username: string; role: 'admin' | 'user'; isMaintainer: boolean; canAddSongs: boolean }

export default function App() {
  const client = useQueryClient();
  const [page, setPage] = useState<NavigationPage>('pick');
  const [libraryScope, setLibraryScope] = useState<'personal' | 'global'>('personal');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [toast, setToast] = useState<string | null>(null);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ required: boolean; registrationOpen: boolean }>('/api/setup/status') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: User }>('/api/auth/me'), retry: false, enabled: setup.data?.required === false });
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(null), 3200); }, []);
  const pickController = usePickController(notify, Boolean(me.data?.user));
  const navigate = useCallback((target: NavigationPage) => { if (target === 'library') setLibraryScope('personal'); setPage(target); }, []);
  const openGlobalLibrary = useCallback(() => { setLibraryScope('global'); setPage('library'); }, []);
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
    const params = new URLSearchParams(location.search); const shared = [params.get('title'), params.get('text')].filter(Boolean).join(' - ');
    if (shared) { setPage('library'); notify(`已收到分享：${shared}`); }
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
  if (setup.isLoading || (setup.data?.required === false && me.isLoading)) return <div className="splash"><div className="brand-pulse">🎙️</div><span>PickNext</span></div>;
  if (setup.isError) return <div className="fatal"><span>{setup.error instanceof Error ? setup.error.message : '无法连接 PickNext 服务。'}</span><button className="button" onClick={() => void setup.refetch()}>重新连接</button></div>;
  if (setup.data?.required || me.error instanceof ApiError && me.error.status === 401) return <AuthScreen setupRequired={Boolean(setup.data?.required)} registrationOpen={Boolean(setup.data?.registrationOpen)} onSuccess={refreshAuth} />;
  if (!me.data?.user) return <div className="fatal"><span>{me.error instanceof Error ? me.error.message : '读取账号信息失败。'}</span><button className="button" onClick={() => void me.refetch()}>重新连接</button></div>;
  return <AppShell page={page} onNavigate={navigate} onPickAction={runPickAction} pickState={pickState}>{!online && <NetworkBanner />}{page === 'library' && <LibraryPage notify={notify} canEditGlobal={me.data.user.role === 'admin' || me.data.user.isMaintainer} initialScope={libraryScope} />}{page === 'pick' && <PickPage notify={notify} controller={pickController} onOpenGlobalLibrary={openGlobalLibrary} canAddSongs={me.data.user.canAddSongs} />}{page === 'me' && <MePage user={me.data.user} notify={notify} onLogout={() => { client.clear(); location.reload(); }} />}<Toast message={toast} /></AppShell>;
}
