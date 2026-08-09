import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api.js';
import { AuthScreen } from './auth.js';
import { AppShell, Toast, type NavigationPage } from './components.js';
import { LibraryPage } from './library.js';
import { PickPage, usePickController } from './pick.js';
import { MePage } from './me.js';

interface User { id: number; username: string; role: 'admin' | 'user'; isMaintainer: boolean; canAddSongs: boolean }

export default function App() {
  const client = useQueryClient();
  const [page, setPage] = useState<NavigationPage>('pick');
  const [toast, setToast] = useState<string | null>(null);
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ required: boolean }>('/api/setup/status') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: User }>('/api/auth/me'), retry: false, enabled: setup.data?.required === false });
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(null), 3200); }, []);
  const pickController = usePickController(notify);
  const navigate = useCallback((target: NavigationPage) => {
    if (target === 'pick') {
      setPage('pick');
      void pickController.pick();
      return;
    }
    setPage(target);
  }, [pickController.pick]);
  const refreshAuth = async () => { await client.invalidateQueries({ queryKey: ['setup'] }); await client.invalidateQueries({ queryKey: ['me'] }); };
  useEffect(() => {
    const params = new URLSearchParams(location.search); const shared = [params.get('title'), params.get('text')].filter(Boolean).join(' - ');
    if (shared) { setPage('library'); notify(`已收到分享：${shared}`); }
  }, []);
  if (setup.isLoading || (setup.data?.required === false && me.isLoading)) return <div className="splash"><div className="brand-pulse">🎙️</div><span>PickNext</span></div>;
  if (setup.isError) return <div className="fatal">无法连接 PickNext 服务，请检查服务是否启动。</div>;
  if (setup.data?.required || me.error instanceof ApiError && me.error.status === 401) return <AuthScreen setupRequired={Boolean(setup.data?.required)} onSuccess={refreshAuth} />;
  if (!me.data?.user) return <div className="fatal">读取账号信息失败，请刷新重试。</div>;
  return <AppShell page={page} onNavigate={navigate} pickBusy={pickController.busy} pickHasCurrent={Boolean(pickController.current)}>{page === 'library' && <LibraryPage notify={notify} />}{page === 'pick' && <PickPage notify={notify} controller={pickController} />}{page === 'me' && <MePage username={me.data.user.username} role={me.data.user.role} notify={notify} onLogout={() => { client.clear(); location.reload(); }} />}<Toast message={toast} /></AppShell>;
}
