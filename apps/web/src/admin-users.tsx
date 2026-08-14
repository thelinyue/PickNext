import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, KeyRound, Plus, Search, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import type { AdminUser, AdminUserDetail, AdminUsersResponse, UserDeletionImpact } from '@picknext/shared';
import { api } from './api.js';
import { Button, EmptyState, IconButton, Sheet } from './components.js';

type UserType = 'all' | 'admin' | 'maintainer' | 'user';
type AddPermission = 'all' | 'allowed' | 'denied';
type LoginFilter = 'all' | 'logged' | 'never';
type UserSort = 'created_desc' | 'username_asc' | 'last_login_desc';

/**
 * 管理页采用服务端分页和紧凑列表：手机只渲染已加载的用户，复杂操作集中到详情 Sheet。
 * 多选仅覆盖已加载账号，避免“全选搜索结果”在筛选变化后误删未见过的用户。
 */
export function AdminUsersPage({ onBack, notify, embedded = false, showRegistrationSetting = true }: { onBack(): void; notify(message: string): void; embedded?: boolean; showRegistrationSetting?: boolean }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [type, setType] = useState<UserType>('all');
  const [canAddSongs, setCanAddSongs] = useState<AddPermission>('all');
  const [login, setLogin] = useState<LoginFilter>('all');
  const [sort, setSort] = useState<UserSort>('created_desc');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<number, AdminUser>>(new Map());
  const [detailTarget, setDetailTarget] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkPermissionOpen, setBulkPermissionOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<AdminUser[]>([]);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { setSelected(new Map()); }, [debouncedSearch, type, canAddSongs, login, sort]);

  const users = useInfiniteQuery({
    queryKey: ['admin-users', debouncedSearch, type, canAddSongs, login, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q: debouncedSearch, type, canAddSongs, login, sort, limit: '30', offset: String(pageParam) });
      return api<AdminUsersResponse>(`/api/admin/users?${params}`);
    },
    getNextPageParam: (lastPage, pages) => lastPage.hasMore ? pages.reduce((count, page) => count + page.users.length, 0) : undefined
  });
  const rows = useMemo(() => users.data?.pages.flatMap((page) => page.users) ?? [], [users.data]);
  const summary = users.data?.pages[0]?.summary;
  const registration = useQuery({ queryKey: ['setup'], queryFn: () => api<{ required: boolean; registrationOpen: boolean }>('/api/setup/status') });
  const updateRegistration = useMutation({
    mutationFn: (open: boolean) => api('/api/admin/settings/registration', { method: 'PUT', body: JSON.stringify({ open }) }),
    onSuccess: async (_result, open) => { await client.invalidateQueries({ queryKey: ['setup'] }); notify(open ? '已开放普通用户注册' : '已关闭普通用户注册'); },
    onError: (error) => notify(error instanceof Error ? error.message : '注册设置更新失败')
  });

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || !users.hasNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !users.isFetchingNextPage) void users.fetchNextPage();
    }, { rootMargin: '180px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [users.hasNextPage, users.isFetchingNextPage, users.fetchNextPage]);

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['admin-users'] }),
      client.invalidateQueries({ queryKey: ['admin-users-summary'] })
    ]);
  };
  const toggleSelected = (user: AdminUser) => {
    if (user.role === 'admin') return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(user.id)) next.delete(user.id); else if (next.size < 50) next.set(user.id, user);
      return next;
    });
  };
  const finishMutation = async (message: string) => {
    setSelected(new Map()); setSelecting(false); setDetailTarget(null); setDeleteTargets([]);
    await refresh(); notify(message);
  };

  return <section className={`admin-users-page ${embedded ? 'admin-users-embedded' : ''}`}>
    {!embedded && <header className="admin-users-header"><IconButton label="返回我的页面" onClick={onBack}><ArrowLeft /></IconButton><div><span>系统管理</span><h1>用户与权限</h1></div><button className="header-text-action" onClick={() => { setSelecting((value) => !value); setSelected(new Map()); }}>{selecting ? '完成' : '选择'}</button></header>}
    <div className="admin-users-sticky">
      <div className="admin-summary"><div><strong>{summary?.total ?? '暂无'}</strong><span>用户</span></div><div><strong>{summary?.maintainers ?? '暂无'}</strong><span>曲库管家</span></div><button onClick={() => setCreateOpen(true)}><Plus /><span>新增用户</span></button></div>
      {showRegistrationSetting && <label className="registration-setting"><span><b>允许普通用户注册</b><small>{registration.data?.registrationOpen ? '登录页当前显示注册入口' : '仅管理员可以创建账号'}</small></span><input aria-label="允许普通用户注册" type="checkbox" checked={Boolean(registration.data?.registrationOpen)} disabled={updateRegistration.isPending} onChange={(event) => updateRegistration.mutate(event.target.checked)} /></label>}
      <label className="admin-user-search"><Search /><input aria-label="搜索用户名" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名" />{search && <button aria-label="清除搜索" onClick={() => setSearch('')}>×</button>}</label>
      <div className="admin-role-chips" aria-label="用户类型筛选">{([['all','全部'],['admin','管理员'],['maintainer','曲库管家'],['user','普通用户']] as const).map(([value, label]) => <button key={value} className={type === value ? 'active' : ''} onClick={() => setType(value)}>{label}</button>)}</div>
      <div className="admin-filter-row"><select aria-label="歌曲添加权限" value={canAddSongs} onChange={(event) => setCanAddSongs(event.target.value as AddPermission)}><option value="all">全部添加权限</option><option value="allowed">允许添加</option><option value="denied">禁止添加</option></select><select aria-label="登录状态" value={login} onChange={(event) => setLogin(event.target.value as LoginFilter)}><option value="all">全部登录状态</option><option value="logged">已登录过</option><option value="never">从未登录</option></select><select aria-label="用户排序" value={sort} onChange={(event) => setSort(event.target.value as UserSort)}><option value="created_desc">最近创建</option><option value="username_asc">用户名</option><option value="last_login_desc">最近登录</option></select></div>
    </div>
    <div className="admin-result-meta"><span>找到 {users.data?.pages[0]?.total ?? 0} 位用户</span>{selected.size > 0 && <b>已选 {selected.size}/50</b>}</div>
    <div className={`admin-user-list ${selecting ? 'selecting' : ''}`}>
      {users.isLoading && Array.from({ length: 6 }, (_, index) => <div className="admin-user-skeleton" key={index} />)}
      {rows.map((user) => <article className={`admin-user-compact ${selected.has(user.id) ? 'selected' : ''}`} key={user.id}>
        {selecting && <button className="user-select-control" aria-label={user.role === 'admin' ? `${user.username}不可选择` : `${selected.has(user.id) ? '取消选择' : '选择'}${user.username}`} disabled={user.role === 'admin'} onClick={() => toggleSelected(user)}><span>{selected.has(user.id) && <Check />}</span></button>}
        <button className="admin-user-main" onClick={() => selecting ? toggleSelected(user) : setDetailTarget(user)}><div className="user-avatar">{(user.displayName ?? user.nickname ?? user.username).slice(0, 1).toUpperCase()}</div><div className="admin-user-copy"><div><strong>{user.displayName ?? user.nickname ?? user.username}</strong><span className={`role-badge ${user.role === 'admin' ? 'admin' : user.isMaintainer ? 'maintainer' : 'user'}`}>{roleLabel(user)}</span></div><p>@{user.username} · {user.personalSongCount} 首个人歌曲 · {user.canAddSongs ? '可添加歌曲' : '禁止添加'}</p><small>{user.lastLoginAt ? `最近登录 ${relativeTime(user.lastLoginAt)}` : `从未登录 · 创建于 ${formatDate(user.createdAt)}`}</small></div><span className="row-chevron">›</span></button>
      </article>)}
      {!users.isLoading && !users.isError && rows.length === 0 && <EmptyState title="没有匹配的用户" description="可以调整筛选或清除搜索关键词。" action={<Button className="secondary" onClick={() => { setSearch(''); setType('all'); setCanAddSongs('all'); setLogin('all'); }}>清除筛选</Button>} />}
      {users.isError && <EmptyState title="用户列表加载失败" description="请检查网络后重试。" action={<Button onClick={() => users.refetch()}>重新加载</Button>} />}
      <div ref={loadMoreRef} className="admin-load-more">{users.isFetchingNextPage ? '正在加载更多…' : users.hasNextPage ? '继续向下查看' : rows.length ? '已经到底了' : ''}</div>
    </div>
    {selecting && selected.size > 0 && <div className="admin-bulk-bar"><span>已选 <b>{selected.size}</b> 人</span><button onClick={() => setBulkPermissionOpen(true)}><UserCog />权限</button><button className="danger-text" onClick={() => setDeleteTargets([...selected.values()])}><Trash2 />删除</button></div>}
    <CreateUserSheet open={createOpen} onOpenChange={setCreateOpen} onCreated={async () => { await refresh(); notify('用户已创建'); }} />
    <UserDetailSheet user={detailTarget} onClose={() => setDetailTarget(null)} notify={notify} onChanged={refresh} onDelete={(user) => setDeleteTargets([user])} />
    <BulkPermissionSheet users={[...selected.values()]} open={bulkPermissionOpen} onOpenChange={setBulkPermissionOpen} notify={notify} onChanged={async () => { setBulkPermissionOpen(false); await finishMutation('批量权限已更新'); }} />
    <DeleteUsersSheet users={deleteTargets} open={deleteTargets.length > 0} onOpenChange={(open) => !open && setDeleteTargets([])} notify={notify} onDeleted={(count) => finishMutation(`已永久删除 ${count} 位用户`)} />
  </section>;
}

function CreateUserSheet({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(open: boolean): void; onCreated(): Promise<void> }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [maintainer, setMaintainer] = useState(false);
  const create = useMutation({ mutationFn: () => api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, isMaintainer: maintainer, canAddSongs: true }) }), onSuccess: async () => { setUsername(''); setPassword(''); setMaintainer(false); onOpenChange(false); await onCreated(); } });
  return <Sheet open={open} onOpenChange={(value) => !create.isPending && onOpenChange(value)} title="新增用户"><div className="sheet-stack"><label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={2} maxLength={40} autoFocus /></label><label>初始密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} /></label><label className="check-row"><input type="checkbox" checked={maintainer} onChange={(event) => setMaintainer(event.target.checked)} /><span>创建为曲库管家</span></label>{create.isError && <p className="form-error">{create.error instanceof Error ? create.error.message : '创建用户失败'}</p>}<Button loading={create.isPending} disabled={username.trim().length < 2 || password.length < 8} onClick={() => create.mutate()}>创建账号</Button></div></Sheet>;
}

function UserDetailSheet({ user, onClose, onChanged, onDelete, notify }: { user: AdminUser | null; onClose(): void; onChanged(): Promise<void>; onDelete(user: AdminUser): void; notify(message: string): void }) {
  const [resetOpen, setResetOpen] = useState(false); const [password, setPassword] = useState('');
  const detail = useQuery({ queryKey: ['admin-user-detail', user?.id], enabled: Boolean(user), queryFn: () => api<{ user: AdminUserDetail }>(`/api/admin/users/${user!.id}`) });
  const update = useMutation({ mutationFn: (body: { isMaintainer?: boolean; canAddSongs?: boolean }) => api(`/api/admin/users/${user!.id}`, { method: 'PUT', body: JSON.stringify(body) }), onSuccess: async () => { await detail.refetch(); await onChanged(); notify('用户权限已更新'); }, onError: (error) => notify(error instanceof Error ? error.message : '权限更新失败') });
  const reset = useMutation({ mutationFn: () => api(`/api/admin/users/${user!.id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }), onSuccess: () => { setPassword(''); setResetOpen(false); notify('密码已重置'); }, onError: (error) => notify(error instanceof Error ? error.message : '密码重置失败') });
  const value = detail.data?.user ? { ...detail.data.user, username: detail.data.user.displayName ?? detail.data.user.nickname ?? detail.data.user.username } : undefined;
  return <Sheet open={Boolean(user)} onOpenChange={(open) => !open && onClose()} title={user?.username ?? '用户详情'}>{detail.isLoading ? <div className="detail-loading">正在读取用户数据…</div> : value && <div className="sheet-stack user-detail-stack"><div className="user-detail-identity"><div className="user-avatar large">{value.username.slice(0,1).toUpperCase()}</div><div><strong>{value.username}</strong><span>{roleLabel(value)} · {value.lastLoginAt ? `最近登录 ${relativeTime(value.lastLoginAt)}` : '从未登录'}</span></div></div><div className="user-data-grid"><div><strong>{value.repertoireCount}</strong><span>会唱</span></div><div><strong>{value.learningCount}</strong><span>待学</span></div><div><strong>{value.playCount}</strong><span>已唱</span></div><div><strong>{value.playlistCount}</strong><span>歌单</span></div><div><strong>{value.pickSessionCount}</strong><span>Pick 场次</span></div><div><strong>{value.contributedSongCount}</strong><span>全局贡献</span></div></div>{value.role !== 'admin' && <><label className="detail-permission-row"><span><b>曲库管家</b><small>可以维护全局歌曲资料</small></span><input type="checkbox" checked={value.isMaintainer} disabled={update.isPending} onChange={(event) => update.mutate({ isMaintainer: event.target.checked })} /></label><label className="detail-permission-row"><span><b>允许添加歌曲</b><small>关闭后仍可维护个人已有歌曲</small></span><input type="checkbox" checked={value.canAddSongs} disabled={update.isPending} onChange={(event) => update.mutate({ canAddSongs: event.target.checked })} /></label></>}<Button className="secondary" onClick={() => setResetOpen((open) => !open)}><KeyRound />重置密码</Button>{resetOpen && <div className="reset-password"><input aria-label={`为${value.username}设置新密码`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" /><Button loading={reset.isPending} disabled={password.length < 8} onClick={() => reset.mutate()}>确认</Button></div>}{value.role !== 'admin' && <button className="danger-outline" onClick={() => { onClose(); onDelete(value); }}><Trash2 />永久删除该用户</button>}</div>}</Sheet>;
}

function BulkPermissionSheet({ users, open, onOpenChange, onChanged, notify }: { users: AdminUser[]; open: boolean; onOpenChange(open: boolean): void; onChanged(): Promise<void>; notify(message: string): void }) {
  const update = useMutation({ mutationFn: (body: { isMaintainer?: boolean; canAddSongs?: boolean }) => api('/api/admin/users/bulk-permissions', { method: 'PUT', body: JSON.stringify({ userIds: users.map((user) => user.id), ...body }) }), onSuccess: onChanged, onError: (error) => notify(error instanceof Error ? error.message : '批量权限更新失败') });
  return <Sheet open={open} onOpenChange={(value) => !update.isPending && onOpenChange(value)} title={`批量设置 ${users.length} 位用户`}><div className="sheet-stack bulk-permission-actions"><p className="helper">只修改本次选择的权限，其他权限保持不变。</p><Button loading={update.isPending} onClick={() => update.mutate({ isMaintainer: true })}><ShieldCheck />授予曲库管家</Button><Button className="secondary" loading={update.isPending} onClick={() => update.mutate({ isMaintainer: false })}>取消曲库管家</Button><Button className="secondary" loading={update.isPending} onClick={() => update.mutate({ canAddSongs: true })}>允许添加歌曲</Button><Button className="secondary" loading={update.isPending} onClick={() => update.mutate({ canAddSongs: false })}>禁止添加歌曲</Button></div></Sheet>;
}

function DeleteUsersSheet({ users, open, onOpenChange, onDeleted, notify }: { users: AdminUser[]; open: boolean; onOpenChange(open: boolean): void; onDeleted(count: number): Promise<void>; notify(message: string): void }) {
  const [adminPassword, setAdminPassword] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const ids = users.map((user) => user.id);
  const preview = useQuery({ queryKey: ['user-deletion-preview', ids], enabled: open && ids.length > 0, queryFn: () => api<{ impact: UserDeletionImpact }>('/api/admin/users/deletion-preview', { method: 'POST', body: JSON.stringify({ userIds: ids }) }) });
  const remove = useMutation({ mutationFn: () => users.length === 1
    ? api<{ deleted: number }>(`/api/admin/users/${users[0]!.id}`, { method: 'DELETE', body: JSON.stringify({ adminPassword, confirmed: true }) })
    : api<{ deleted: number }>('/api/admin/users/bulk-delete', { method: 'POST', body: JSON.stringify({ userIds: ids, adminPassword, confirmed: true }) }),
  onSuccess: async (result) => { setAdminPassword(''); setConfirmed(false); await onDeleted(result.deleted); }, onError: (error) => notify(error instanceof Error ? error.message : '永久删除失败') });
  const impact = preview.data?.impact;
  return <Sheet open={open} onOpenChange={(value) => !remove.isPending && onOpenChange(value)} title={users.length === 1 ? '永久删除用户' : `永久删除 ${users.length} 位用户`}><div className="sheet-stack delete-user-confirm"><div className="danger-warning"><Trash2 /><div><strong>此操作不可恢复</strong><p>个人曲库、歌单、Pick 和演唱记录会永久清除；贡献的全局歌曲将匿名保留。</p></div></div>{preview.isLoading && <p className="helper">正在统计受影响的数据…</p>}{impact && <><div className="delete-usernames">{impact.usernames.slice(0, 8).map((name) => <span key={name}>{name}</span>)}{impact.usernames.length > 8 && <span>等 {impact.usernames.length} 人</span>}</div><div className="deletion-impact"><div><strong>{impact.personalSongCount}</strong><span>个人收录</span></div><div><strong>{impact.playCount}</strong><span>演唱记录</span></div><div><strong>{impact.playlistCount}</strong><span>歌单</span></div><div><strong>{impact.pickSessionCount}</strong><span>Pick 场次</span></div><div className="kept"><strong>{impact.contributedSongCount}</strong><span>全局歌曲保留</span></div></div></>}<label>当前管理员密码<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="用于确认管理员身份" autoComplete="current-password" /></label><label className="risk-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我了解这些个人数据无法恢复</span></label><Button className="danger-button" loading={remove.isPending} disabled={!impact || adminPassword.length < 8 || !confirmed} onClick={() => remove.mutate()}>永久删除{users.length === 1 ? '该用户' : ` ${users.length} 位用户`}</Button></div></Sheet>;
}

function roleLabel(user: Pick<AdminUser, 'role' | 'isMaintainer'>) { return user.role === 'admin' ? '管理员' : user.isMaintainer ? '曲库管家' : '普通用户'; }
function formatDate(value: string) { return new Date(`${value.replace(' ', 'T')}Z`).toLocaleDateString('zh-CN'); }
function relativeTime(value: string) {
  const time = new Date(`${value.replace(' ', 'T')}Z`).getTime(); const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days === 0) return '今天'; if (days < 30) return `${days} 天前`; if (days < 365) return `${Math.floor(days / 30)} 个月前`; return `${Math.floor(days / 365)} 年前`;
}
