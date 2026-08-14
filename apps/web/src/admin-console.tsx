import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Database,
  FileText,
  LayoutDashboard,
  Library,
  ListTodo,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { AdminUsersPage } from './admin-users.js';
import { Button, EmptyState, Sheet } from './components.js';

export type AdminSection = 'overview' | 'tasks' | 'mtw' | 'catalog' | 'reviews' | 'users' | 'settings';
type AdminUser = { role: 'admin' | 'user'; isMaintainer: boolean; username: string; nickname: string | null; displayName: string; avatarUrl: string | null };
type NavItem = { id: AdminSection; label: string; icon: LucideIcon; adminOnly?: boolean };

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: '运营工作台', items: [
    { id: 'overview', label: '工作台', icon: LayoutDashboard },
    { id: 'tasks', label: '任务中心', icon: ListTodo },
  ] },
  { label: '内容运营', items: [
    { id: 'mtw', label: 'MTW 导入', icon: Upload },
    { id: 'reviews', label: '审核队列', icon: ClipboardCheck },
    { id: 'catalog', label: '曲库治理', icon: Library },
  ] },
  { label: '系统管理', items: [
    { id: 'users', label: '用户与权限', icon: Users, adminOnly: true },
    { id: 'settings', label: '系统设置', icon: Settings, adminOnly: true },
  ] },
];

const sectionTitles: Record<AdminSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: '运营工作台', title: '今天要处理什么？', description: '把正在运行、需要审核和资料不完整的内容集中到这里。' },
  tasks: { eyebrow: '运营工作台', title: '任务中心', description: '查看后台长任务，处理取消、重试和部分失败。' },
  mtw: { eyebrow: '内容运营', title: 'MTW 导入', description: '先扫描，再审核候选歌曲，最后批量导入曲库。' },
  reviews: { eyebrow: '内容运营', title: '审核队列', description: '按类型处理歌曲资料、歌词和删除申请。' },
  catalog: { eyebrow: '内容运营', title: '曲库治理', description: '用完整度和来源筛选歌曲，集中修复公共资料。' },
  users: { eyebrow: '系统管理', title: '用户与权限', description: '管理账号角色、歌曲添加权限和个人数据生命周期。' },
  settings: { eyebrow: '系统管理', title: '系统设置', description: '维护 MTW 连接和普通用户注册策略。' },
};

const statusLabels: Record<string, string> = {
  pending: '等待中', scanning: '扫描中', ready: '待审核', importing: '导入中', running: '运行中',
  done: '已完成', partial_failed: '部分失败', failed: '失败', cancelled: '已取消', revoking: '撤销中', revoked: '已撤销',
  candidate: '待处理', created: '已新增', updated: '已更新', similar_skipped: '相似跳过', review: '需审核',
  missing: '缺失', present: '已有', deleted: '已软删除', active: '活跃',
};

function statusLabel(status: string | null | undefined): string { return statusLabels[status ?? ''] ?? status ?? '未知'; }
function statusTone(status: string | null | undefined): 'info' | 'success' | 'warning' | 'danger' | 'muted' {
  if (['done', 'created', 'updated', 'ready', 'active', 'present'].includes(status ?? '')) return 'success';
  if (['failed', 'partial_failed', 'revoked', 'deleted', 'missing'].includes(status ?? '')) return 'danger';
  if (['scanning', 'importing', 'running', 'pending', 'candidate', 'review'].includes(status ?? '')) return 'warning';
  return 'muted';
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  return <span className={`admin-status admin-status-${statusTone(status)}`}><i aria-hidden="true" />{statusLabel(status)}</span>;
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function formatDate(value: string | null | undefined) {
  if (!value) return '暂无';
  return new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function allAdminQuery(query: { queryKey: readonly unknown[] }) {
  const key = String(query.queryKey[0] ?? '');
  return key.startsWith('admin-') || key === 'setup';
}

export function AdminConsole({ user, onBack, notify }: { user: AdminUser; onBack(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const [section, setSection] = useState<AdminSection>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const current = sectionTitles[section];
  const visibleGroups = navGroups.map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || user.role === 'admin') })).filter((group) => group.items.length);
  const navigate = (target: AdminSection) => { setSection(target); setMobileNavOpen(false); };
  const refresh = async () => { await client.invalidateQueries({ predicate: allAdminQuery }); notify('管理后台数据已刷新。'); };

  return <section className="admin-console admin-workspace">
    <aside className="admin-sidebar">
      <div className="admin-sidebar-brand"><span className="admin-brand-mark"><Activity size={18} /></span><div><strong>PickNext</strong><small>运营控制台</small></div></div>
      <nav className="admin-sidebar-nav" aria-label="管理后台模块">{visibleGroups.map((group) => <div className="admin-nav-group" key={group.label}><span>{group.label}</span>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><Icon size={17} /><b>{item.label}</b>{item.id === 'reviews' && <ReviewCount />}</button>; })}</div>)}</nav>
      <div className="admin-sidebar-footer"><span className="admin-user-dot">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>@{user.username} · {user.role === 'admin' ? '管理员' : '曲库管家'}</small></div><button onClick={onBack} aria-label="返回用户端"><ArrowLeft size={16} /></button></div>
    </aside>
    <div className="admin-workspace-body">
      <header className="admin-topbar">
        <div className="admin-topbar-left"><button className="admin-mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label="打开管理模块"><Menu size={20} /></button><div className="admin-breadcrumb"><span>管理后台</span><ChevronRight size={14} /><b>{current.title}</b></div></div>
        <div className="admin-topbar-actions"><span className="admin-role-chip"><ShieldCheck size={14} />{user.role === 'admin' ? '管理员' : '曲库管家'}</span><button className="admin-topbar-refresh" onClick={() => void refresh()} aria-label="刷新管理后台"><RefreshCw size={17} /></button><button className="admin-topbar-back" onClick={onBack}>返回用户端</button></div>
      </header>
      {mobileNavOpen && <><button className="admin-mobile-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="关闭管理模块" /><aside className="admin-mobile-drawer"><div className="admin-mobile-drawer-head"><strong>管理后台</strong><button onClick={() => setMobileNavOpen(false)} aria-label="关闭"><X size={19} /></button></div>{visibleGroups.map((group) => <div className="admin-nav-group" key={group.label}><span>{group.label}</span>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><Icon size={17} /><b>{item.label}</b></button>; })}</div>)}</aside></>}
      <main className="admin-main"><div className="admin-heading"><div><span>{current.eyebrow}</span><h1>{current.title}</h1><p>{current.description}</p></div><div className="admin-heading-meta"><span><Wifi size={14} />服务在线</span><small>数据实时同步</small></div></div>
        {section === 'overview' && <AdminOverview onOpen={navigate} />}
        {section === 'tasks' && <AdminTasks notify={notify} />}
        {section === 'mtw' && <AdminMtw notify={notify} />}
        {section === 'catalog' && <AdminCatalog notify={notify} />}
        {section === 'reviews' && <AdminReviews notify={notify} />}
        {section === 'users' && <AdminUsersPage embedded showRegistrationSetting={false} onBack={() => navigate('overview')} notify={notify} />}
        {section === 'settings' && <AdminSettings notify={notify} />}
      </main>
    </div>
  </section>;
}

function ReviewCount() {
  const query = useQuery({ queryKey: ['admin-review-count'], queryFn: () => api<{ count: number }>('/api/reviews/count') });
  return query.data?.count ? <em className="admin-nav-count">{query.data.count > 99 ? '99+' : query.data.count}</em> : null;
}

type OverviewData = { songs: number; deletedSongs: number; covers: number; songsWithoutCover: number; songsWithoutLyrics: number; pendingDeletionReviews: number; pendingLyricsReviews: number; pendingSongReviews: number; runningTasks: number; recentBatches: Array<{ id: string; status: string; result: string | null; progress: string | null; error: string | null; createdAt: string; updatedAt?: string }> };

function AdminOverview({ onOpen }: { onOpen(section: AdminSection): void }) {
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api<OverviewData>('/api/admin/overview') });
  const value = overview.data;
  const reviewTotal = (value?.pendingDeletionReviews ?? 0) + (value?.pendingLyricsReviews ?? 0) + (value?.pendingSongReviews ?? 0);
  const cards: Array<{ label: string; value: number | undefined; hint: string; icon: LucideIcon; target: AdminSection; tone: string }> = [
    { label: '待处理审核', value: reviewTotal, hint: '歌曲、歌词和删除申请', icon: ClipboardCheck, target: 'reviews', tone: 'purple' },
    { label: '运行中任务', value: value?.runningTasks, hint: '后台正在执行', icon: Activity, target: 'tasks', tone: 'cyan' },
    { label: '缺少封面', value: value?.songsWithoutCover, hint: '需要补齐资料', icon: FileText, target: 'catalog', tone: 'amber' },
    { label: '缺少歌词', value: value?.songsWithoutLyrics, hint: '需要补齐资料', icon: Database, target: 'catalog', tone: 'pink' },
  ];
  return <div className="admin-content admin-overview-content">
    <div className="admin-overview-grid"><section className="admin-panel admin-focus-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">优先处理</span><h2>把积压清掉</h2></div><button className="admin-inline-link" onClick={() => onOpen('tasks')}>查看全部任务 <ChevronRight size={15} /></button></div><div className="admin-focus-list"><button onClick={() => onOpen('reviews')}><span className="admin-focus-icon purple"><ClipboardCheck size={18} /></span><span><strong>{reviewTotal || '暂无'} 条审核待处理</strong><small>{reviewTotal ? '建议先处理最早提交的事项' : '新的审核会自动出现在这里'}</small></span><ChevronRight size={17} /></button><button onClick={() => onOpen('catalog')}><span className="admin-focus-icon amber"><AlertTriangle size={18} /></span><span><strong>{(value?.songsWithoutCover ?? 0) + (value?.songsWithoutLyrics ?? 0) || '暂无'} 项资料待补齐</strong><small>缺封面 {value?.songsWithoutCover ?? '暂无'} · 缺歌词 {value?.songsWithoutLyrics ?? '暂无'}</small></span><ChevronRight size={17} /></button><button onClick={() => onOpen('mtw')}><span className="admin-focus-icon cyan"><Upload size={18} /></span><span><strong>{value?.runningTasks ? '导入任务正在执行' : '开始一次 MTW 导入'}</strong><small>{value?.runningTasks ? '可在任务中心查看进度' : '扫描后再选择候选歌曲'}</small></span><ChevronRight size={17} /></button></div></section><section className="admin-panel admin-health-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">系统概览</span><h2>曲库状态</h2></div><CheckCircle2 className="admin-health-ok" size={19} /></div><div className="admin-health-main"><strong>{value?.songs ?? '暂无'}</strong><span>活跃歌曲</span></div><div className="admin-health-stats"><span><b>{value?.covers ?? '暂无'}</b> 已有封面</span><span><b>{value?.deletedSongs ?? '暂无'}</b> 已软删除</span></div><div className="admin-health-footer"><Wifi size={14} />MTW 连接状态需在系统设置中检查</div></section></div>
    <div className="admin-stat-grid admin-stat-grid-v2">{cards.map((card) => { const Icon = card.icon; return <button className={`admin-stat-card admin-stat-card-${card.tone}`} key={card.label} onClick={() => onOpen(card.target)}><span className="admin-stat-icon"><Icon size={17} /></span><strong>{card.value ?? '暂无'}</strong><b>{card.label}</b><small>{card.hint}</small></button>; })}</div>
    <section className="admin-panel admin-recent-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">最近活动</span><h2>最近导入批次</h2></div><button className="admin-inline-link" onClick={() => onOpen('tasks')}>任务中心 <ChevronRight size={15} /></button></div>{value?.recentBatches?.length ? <div className="admin-recent-list">{value.recentBatches.map((batch) => <button key={batch.id} onClick={() => onOpen('mtw')}><span className="admin-recent-type"><Upload size={15} /></span><span><strong>MTW 导入批次</strong><small>{formatDate(batch.createdAt)} · {batch.id.slice(0, 8)}</small></span><StatusBadge status={batch.status} /><ChevronRight size={16} /></button>)}</div> : <EmptyState title="还没有导入批次" description="从 MTW 导入开始建立公共曲库。" action={<Button onClick={() => onOpen('mtw')}>开始导入</Button>} />}</section>
  </div>;
}

type AdminTask = { id: string; type?: string; status: string; result: string | null; progress: string | null; error: string | null; createdAt: string; updatedAt: string };

function AdminTasks({ notify }: { notify(message: string): void }) {
  const client = useQueryClient();
  const tasks = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ mtw: AdminTask[]; imports: AdminTask[] }>('/api/admin/tasks'), refetchInterval: (query) => [...(query.state.data?.mtw ?? []), ...(query.state.data?.imports ?? [])].some((task) => ['pending', 'scanning', 'importing', 'running'].includes(task.status)) ? 1200 : false });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/admin/mtw/import-batches/${id}/cancel`, { method: 'POST', body: '{}' }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['admin-tasks'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify('任务已取消。'); }, onError: (error) => notify(error instanceof Error ? error.message : '取消任务失败') });
  const rows = useMemo(() => [...(tasks.data?.mtw ?? []).map((task) => ({ ...task, source: 'MTW 导入' })), ...(tasks.data?.imports ?? []).map((task) => ({ ...task, source: '歌曲导入' }))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks.data]);
  return <div className="admin-content"><div className="admin-task-summary"><div><Activity size={18} /><strong>{rows.filter((task) => ['pending', 'scanning', 'importing', 'running'].includes(task.status)).length}</strong><span>进行中</span></div><div><CheckCircle2 size={18} /><strong>{rows.filter((task) => task.status === 'done').length}</strong><span>已完成</span></div><div><AlertTriangle size={18} /><strong>{rows.filter((task) => ['failed', 'partial_failed'].includes(task.status)).length}</strong><span>需关注</span></div></div><section className="admin-panel admin-table-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">后台执行记录</span><h2>全部任务</h2></div><button className="admin-inline-link" onClick={() => void client.invalidateQueries({ queryKey: ['admin-tasks'] })}><RefreshCw size={15} />刷新</button></div>{tasks.isLoading ? <div className="admin-loading-line">正在读取任务记录…</div> : rows.length ? <div className="admin-data-table-wrap"><table className="admin-data-table"><thead><tr><th>任务</th><th>状态</th><th>进度/结果</th><th>更新时间</th><th /></tr></thead><tbody>{rows.map((task) => { const progress = parseJson<{ completed?: number; total?: number; message?: string }>(task.progress); const result = parseJson<{ processed?: number; created?: number; updated?: number; coverFailed?: number }>(task.result); return <tr key={`${task.source}-${task.id}`}><td><strong>{task.source}</strong><small>{task.id.slice(0, 12)}</small></td><td><StatusBadge status={task.status} /></td><td>{progress ? <span className="admin-table-progress">{progress.message ?? `${progress.completed ?? 0}/${progress.total ?? 0}`} {progress.total ? `${Math.round((progress.completed ?? 0) / progress.total * 100)}%` : ''}</span> : result ? <span className="admin-table-result">处理 {result.processed ?? result.created ?? result.updated ?? 0} 项{result.coverFailed ? ` · 封面失败 ${result.coverFailed}` : ''}</span> : <span className="admin-table-muted">{task.error ?? '暂无'}</span>}</td><td>{formatDate(task.updatedAt)}</td><td>{['scanning', 'importing'].includes(task.status) && <button className="admin-row-action danger" onClick={() => cancel.mutate(task.id)} disabled={cancel.isPending}>取消</button>}</td></tr>; })}</tbody></table></div> : <EmptyState title="暂无后台任务" description="批量导入和长时间任务会显示在这里。" />}</section></div>;
}

type MtwItem = { id: number; title: string; artist: string; album: string | null; version?: string | null; language?: string | null; genre?: string | null; hasLyrics?: number; action: string; coverStatus: string; error: string | null };
type MtwBatch = { id: string; status: string; result: string | null; progress: string | null; error: string | null; createdAt: string; updatedAt?: string };

function AdminMtw({ notify }: { notify(message: string): void }) {
  const client = useQueryClient();
  const [path, setPath] = useState('/app/media'); const [batchId, setBatchId] = useState<string | null>(null); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [coverStatus, setCoverStatus] = useState(''); const [lyricsStatus, setLyricsStatus] = useState<'all' | 'present' | 'missing'>('all'); const [sort, setSort] = useState('id'); const [selected, setSelected] = useState<Set<number>>(new Set()); const [selectAllFiltered, setSelectAllFiltered] = useState(false); const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const batches = useQuery({ queryKey: ['admin-mtw-batches'], queryFn: () => api<{ batches: MtwBatch[] }>('/api/admin/mtw/import-batches') });
  useEffect(() => { if (!batchId) { const active = batches.data?.batches.find((item) => ['scanning', 'ready', 'importing', 'partial_failed'].includes(item.status)); if (active) setBatchId(active.id); } }, [batchId, batches.data]);
  // 扫描阶段只展示待导入候选；导入完成后展示整批结果，否则部分失败的歌曲会因 action 已变更而消失。
  const batchStatus = batches.data?.batches.find((item) => item.id === batchId)?.status;
  const actionFilter = batchStatus === 'ready' ? 'candidate' : '';
  const items = useQuery({ queryKey: ['admin-mtw-items', batchId, query, coverStatus, lyricsStatus, sort, page, actionFilter], enabled: Boolean(batchId), queryFn: () => api<{ batch: MtwBatch; items: MtwItem[]; total: number; hasMore: boolean; summary: { candidates: number; covers: number; coverFailures: number; lyricMissing: number } }>(`/api/admin/mtw/scans/${batchId}/items?q=${encodeURIComponent(query)}&coverStatus=${encodeURIComponent(coverStatus)}&lyricsStatus=${lyricsStatus}&action=${actionFilter}&sort=${sort}&page=${page}&pageSize=30`), refetchInterval: (current) => ['scanning', 'importing'].includes(current.state.data?.batch.status ?? '') ? 1200 : false });
  const resetSelection = () => { setSelected(new Set()); setSelectAllFiltered(false); setExcluded(new Set()); };
  const chooseBatch = (id: string) => { setBatchId(id); setPage(1); resetSelection(); };
  const scan = useMutation({ mutationFn: () => api<{ batchId: string }>('/api/admin/mtw/scans', { method: 'POST', body: JSON.stringify({ path }) }), onSuccess: async (result) => { setBatchId(result.batchId); setPage(1); resetSelection(); await client.invalidateQueries({ queryKey: ['admin-mtw-batches'] }); notify('MTW 扫描已开始。'); }, onError: (error) => notify(error instanceof Error ? error.message : 'MTW 扫描失败') });
  const importTask = useMutation({ mutationFn: () => api<{ selected: number }>(`/api/admin/mtw/import-batches/${batchId}/import`, { method: 'POST', body: JSON.stringify(selectAllFiltered ? { filters: { q: query, artist: '', album: '', coverStatus, lyricsStatus, action: 'candidate' }, excludeItemIds: [...excluded] } : { itemIds: [...selected] }) }), onSuccess: async (result) => { resetSelection(); await client.invalidateQueries({ queryKey: ['admin-mtw-items'] }); await client.invalidateQueries({ queryKey: ['admin-mtw-batches'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify(`已提交 ${result.selected} 首歌曲导入任务。`); }, onError: (error) => notify(error instanceof Error ? error.message : 'MTW 导入失败') });
  const cancel = useMutation({ mutationFn: () => api(`/api/admin/mtw/import-batches/${batchId}/cancel`, { method: 'POST', body: '{}' }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['admin-mtw-items'] }); await client.invalidateQueries({ queryKey: ['admin-tasks'] }); notify('任务已取消。'); }, onError: (error) => notify(error instanceof Error ? error.message : '取消任务失败') });
  const batchAction = useMutation({ mutationFn: (action: 'retry-covers' | 'revoke') => api(`/api/admin/mtw/import-batches/${batchId}/${action}`, { method: 'POST', body: '{}' }), onSuccess: async (_result, action) => { await client.invalidateQueries({ queryKey: ['admin-mtw-items'] }); await client.invalidateQueries({ queryKey: ['admin-mtw-batches'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify(action === 'revoke' ? '批次撤销已提交。' : '封面重试已提交。'); }, onError: (error) => notify(error instanceof Error ? error.message : '批次操作失败') });
  const currentBatch = items.data?.batch; const progress = parseJson<{ completed?: number; total?: number; message?: string }>(currentBatch?.progress); const progressPercent = progress?.total ? Math.round((progress.completed ?? 0) / progress.total * 100) : ['scanning', 'importing'].includes(currentBatch?.status ?? '') ? 8 : 0;
  const toggle = (id: number) => { if (selectAllFiltered) { setExcluded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); return; } setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); };
  const selectPage = () => { setSelectAllFiltered(false); setExcluded(new Set()); setSelected((current) => new Set([...current, ...(items.data?.items ?? []).map((item) => item.id)])); };
  const togglePage = () => { const ids = (items.data?.items ?? []).map((item) => item.id); if (selectAllFiltered) { setExcluded((current) => new Set([...current, ...ids])); return; } const allSelected = ids.length > 0 && ids.every((id) => selected.has(id)); setSelected((current) => { const next = new Set(current); ids.forEach((id) => allSelected ? next.delete(id) : next.add(id)); return next; }); };
  const selectFiltered = () => { setSelected(new Set()); setExcluded(new Set()); setSelectAllFiltered(true); };
  const selectedCount = selectAllFiltered ? Math.max(0, (items.data?.total ?? 0) - excluded.size) : selected.size;
  return <div className="admin-content">
    <div className="admin-workflow-steps"><span className="active"><b>1</b>扫描目录</span><i /><span className={currentBatch ? 'active' : ''}><b>2</b>审核候选</span><i /><span className={['importing', 'done', 'partial_failed'].includes(currentBatch?.status ?? '') ? 'active' : ''}><b>3</b>导入结果</span></div>
    <section className="admin-panel admin-import-start"><div><span className="admin-panel-kicker">第一步 · 选择来源</span><h2>扫描 MTW 媒体目录</h2><p>扫描只读取歌曲元数据，确认候选后才会写入公共曲库。</p></div><div className="admin-form-row"><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="例如 /app/media" /><Button onClick={() => scan.mutate()} loading={scan.isPending}><Upload size={16} />开始扫描</Button></div></section>
    <div className="admin-batch-layout"><aside className="admin-batch-history"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">批次记录</span><h2>最近批次</h2></div></div>{batches.data?.batches.slice(0, 12).map((batch) => <button key={batch.id} className={batchId === batch.id ? 'active' : ''} onClick={() => chooseBatch(batch.id)}><span><strong>{formatDate(batch.createdAt)}</strong><small>{batch.id.slice(0, 8)}</small></span><StatusBadge status={batch.status} /></button>)}{!batches.data?.batches.length && <p className="admin-table-muted">扫描后会在这里保留批次。</p>}</aside>
      <section className="admin-panel admin-import-panel">{!batchId || !currentBatch ? <EmptyState title="选择一个批次开始审核" description="完成目录扫描后，候选歌曲会显示在这里。" /> : <>
        <div className="admin-panel-heading"><div><span className="admin-panel-kicker">当前批次</span><h2>{progress?.message ?? (currentBatch.status === 'ready' ? `发现 ${items.data?.total ?? 0} 首候选歌曲` : '任务处理中')}</h2><div className="admin-heading-inline"><StatusBadge status={currentBatch.status} /><small>{formatDate(currentBatch.updatedAt ?? currentBatch.createdAt)}</small></div></div><div className="admin-panel-actions">{['scanning', 'importing'].includes(currentBatch.status) && <Button className="secondary compact" onClick={() => cancel.mutate()} loading={cancel.isPending}>取消任务</Button>}{['done', 'partial_failed', 'ready'].includes(currentBatch.status) && <><Button className="secondary compact" onClick={() => batchAction.mutate('retry-covers')} loading={batchAction.isPending}>重试封面</Button><Button className="secondary compact danger" onClick={() => batchAction.mutate('revoke')} loading={batchAction.isPending}>撤销批次</Button></>}</div></div>
        {['scanning', 'importing'].includes(currentBatch.status) && <div className="admin-progress admin-progress-large"><div><span>{progress?.completed ?? 0}/{progress?.total ?? '准备中'}</span><b>{progressPercent}%</b></div><span><i style={{ width: `${progressPercent}%` }} /></span></div>}
        {currentBatch.status === 'failed' && <p className="admin-error">{currentBatch.error ?? '任务失败，请重新扫描。'}</p>}
        {['ready', 'partial_failed', 'done'].includes(currentBatch.status) && <>
          <div className="admin-filter-toolbar"><label className="admin-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); resetSelection(); }} placeholder="搜索歌名、歌手或专辑" /></label><select value={coverStatus} onChange={(event) => { setCoverStatus(event.target.value); setPage(1); resetSelection(); }}><option value="">全部封面</option><option value="ready">已有封面</option><option value="failed">封面失败</option><option value="missing">缺少封面</option></select><select value={lyricsStatus} onChange={(event) => { setLyricsStatus(event.target.value as typeof lyricsStatus); setPage(1); resetSelection(); }}><option value="all">全部歌词</option><option value="present">已有歌词</option><option value="missing">缺少歌词</option></select><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="id">最近扫描</option><option value="title">歌名</option><option value="artist">歌手</option><option value="album">专辑</option></select></div>
          <div className="admin-table-toolbar"><span>候选 {items.data?.total ?? 0} 首 · 当前页 {items.data?.items.length ?? 0} 首</span><div><button onClick={selectPage}>选择当前页</button><button onClick={selectFiltered}>选择全部筛选结果</button></div></div>
          <div className="admin-data-table-wrap"><table className="admin-data-table admin-candidate-table"><thead><tr><th className="check-col"><input type="checkbox" aria-label="选择当前页" checked={Boolean(items.data?.items.length && items.data.items.every((item) => selectAllFiltered ? !excluded.has(item.id) : selected.has(item.id)))} onChange={togglePage} /></th><th>歌曲</th><th>来源资料</th><th>处理状态</th><th>资料完整度</th></tr></thead><tbody>{items.data?.items.map((item) => <tr className={selectAllFiltered ? (excluded.has(item.id) ? 'excluded' : 'selected') : selected.has(item.id) ? 'selected' : ''} key={item.id}><td className="check-col"><input type="checkbox" checked={selectAllFiltered ? !excluded.has(item.id) : selected.has(item.id)} onChange={() => toggle(item.id)} /></td><td><strong>{item.title}</strong><small>{item.artist}{item.version ? ` · ${item.version}` : ''}</small></td><td><span>{item.album ?? '专辑未填'}</span><small>{[item.language, item.genre].filter(Boolean).join(' · ') || '来源资料较少'}</small></td><td><StatusBadge status={item.action} /></td><td><span className="admin-completeness"><StatusBadge status={item.coverStatus} /><StatusBadge status={item.hasLyrics ? 'present' : 'missing'} /></span></td></tr>)}</tbody></table></div>
          <div className="admin-pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页</span><button disabled={!items.data?.hasMore} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight size={16} /></button></div>{selectedCount > 0 && <div className="admin-bulk-bar admin-bulk-bar-inline"><span><b>{selectedCount}</b> 首待导入{selectAllFiltered && excluded.size ? ` · 已排除 ${excluded.size} 首` : ''}</span><Button onClick={() => importTask.mutate()} loading={importTask.isPending}>导入所选歌曲</Button></div>}
        </>}
      </>}</section>
    </div>
  </div>;
}

function AdminCatalog({ notify }: { notify(message: string): void }) {
  const client = useQueryClient(); const [query, setQuery] = useState(''); const [status, setStatus] = useState<'active' | 'deleted'>('active'); const [source, setSource] = useState('all'); const [completeness, setCompleteness] = useState('all'); const [deletionStatus, setDeletionStatus] = useState('all'); const [sort, setSort] = useState('updated'); const [page, setPage] = useState(1); const [selected, setSelected] = useState<Set<number>>(new Set());
  const songs = useQuery({ queryKey: ['admin-songs', query, status, source, completeness, deletionStatus, sort, page], queryFn: () => api<{ songs: Array<{ id: number; title: string; artist: string; album: string | null; status: string; hasCover: number; hasLyrics: number; fromMtw: number; deletionPending: number }>; total: number; hasMore: boolean }>(`/api/admin/songs?q=${encodeURIComponent(query)}&status=${status}&source=${source}&completeness=${completeness}&deletionStatus=${deletionStatus}&sort=${sort}&page=${page}&pageSize=30`) });
  const action = useMutation({ mutationFn: (kind: 'delete' | 'restore') => api(`/api/admin/songs/bulk-${kind}`, { method: 'POST', body: JSON.stringify({ songIds: [...selected] }) }), onSuccess: async () => { setSelected(new Set()); await client.invalidateQueries({ queryKey: ['admin-songs'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify('曲库批量操作已完成。'); }, onError: (error) => notify(error instanceof Error ? error.message : '曲库操作失败') });
  const toggle = (id: number) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const reset = () => { setPage(1); setSelected(new Set()); };
  return <div className="admin-content"><section className="admin-panel admin-table-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">公共曲库</span><h2>{status === 'active' ? '活跃歌曲' : '已软删除歌曲'}</h2><p>找到 {songs.data?.total ?? '暂无'} 首歌曲</p></div><div className="admin-panel-actions"><Button className="secondary compact" onClick={() => void songs.refetch()}><RefreshCw size={15} />刷新</Button></div></div><div className="admin-filter-toolbar admin-catalog-filters"><label className="admin-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); reset(); }} placeholder="搜索歌名、歌手或专辑" /></label><select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); reset(); }}><option value="active">活跃歌曲</option><option value="deleted">已软删除</option></select><select value={source} onChange={(event) => { setSource(event.target.value); reset(); }}><option value="all">全部来源</option><option value="mtw">来自 MTW</option><option value="manual">手动维护</option></select><select value={completeness} onChange={(event) => { setCompleteness(event.target.value); reset(); }}><option value="all">资料完整度</option><option value="missing_album">缺少专辑</option><option value="missing_lyrics">缺少歌词</option><option value="missing_cover">缺少封面</option></select><select value={deletionStatus} onChange={(event) => { setDeletionStatus(event.target.value); reset(); }}><option value="all">删除申请</option><option value="pending">有待处理申请</option></select><select value={sort} onChange={(event) => { setSort(event.target.value); reset(); }}><option value="updated">最近更新</option><option value="title">歌名</option><option value="artist">歌手</option></select></div><div className="admin-table-toolbar"><span>当前页 {songs.data?.songs.length ?? 0} 首</span><span>{selected.size ? `已选 ${selected.size} 首` : '点击行前方复选框批量操作'}</span></div>{songs.data?.songs.length ? <div className="admin-data-table-wrap"><table className="admin-data-table"><thead><tr><th className="check-col">选择</th><th>歌曲</th><th>来源</th><th>封面</th><th>歌词</th><th>删除申请</th></tr></thead><tbody>{songs.data.songs.map((song) => <tr className={selected.has(song.id) ? 'selected' : ''} key={song.id}><td className="check-col"><input type="checkbox" checked={selected.has(song.id)} onChange={() => toggle(song.id)} aria-label={`选择${song.title}`} /></td><td><strong>{song.title}</strong><small>{song.artist} · {song.album ?? '专辑未填'}</small></td><td><StatusBadge status={song.fromMtw ? 'created' : 'manual'} /></td><td><StatusBadge status={song.hasCover ? 'present' : 'missing'} /></td><td><StatusBadge status={song.hasLyrics ? 'present' : 'missing'} /></td><td>{song.deletionPending ? <StatusBadge status="review" /> : <span className="admin-table-muted">暂无</span>}</td></tr>)}</tbody></table></div> : <EmptyState title="没有匹配的歌曲" description="可以清除搜索或放宽筛选条件。" action={<Button className="secondary" onClick={() => { setQuery(''); setSource('all'); setCompleteness('all'); setDeletionStatus('all'); reset(); }}>清除筛选</Button>} />}<div className="admin-pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页</span><button disabled={!songs.data?.hasMore} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight size={16} /></button></div>{selected.size > 0 && <div className="admin-bulk-bar admin-bulk-bar-inline"><span><b>{selected.size}</b> 首歌曲</span><Button className={status === 'active' ? 'danger-button' : ''} loading={action.isPending} onClick={() => { const label = status === 'active' ? '软删除' : '恢复'; if (window.confirm(`确认${label}已选 ${selected.size} 首歌曲？`)) action.mutate(status === 'active' ? 'delete' : 'restore'); }}>{status === 'active' ? '软删除所选' : '恢复所选'}</Button></div>}</section></div>;
}

type ReviewItem = { id: number; type: 'deletion' | 'lyrics' | 'song'; title: string | null; artist: string | null; album: string | null; submitter: string; createdAt: string; lyrics?: string; source?: string; submitted?: Record<string, unknown>; matched?: { title: string | null; artist: string | null; version: string | null } | null };
function isBatchReview(item: ReviewItem): item is ReviewItem & { type: 'deletion' | 'lyrics' } { return item.type !== 'song'; }

async function fetchAdminReviews(type: 'all' | 'deletion' | 'lyrics' | 'song', page: number) {
  if (type === 'song') {
    const result = await api<{ reviews: Array<{ id: number; submitter: string; createdAt: string; submitted: Record<string, unknown>; matched: { title: string | null; artist: string | null; version: string | null } | null }> }>('/api/reviews?status=pending');
    const reviews: ReviewItem[] = result.reviews.map((item) => ({ id: item.id, type: 'song', title: String(item.submitted.title ?? ''), artist: String(item.submitted.artist ?? ''), album: item.submitted.album ? String(item.submitted.album) : null, submitter: item.submitter, createdAt: item.createdAt, submitted: item.submitted, matched: item.matched }));
    return { reviews, total: reviews.length, hasMore: false };
  }
  const result = await api<{ reviews: ReviewItem[]; total: number; hasMore: boolean }>(`/api/admin/reviews?type=${type}&page=${page}&pageSize=30`);
  if (type !== 'all' || !result.reviews.some((item) => item.type === 'song')) return result;
  const songResult = await api<{ reviews: Array<{ id: number; submitter: string; createdAt: string; submitted: Record<string, unknown>; matched: { title: string | null; artist: string | null; version: string | null } | null }> }>('/api/reviews?status=pending');
  const songById = new Map(songResult.reviews.map((item) => [item.id, item]));
  return { ...result, reviews: result.reviews.map((item) => { if (item.type !== 'song') return item; const full = songById.get(item.id); return full ? { ...item, title: String(full.submitted.title ?? ''), artist: String(full.submitted.artist ?? ''), album: full.submitted.album ? String(full.submitted.album) : null, submitter: full.submitter, submitted: full.submitted, matched: full.matched } : item; }) };
}

function AdminReviews({ notify }: { notify(message: string): void }) {
  const client = useQueryClient(); const [type, setType] = useState<'all' | 'deletion' | 'lyrics' | 'song'>('all'); const [page, setPage] = useState(1); const [selected, setSelected] = useState<Set<string>>(new Set()); const [detail, setDetail] = useState<ReviewItem | null>(null); const [reviewNote, setReviewNote] = useState('');
  const reviews = useQuery({ queryKey: ['admin-reviews', type, page], queryFn: () => fetchAdminReviews(type, page) });
  const rows = reviews.data?.reviews ?? [];
  const decision = useMutation({ mutationFn: async ({ item, action, note }: { item: ReviewItem; action: 'approve' | 'reject' | 'merge'; note?: string }) => { const body = { reviewNote: note?.trim() || undefined }; if (item.type === 'song') { if (action === 'merge') return api(`/api/reviews/${item.id}/merge`, { method: 'POST', body: JSON.stringify(body) }); if (action === 'approve') return api(`/api/reviews/${item.id}/approve`, { method: 'POST', body: JSON.stringify({ ...(item.submitted ?? {}), ...body }) }); return api(`/api/reviews/${item.id}/reject`, { method: 'POST', body: JSON.stringify(body) }); } return api(`/api/admin/reviews/bulk-${action === 'approve' ? 'approve' : 'reject'}`, { method: 'POST', body: JSON.stringify({ type: item.type, reviewIds: [item.id], ...body }) }); }, onSuccess: async () => { setDetail(null); setReviewNote(''); setSelected(new Set()); await client.invalidateQueries({ queryKey: ['admin-reviews'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify('审核操作已完成。'); }, onError: (error) => notify(error instanceof Error ? error.message : '审核操作失败') });
  const bulk = useMutation({ mutationFn: async (action: 'approve' | 'reject') => { const grouped = new Map<'deletion' | 'lyrics', number[]>(); rows.filter((item) => selected.has(`${item.type}:${item.id}`)).filter(isBatchReview).forEach((item) => { const ids = grouped.get(item.type) ?? []; ids.push(item.id); grouped.set(item.type, ids); }); for (const [groupType, ids] of grouped) await api(`/api/admin/reviews/bulk-${action}`, { method: 'POST', body: JSON.stringify({ type: groupType, reviewIds: ids }) }); }, onSuccess: async () => { setSelected(new Set()); await client.invalidateQueries({ queryKey: ['admin-reviews'] }); await client.invalidateQueries({ queryKey: ['admin-overview'] }); notify('批量审核已完成。'); }, onError: (error) => notify(error instanceof Error ? error.message : '批量审核失败') });
  const toggle = (item: ReviewItem) => { if (item.type === 'song') return; const key = `${item.type}:${item.id}`; setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); };
  const openDetail = (item: ReviewItem) => { setDetail(item); setReviewNote(''); };
  const selectedSupported = [...selected].length;
  return <div className="admin-content"><section className="admin-panel admin-table-panel"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">待处理事项</span><h2>审核队列</h2><p>{reviews.data?.total ?? '暂无'} 条待审核内容</p></div><Button className="secondary compact" onClick={() => void reviews.refetch()}><RefreshCw size={15} />刷新</Button></div><div className="admin-segmented-tabs">{([['all', '全部'], ['deletion', '删除申请'], ['lyrics', '歌词'], ['song', '歌曲资料']] as const).map(([value, label]) => <button className={type === value ? 'active' : ''} key={value} onClick={() => { setType(value); setPage(1); setSelected(new Set()); }}>{label}</button>)}</div>{rows.length ? <div className="admin-data-table-wrap"><table className="admin-data-table admin-review-table"><thead><tr><th className="check-col">选择</th><th>内容</th><th>类型</th><th>提交人</th><th>提交时间</th><th /></tr></thead><tbody>{rows.map((item) => <tr key={`${item.type}-${item.id}`} className={selected.has(`${item.type}:${item.id}`) ? 'selected' : ''}><td className="check-col"><input type="checkbox" disabled={item.type === 'song'} checked={selected.has(`${item.type}:${item.id}`)} onChange={() => toggle(item)} aria-label={item.type === 'song' ? '歌曲资料需逐条审核' : `选择${item.title ?? '审核事项'}`} /></td><td><button className="admin-table-link" onClick={() => openDetail(item)}><strong>{item.title ?? '歌曲资料申请'}</strong><small>{item.artist ?? ''}{item.album ? ` · ${item.album}` : ''}</small></button></td><td><span className={`admin-review-type ${item.type}`}>{item.type === 'deletion' ? '删除申请' : item.type === 'lyrics' ? '歌词' : '歌曲资料'}</span></td><td>{item.submitter}</td><td>{formatDate(item.createdAt)}</td><td><button className="admin-row-action" onClick={() => openDetail(item)}>查看 <ChevronRight size={14} /></button></td></tr>)}</tbody></table></div> : <EmptyState title="暂无待审核事项" description="新的歌曲资料、歌词和删除申请会显示在这里。" />}<div className="admin-pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page} 页</span><button disabled={!reviews.data?.hasMore} onClick={() => setPage((value) => value + 1)}>下一页<ChevronRight size={16} /></button></div>{selectedSupported > 0 && <div className="admin-bulk-bar admin-bulk-bar-inline"><span><b>{selectedSupported}</b> 条可批量处理</span><Button className="secondary" loading={bulk.isPending} onClick={() => bulk.mutate('reject')}>批量驳回</Button><Button loading={bulk.isPending} onClick={() => bulk.mutate('approve')}>批量批准</Button></div>}</section><Sheet open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)} title="审核详情">{detail && <div className="admin-review-detail"><div className="admin-review-identity"><span className={`admin-focus-icon ${detail.type === 'deletion' ? 'pink' : detail.type === 'lyrics' ? 'cyan' : 'purple'}`}><FileText size={18} /></span><div><strong>{detail.title ?? '歌曲资料申请'}</strong><small>{detail.artist ?? '未知歌手'} · 提交人：{detail.submitter}</small></div></div>{detail.type === 'lyrics' && <div className="admin-lyrics-preview"><span>提交歌词{detail.source ? ` · ${detail.source}` : ''}</span><pre>{detail.lyrics ?? '暂无歌词内容'}</pre></div>}{detail.type === 'song' && <div className="admin-review-diff"><div><span>提交内容</span><strong>{String(detail.submitted?.title ?? detail.title ?? '')} · {String(detail.submitted?.artist ?? detail.artist ?? '')}</strong><small>{String(detail.submitted?.version ?? '未填写版本')} · {String(detail.submitted?.language ?? '未填写语种')}</small></div><div><span>匹配歌曲</span><strong>{detail.matched ? `${detail.matched.title ?? ''} · ${detail.matched.artist ?? ''}` : '没有匹配歌曲'}</strong><small>{detail.matched?.version ?? '可批准为独立版本'}</small></div></div>}{detail.type === 'deletion' && <div className="admin-danger-note"><AlertTriangle size={18} /><span>批准后歌曲会进入软删除状态，用户将无法继续搜索和收录。</span></div>}<label>审核备注<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="可选，记录本次处理原因" rows={4} /></label><div className="admin-review-actions">{detail.type === 'song' && detail.matched && <Button className="secondary" loading={decision.isPending} onClick={() => decision.mutate({ item: detail, action: 'merge', note: reviewNote })}>合并到原歌曲</Button>}<Button className="secondary danger" loading={decision.isPending} onClick={() => decision.mutate({ item: detail, action: 'reject', note: reviewNote })}>驳回</Button><Button loading={decision.isPending} onClick={() => decision.mutate({ item: detail, action: 'approve', note: reviewNote })}>{detail.type === 'song' ? '批准为新歌曲' : '批准'}</Button></div></div>}</Sheet></div>;
}

function AdminSettings({ notify }: { notify(message: string): void }) {
  const client = useQueryClient(); const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<{ registrationOpen: boolean }>('/api/admin/settings') }); const mtw = useQuery({ queryKey: ['admin-mtw-settings'], queryFn: () => api<{ baseUrl: string; tokenConfigured: boolean; usernameConfigured: boolean; passwordConfigured: boolean }>('/api/admin/settings/mtw') }); const [baseUrl, setBaseUrl] = useState(''); const [token, setToken] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  useEffect(() => { if (mtw.data) setBaseUrl(mtw.data.baseUrl); }, [mtw.data]);
  const registration = useMutation({ mutationFn: (open: boolean) => api('/api/admin/settings/registration', { method: 'PUT', body: JSON.stringify({ open }) }), onSuccess: async (_result, open) => { await client.invalidateQueries({ queryKey: ['admin-settings'] }); notify(open ? '已开放普通用户注册。' : '已关闭普通用户注册。'); }, onError: (error) => notify(error instanceof Error ? error.message : '注册设置更新失败') });
  const save = useMutation({ mutationFn: () => api('/api/admin/settings/mtw', { method: 'PUT', body: JSON.stringify({ baseUrl, token: token || undefined, username: username || undefined, password: password || undefined }) }), onSuccess: async () => { setToken(''); setPassword(''); await mtw.refetch(); notify('MTW 配置已保存。'); }, onError: (error) => notify(error instanceof Error ? error.message : '配置保存失败') });
  const health = useMutation({ mutationFn: () => api<{ message?: string }>('/api/admin/mtw/health'), onSuccess: (result) => notify(result.message ?? 'MTW 健康检查成功。'), onError: (error) => notify(error instanceof Error ? error.message : 'MTW 健康检查失败') });
  return <div className="admin-content admin-settings-grid"><section className="admin-panel admin-settings-card"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">账号策略</span><h2>注册设置</h2><p>决定登录页是否向普通用户开放注册。</p></div><Users size={19} /></div><label className="admin-toggle-row"><span><b>允许普通用户注册</b><small>{settings.data?.registrationOpen ? '登录页当前显示注册入口' : '仅管理员可以创建账号'}</small></span><input aria-label="允许普通用户注册" type="checkbox" checked={Boolean(settings.data?.registrationOpen)} disabled={registration.isPending} onChange={(event) => registration.mutate(event.target.checked)} /></label></section><section className="admin-panel admin-settings-card"><div className="admin-panel-heading"><div><span className="admin-panel-kicker">外部服务</span><h2>MTW 连接</h2><p>凭据只显示配置状态，不会回显已保存的密钥。</p></div><Settings size={19} /></div><label>MTW 服务地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.x.x:8016" /></label><label>Bearer Token <small className="admin-configured">{mtw.data?.tokenConfigured ? '已配置，不回显' : '未配置'}</small><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="留空保持不变" /></label><label>MTW 用户名 <small className="admin-configured">{mtw.data?.usernameConfigured ? '已配置' : '未配置'}</small><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="留空保持不变" /></label><label>MTW 密码 <small className="admin-configured">{mtw.data?.passwordConfigured ? '已配置，不回显' : '未配置'}</small><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空保持不变" /></label><div className="admin-form-actions"><Button className="secondary" onClick={() => save.mutate()} loading={save.isPending}>保存配置</Button><Button onClick={() => health.mutate()} loading={health.isPending}><Wifi size={16} />健康检查</Button></div></section></div>;
}
