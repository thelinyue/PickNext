import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CalendarDays, Download, FolderHeart, History, LogOut, Mic2, Music2, Plus, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import type { HistoryItem, HistorySummary, ImportTask, PersonalSongListItem, SearchSongsResponse } from '@picknext/shared';
import { api } from './api.js';
import { BasicSongCard, Button, EmptyState, IconButton, PageHeader, Sheet, SongCard } from './components.js';

interface CurrentUser { username: string; nickname: string | null; displayName: string; avatarUrl: string | null; role: 'admin' | 'user'; isMaintainer: boolean }
interface PlaylistSummary { id: number; name: string; songCount: number; collaboratorCount: number; ownerName: string; access: 'owner' | 'collaborator' }

/** SQLite 默认时间没有时区，而导入测试数据可能已带 Z；统一转换后再按用户本地日期分组。 */
function parseHistoryTime(value: string) {
  const isoValue = value.replace(' ', 'T');
  return new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(isoValue) ? isoValue : `${isoValue}Z`);
}

export function MePage({ user, onLogout, onOpenAdmin, notify }: { user: CurrentUser; onLogout(): void; onOpenAdmin(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false); const [playlistOpen, setPlaylistOpen] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSummary | null>(null); const [importOpen, setImportOpen] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const history = useQuery({ queryKey: ['history-summary'], queryFn: () => api<{ summary: HistorySummary }> (`/api/history?limit=1&timezoneOffset=${new Date().getTimezoneOffset()}`) });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: PlaylistSummary[] }>('/api/playlists') });
  const canReview = user.role === 'admin' || user.isMaintainer;
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); onLogout(); };
  const exportData = async () => {
    try {
      const data = await api<object>('/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `picknext-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
      notify('数据已导出，请妥善保管文件。');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '导出失败，请稍后重试。'); }
  };
  return <section className="page me-page"><PageHeader eyebrow="个人空间" title={user.username} />
    <div className="me-quick-grid"><button onClick={() => setHistoryOpen(true)}><CalendarDays /><strong>{history.data?.summary.playedToday ?? 0}</strong><span>今日唱</span></button><button onClick={() => setHistoryOpen(true)}><Music2 /><strong>{history.data?.summary.playedTotal ?? 0}</strong><span>累计唱</span></button><button onClick={() => setHistoryOpen(true)}><Mic2 /><strong>{history.data?.summary.favoriteArtist ?? '暂无'}</strong><span>常唱歌手</span></button></div>
    <div className="profile-actions"><Button className="secondary" onClick={() => setImportOpen(true)}><Upload size={18} />批量收歌</Button><Button className="secondary" onClick={() => setExportConfirmOpen(true)}><Download size={18} />导出数据</Button></div>
    {canReview && <button className="admin-entry" onClick={onOpenAdmin}><span><ShieldCheck /></span><div><strong>管理后台</strong><small>MTW 导入、曲库治理、审核和任务中心</small></div><b>进入 ›</b></button>}
    <div className="section-heading"><h2 className="section-title">我的歌单</h2><button onClick={() => setPlaylistOpen(true)}><Plus size={16} />新建歌单</button></div>
    <div className="playlist-grid">{playlists.data?.playlists.map((playlist) => <button key={playlist.id} onClick={() => setSelectedPlaylist(playlist)}><FolderHeart /><strong>{playlist.name}</strong><span>{playlist.songCount} 首 · {playlist.access === 'owner' ? `${playlist.collaboratorCount} 位协作者` : `${playlist.ownerName} 创建`}</span></button>)}</div>
    {!playlists.isLoading && !playlists.data?.playlists.length && <p className="helper">可以新建主题歌单，再邀请朋友一起维护。</p>}
    <button className="history-entry" onClick={() => setHistoryOpen(true)}><History /><span><strong>点歌历史</strong><small>已唱、未唱和本周记录</small></span><b>查看 ›</b></button>
    <button className="logout" onClick={logout}><LogOut size={18} />退出登录</button>
    <HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />
    <ImportSheet open={importOpen} onOpenChange={setImportOpen} notify={notify} />
    <Sheet open={exportConfirmOpen} onOpenChange={setExportConfirmOpen} title="确认导出数据"><div className="sheet-stack"><p className="helper">将下载你的个人曲库、歌单、点歌历史和演唱记录。导出文件包含个人数据，请妥善保管。</p><Button onClick={() => { setExportConfirmOpen(false); void exportData(); }}><Download size={18} />确认导出</Button><Button className="secondary" onClick={() => setExportConfirmOpen(false)}>取消</Button></div></Sheet>
    <CreatePlaylistSheet open={playlistOpen} onOpenChange={setPlaylistOpen} notify={notify} onCreated={async () => { await client.invalidateQueries({ queryKey: ['playlists'] }); }} />
    <PlaylistSheet playlist={selectedPlaylist} onClose={() => setSelectedPlaylist(null)} notify={notify} />
  </section>;
}

function HistorySheet({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [period, setPeriod] = useState<'all' | 'week' | 'played'>('all');
  const history = useQuery({ queryKey: ['history', period], enabled: open, queryFn: () => api<{ items: HistoryItem[]; summary: HistorySummary }>(`/api/history?period=${period}&limit=200&timezoneOffset=${new Date().getTimezoneOffset()}`) });
  const groups = useMemo(() => {
    const result = new Map<string, HistoryItem[]>();
    for (const item of history.data?.items ?? []) { const date = parseHistoryTime(item.occurredAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }); result.set(date, [...(result.get(date) ?? []), item]); }
    return [...result.entries()];
  }, [history.data]);
  return <Sheet open={open} onOpenChange={onOpenChange} title="点歌历史"><div className="history-stats"><div><strong>{history.data?.summary.playedTotal ?? 0}</strong><span>累计已唱</span></div><div><strong>{history.data?.summary.playedToday ?? 0}</strong><span>今天</span></div><div><strong>{history.data?.summary.favoriteArtist ?? '暂无'}</strong><span>常唱歌手</span></div></div><div className="scene-chips">{([['all','全部'],['week','本周'],['played','已唱']] as const).map(([value,label]) => <button className={period === value ? 'active' : ''} key={value} onClick={() => setPeriod(value)}>{label}</button>)}</div><div className="history-groups">{groups.map(([date, items]) => <details key={date}><summary><span>{date}</span><small>抽取 {items.length} 首 · 唱了 {items.filter((item) => item.status === 'played').length} 首</small></summary>{items.map((item) => <BasicSongCard key={item.id} song={{ id: item.songId, title: item.title, artist: item.artist, version: item.version, album: item.album ?? null, coverUrl: item.coverUrl ?? null, rating: item.rating }} action={<div className={`history-status ${item.status}`}>{item.status === 'played' ? '已唱' : '未唱'}{item.note && <small>{item.note}</small>}</div>} />)}</details>)}</div>{!history.isLoading && !groups.length && <EmptyState title="还没有点歌记录" description="从 Pick 开始唱第一首吧。" />}</Sheet>;
}

// 旧版入口保留兼容代码，管理操作已迁移到 AdminConsole。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MtwAdminSheet({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['mtw-settings'], enabled: open, queryFn: () => api<{ baseUrl: string; tokenConfigured: boolean; usernameConfigured: boolean; passwordConfigured: boolean }>('/api/admin/settings/mtw') });
  const batches = useQuery({ queryKey: ['mtw-batches'], enabled: open, queryFn: () => api<{ batches: Array<{ id: string; status: string; result: string | null; createdAt: string }> }>('/api/admin/mtw/import-batches') });
  const [baseUrl, setBaseUrl] = useState(''); const [token, setToken] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [path, setPath] = useState('/app/media'); const [busy, setBusy] = useState(false); const [batch, setBatch] = useState<any | null>(null); const [candidateQuery, setCandidateQuery] = useState(''); const [candidatePage, setCandidatePage] = useState(1); const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  useEffect(() => { if (settings.data) setBaseUrl(settings.data.baseUrl); }, [settings.data]);
  useEffect(() => {
    if (!open || batch || batches.isFetching || !batches.data) return;
    const resumable = batches.data.batches.find((item) => item.status === 'scanning' || item.status === 'ready');
    if (resumable) setBatch({ id: resumable.id });
  }, [open, batch, batches.data, batches.isFetching]);
  const save = async () => { setBusy(true); try { await api('/api/admin/settings/mtw', { method: 'PUT', body: JSON.stringify({ baseUrl, token: token || undefined, username: username || undefined, password: password || undefined }) }); setToken(''); setPassword(''); notify('MTW 配置已保存。'); await settings.refetch(); } catch (reason) { notify(reason instanceof Error ? reason.message : 'MTW 配置保存失败'); } finally { setBusy(false); } };
  const health = async () => { try { const result = await api<{ ok: boolean; message: string }>('/api/admin/mtw/health'); notify(result.message); } catch (reason) { notify(reason instanceof Error ? reason.message : 'MTW 健康检查失败'); } };
  const scan = async () => { setBusy(true); try { const result = await api<{ batchId: string; status: string }>('/api/admin/mtw/scans', { method: 'POST', body: JSON.stringify({ path }) }); setBatch({ id: result.batchId }); notify('MTW 扫描已开始，正在读取歌曲目录...'); await client.invalidateQueries({ queryKey: ['mtw-batches'] }); } catch (reason) { notify(reason instanceof Error ? reason.message : 'MTW 扫描失败'); } finally { setBusy(false); } };
  const detail = useQuery({ queryKey: ['mtw-scan', batch?.id], enabled: Boolean(batch?.id), queryFn: () => api<{ batch: { status: string; error: string | null }; progress: { phase: string; completed: number; total: number; message: string } | null; items: Array<{ id: number; title: string; artist: string; album: string | null }> }>(`/api/admin/mtw/scans/${batch.id}`), refetchInterval: (query) => query.state.data?.batch.status === 'scanning' ? 800 : false });
  const candidateItems = detail.data?.items ?? [];
  const filteredCandidates = useMemo(() => { const query = candidateQuery.trim().toLocaleLowerCase('zh-CN'); if (!query) return candidateItems; return candidateItems.filter((item) => [item.title, item.artist, item.album ?? ''].some((value) => value.toLocaleLowerCase('zh-CN').includes(query))); }, [candidateItems, candidateQuery]);
  const candidatePageCount = Math.max(1, Math.ceil(filteredCandidates.length / 30));
  const visibleCandidates = filteredCandidates.slice((candidatePage - 1) * 30, candidatePage * 30);
  useEffect(() => { setCandidatePage(1); setCandidateQuery(''); setSelectedItemIds(new Set()); }, [batch?.id]);
  useEffect(() => { if (candidatePage > candidatePageCount) setCandidatePage(candidatePageCount); }, [candidatePage, candidatePageCount]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const toggleCandidate = (id: number) => setSelectedItemIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const selectVisibleCandidates = () => setSelectedItemIds((current) => new Set([...current, ...visibleCandidates.map((item) => item.id)]));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const clearVisibleCandidates = () => setSelectedItemIds((current) => { const next = new Set(current); for (const item of visibleCandidates) next.delete(item.id); return next; });
  const importSelected = async () => { if (!batch || !selectedItemIds.size) return; setBusy(true); try { await api('/api/admin/mtw/import-batches', { method: 'POST', body: JSON.stringify({ scanId: batch.id, itemIds: [...selectedItemIds] }) }); notify(`MTW 歌曲与封面导入完成，共 ${selectedItemIds.size} 首。`); setBatch(null); await batches.refetch(); } catch (reason) { notify(reason instanceof Error ? reason.message : 'MTW 导入失败'); } finally { setBusy(false); } };
  const batchAction = async (id: string, action: 'revoke' | 'retry-covers') => { setBusy(true); try { const result = await api<{ revoked?: number; needsReview?: number; imported?: number; failed?: number }>(`/api/admin/mtw/import-batches/${id}/${action}`, { method: 'POST', body: '{}' }); notify(action === 'revoke' ? `批次已处理：撤销 ${result.revoked ?? 0} 首，${result.needsReview ?? 0} 首转入删除审核。` : `封面重试完成：成功 ${result.imported ?? 0} 首，失败 ${result.failed ?? 0} 首。`); await batches.refetch(); } catch (reason) { notify(reason instanceof Error ? reason.message : 'MTW 批次操作失败'); } finally { setBusy(false); } };
  const scanning = detail.data?.batch.status === 'scanning';
  const progress = detail.data?.progress;
  const progressPercent = progress?.total ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 8;
  return <Sheet open={open} onOpenChange={onOpenChange} title="MTW 曲库服务"><div className="sheet-stack"><label>MTW 服务地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.x.x:8016" /></label><label>Bearer Token{settings.data?.tokenConfigured && <small> 已配置，留空保持不变</small>}<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="歌词和健康检查使用，只保存在服务端" /></label><div className="form-grid"><label>MTW 用户名{settings.data?.usernameConfigured && <small> 已配置，留空保持不变</small>}<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用于歌曲扫描登录" /></label><label>MTW 密码{settings.data?.passwordConfigured && <small> 已配置，留空保持不变</small>}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="用于歌曲扫描登录" /></label></div><div className="form-grid"><Button className="secondary" onClick={() => void save()} loading={busy}>保存配置</Button><Button className="secondary" onClick={() => void health()}>健康检查</Button></div><label>MTW 媒体目录<input value={path} onChange={(event) => setPath(event.target.value)} /></label><Button onClick={() => void scan()} loading={busy || scanning}>扫描歌曲、歌词和封面</Button>{scanning && <div className="mtw-progress" role="status"><div className="mtw-progress-head"><strong>{progress?.message ?? '正在扫描 MTW...'}</strong><span>{progress?.total ? `${progress.completed}/${progress.total}` : '准备中'}</span></div><div className="mtw-progress-track"><span className="mtw-progress-fill" style={{ width: `${progressPercent}%` }} /></div><small>扫描期间可以等待，完成后会显示候选歌曲。</small></div>}{detail.data?.batch.status === 'failed' && <p className="error-text">{detail.data.batch.error ?? 'MTW 扫描失败。'}</p>}{detail.data?.batch.status === 'ready' && <><p className="helper">找到 {detail.data.items.length} 首候选，确认后才会写入 PickNext。</p><div className="song-list">{detail.data.items.slice(0, 30).map((item) => <div className="candidate-option" key={item.id}><strong>{item.title} · {item.artist}</strong><span>{item.album ?? '专辑未填'}</span></div>)}</div><Button onClick={() => void importSelected()} loading={busy}>导入全部候选</Button></>}{detail.data?.batch.status !== 'scanning' && <section className="mtw-batch-history"><h3>导入批次</h3>{batches.data?.batches.slice(0, 8).map((item) => <div className="collaborator-row" key={item.id}><span>{item.status} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span><div><button disabled={busy || !['done', 'ready'].includes(item.status)} onClick={() => void batchAction(item.id, 'retry-covers')}>重试封面</button><button disabled={busy || !['done', 'ready'].includes(item.status)} onClick={() => void batchAction(item.id, 'revoke')}>撤销新增</button></div></div>)}{!batches.isLoading && !batches.data?.batches.length && <p className="helper">还没有 MTW 导入批次。</p>}</section>}</div></Sheet>;
}

function CreatePlaylistSheet({ open, onOpenChange, onCreated, notify }: { open: boolean; onOpenChange(open: boolean): void; onCreated(): Promise<void>; notify(message: string): void }) {
  const [name, setName] = useState(''); const [search, setSearch] = useState(''); const [selected, setSelected] = useState<number[]>([]);
  const users = useQuery({ queryKey: ['collaborator-search', search], enabled: open, queryFn: () => api<{ users: Array<{ id: number; username: string }> }>(`/api/users/search?q=${encodeURIComponent(search)}`) });
  const create = useMutation({ mutationFn: () => api('/api/playlists', { method: 'POST', body: JSON.stringify({ name, collaboratorUserIds: selected }) }), onSuccess: async () => { setName(''); setSelected([]); onOpenChange(false); await onCreated(); notify('歌单已创建'); }, onError: (reason) => notify(reason instanceof Error ? reason.message : '歌单创建失败') });
  return <Sheet open={open} onOpenChange={onOpenChange} title="新建歌单"><div className="sheet-stack"><label>歌单名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：生日局" autoFocus /></label><label>邀请协作者<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名" /></label><div className="user-candidates">{users.data?.users.map((user) => <button key={user.id} className={selected.includes(user.id) ? 'selected' : ''} onClick={() => setSelected((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])}><span>{user.username}</span><b>{selected.includes(user.id) ? '✓ 已选' : '选择'}</b></button>)}</div><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>创建歌单</Button></div></Sheet>;
}

function PlaylistSheet({ playlist, onClose, notify }: { playlist: PlaylistSummary | null; onClose(): void; notify(message: string): void }) {
  const client = useQueryClient(); const [songSearch, setSongSearch] = useState(''); const [userSearch, setUserSearch] = useState(''); const [deleteConfirm, setDeleteConfirm] = useState(false); const [name, setName] = useState('');
  const detail = useQuery({ queryKey: ['playlist', playlist?.id], queryFn: () => api<{ playlist: PlaylistSummary & { ownerName: string }; songs: Array<{ id: number; title: string; artist: string; version: string | null; album?: string | null; coverUrl?: string | null }>; collaborators: Array<{ id: number; username: string }> }>(`/api/playlists/${playlist!.id}`), enabled: Boolean(playlist) });
  const candidates = useQuery({ queryKey: ['playlist-candidates', songSearch], enabled: Boolean(playlist), queryFn: async () => { const [a,b] = await Promise.all([api<SearchSongsResponse>(`/api/search?scope=personal&collection=repertoire&limit=100&q=${encodeURIComponent(songSearch)}`), api<SearchSongsResponse>(`/api/search?scope=personal&collection=learning&limit=100&q=${encodeURIComponent(songSearch)}`)]); return [...a.songs, ...b.songs].filter((song): song is PersonalSongListItem => song.scope === 'personal'); } });
  const users = useQuery({ queryKey: ['playlist-user-search', userSearch], enabled: Boolean(playlist) && detail.data?.playlist.access === 'owner', queryFn: () => api<{ users: Array<{ id: number; username: string }> }>(`/api/users/search?q=${encodeURIComponent(userSearch)}`) });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['playlist', playlist?.id] }), client.invalidateQueries({ queryKey: ['playlists'] })]); };
  const call = useMutation({ mutationFn: ({ path, method = 'PUT', body = '{}' }: { path: string; method?: string; body?: string }) => api(path, method === 'DELETE' ? { method } : { method, body }), onSuccess: refresh, onError: (reason) => notify(reason instanceof Error ? reason.message : '歌单操作失败') });
  const reorder = (songId: number, direction: -1 | 1) => { if (!detail.data || !playlist) return; const ids = detail.data.songs.map((song) => song.id); const from = ids.indexOf(songId); const to = from + direction; if (to < 0 || to >= ids.length) return; [ids[from], ids[to]] = [ids[to]!, ids[from]!]; call.mutate({ path: `/api/playlists/${playlist.id}/order`, body: JSON.stringify({ songIds: ids }) }); };
  const remove = (songId: number) => playlist && call.mutate({ path: `/api/playlists/${playlist.id}/songs/${songId}`, method: 'DELETE' });
  const owner = detail.data?.playlist.access === 'owner';
  return <Sheet open={playlist !== null} onOpenChange={(open) => !open && onClose()} title={playlist?.name ?? '歌单'}><div className="sheet-stack">{detail.data && <><p className="helper">{owner ? `你创建的歌单 · ${detail.data.collaborators.length} 位协作者` : `${detail.data.playlist.ownerName} 创建 · 你可以共同维护歌曲`}</p>{owner && <div className="inline-edit"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={detail.data.playlist.name} /><Button className="secondary compact" disabled={!name.trim()} onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}`, method: 'PATCH', body: JSON.stringify({ name }) })}><Save size={15} />改名</Button></div>}<label>从我的曲库加歌<input value={songSearch} onChange={(event) => setSongSearch(event.target.value)} placeholder="搜索歌曲" /></label><div className="playlist-candidates">{candidates.data?.filter((song) => !detail.data!.songs.some((item) => item.id === song.id)).slice(0, 8).map((song) => <SongCard key={song.id} song={song} variant={song.collectionType === 'repertoire' ? 'personal-repertoire' : 'personal-learning'} action={<IconButton label={`加入${song.title}`} onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/songs/${song.id}` })}><Plus /></IconButton>} />)}</div><div className="song-list playlist-song-list">{detail.data.songs.map((song, index) => <BasicSongCard key={song.id} song={song} action={<div className="playlist-row-actions"><IconButton label="上移" disabled={index === 0 || call.isPending} onClick={() => reorder(song.id, -1)}><ArrowUp /></IconButton><IconButton label="下移" disabled={index === detail.data!.songs.length - 1 || call.isPending} onClick={() => reorder(song.id, 1)}><ArrowDown /></IconButton><IconButton label="移除歌曲" onClick={() => remove(song.id)}><X /></IconButton></div>} />)}</div>{!detail.data.songs.length && <EmptyState title="歌单还是空的" description="从上方搜索个人曲库并添加歌曲。" />}{owner && <section className="collaborator-section"><h3>协作者</h3>{detail.data.collaborators.map((member) => <div className="collaborator-row" key={member.id}><span>{member.username}</span><button onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/collaborators/${member.id}`, method: 'DELETE' })}>移除</button></div>)}<input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="搜索用户并邀请" />{users.data?.users.filter((user) => !detail.data!.collaborators.some((member) => member.id === user.id)).slice(0, 6).map((user) => <div className="collaborator-row" key={user.id}><span>{user.username}</span><button onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/collaborators/${user.id}` })}>邀请</button></div>)}</section>}{owner && <div className="danger-zone">{deleteConfirm ? <div className="inline-confirm"><span>确定删除歌单并解除协作关系？</span><button onClick={() => setDeleteConfirm(false)}>取消</button><button className="danger-text" onClick={() => { call.mutate({ path: `/api/playlists/${playlist!.id}`, method: 'DELETE' }); onClose(); }}>确认删除</button></div> : <Button className="secondary danger-button" onClick={() => setDeleteConfirm(true)}><Trash2 />删除歌单</Button>}</div>}</>}</div></Sheet>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function GovernanceReviewCenter({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const client = useQueryClient();
  const deletion = useQuery({ queryKey: ['deletion-reviews'], enabled: open, queryFn: () => api<{ requests: Array<{ id: number; songId: number; title: string; artist: string; album: string | null; requester: string; note: string | null }> }>('/api/reviews/deletion-requests') });
  const lyrics = useQuery({ queryKey: ['lyrics-reviews'], enabled: open, queryFn: () => api<{ submissions: Array<{ id: number; songId: number; title: string; artist: string; album: string | null; lyrics: string; submitter: string; source: string }> }>('/api/reviews/lyrics') });
  const decide = useMutation({
    mutationFn: ({ path }: { path: string }) => api(path, { method: 'POST', body: '{}' }),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['deletion-reviews'] }), client.invalidateQueries({ queryKey: ['lyrics-reviews'] }), client.invalidateQueries({ queryKey: ['review-count'] }), client.invalidateQueries({ queryKey: ['library-search'] })]); notify('治理审核已处理'); },
    onError: (reason) => notify(reason instanceof Error ? reason.message : '治理审核处理失败')
  });
  return <Sheet open={open} onOpenChange={onOpenChange} title="曲库治理"><div className="review-list"><h3>歌曲删除申请</h3>{deletion.data?.requests.map((item) => <article className="review-card" key={`deletion-${item.id}`}><header><strong>{item.title} · {item.artist}</strong><span>{item.requester}</span></header><p className="helper">{item.album ?? '专辑未填'}{item.note ? ` · ${item.note}` : ''}</p><div className="review-actions"><Button className="secondary" loading={decide.isPending} onClick={() => decide.mutate({ path: `/api/reviews/deletion-requests/${item.id}/reject` })}>保留歌曲</Button><Button loading={decide.isPending} onClick={() => decide.mutate({ path: `/api/reviews/deletion-requests/${item.id}/approve` })}>批准删除</Button></div></article>)}{!deletion.isLoading && !deletion.data?.requests.length && <p className="helper">没有待处理的删除申请。</p>}<h3>歌词审核</h3>{lyrics.data?.submissions.map((item) => <article className="review-card" key={`lyrics-${item.id}`}><header><strong>{item.title} · {item.artist}</strong><span>{item.submitter} · {item.source}</span></header><p className="lyrics-review-preview">{item.lyrics.slice(0, 400)}</p><div className="review-actions"><Button className="secondary" loading={decide.isPending} onClick={() => decide.mutate({ path: `/api/reviews/lyrics/${item.id}/reject` })}>拒绝歌词</Button><Button loading={decide.isPending} onClick={() => decide.mutate({ path: `/api/reviews/lyrics/${item.id}/approve` })}>批准歌词</Button></div></article>)}{!lyrics.isLoading && !lyrics.data?.submissions.length && <p className="helper">没有待处理的歌词。</p>}</div></Sheet>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ReviewCenter({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const client = useQueryClient(); const [approving, setApproving] = useState<any | null>(null); const [version, setVersion] = useState('');
  const reviews = useQuery({ queryKey: ['reviews'], enabled: open, queryFn: () => api<{ reviews: any[] }>('/api/reviews?status=pending') });
  const decide = useMutation({ mutationFn: ({ id, action, body = {} }: { id: number; action: 'merge' | 'approve' | 'reject'; body?: object }) => api(`/api/reviews/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) }), onSuccess: async () => { setApproving(null); await Promise.all([client.invalidateQueries({ queryKey: ['reviews'] }), client.invalidateQueries({ queryKey: ['review-count'] }), client.invalidateQueries({ queryKey: ['library-search'] })]); notify('审核已处理'); }, onError: (reason) => notify(reason instanceof Error ? reason.message : '审核处理失败') });
  return <Sheet open={open} onOpenChange={onOpenChange} title="审核中心"><div className="review-list">{reviews.data?.reviews.map((review) => <article className="review-card" key={review.id}><header><strong>「{review.submitted.title}」重复提交</strong><span>{review.submitter}</span></header><div className="review-compare"><div><b>用户提交</b><span>{review.submitted.title}</span><span>{review.submitted.artist}</span><span>{review.submitted.version || '原版'}</span><span>{review.submitted.language || '语种未填'} · {review.submitted.genre || '曲风未填'}</span></div><div><b>曲库已有</b><span>{review.matched?.title}</span><span>{review.matched?.artist}</span><span>{review.matched?.version || '原版'}</span><span>{review.matched?.language || '语种未填'} · {review.matched?.genre || '曲风未填'}</span></div></div>{approving?.id === review.id ? <div className="approve-form"><label>独立版本名称<input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="例如：Live 2025" /></label><div><Button className="secondary" onClick={() => setApproving(null)}>取消</Button><Button disabled={!version.trim()} loading={decide.isPending} onClick={() => decide.mutate({ id: review.id, action: 'approve', body: { ...review.submitted, version } })}>批准独立版本</Button></div></div> : <div className="review-actions"><Button className="secondary" loading={decide.isPending} onClick={() => decide.mutate({ id: review.id, action: 'reject' })}>拒绝</Button><Button className="secondary" onClick={() => { setApproving(review); setVersion(review.submitted.version ?? ''); }}>独立版本</Button><Button loading={decide.isPending} onClick={() => decide.mutate({ id: review.id, action: 'merge' })}>合并复用</Button></div>}</article>)}{!reviews.isLoading && !reviews.data?.reviews.length && <EmptyState title="没有待审核提交" description="重复歌曲处理完成后会从这里移除。" />}</div></Sheet>;
}

export function ImportSheet({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const client = useQueryClient();
  const [content, setContent] = useState(''); const [busy, setBusy] = useState(false); const [format, setFormat] = useState<'text' | 'csv' | 'json'>('text');
  const [fileName, setFileName] = useState(''); const [taskId, setTaskId] = useState<string | null>(null);
  const [collectionType, setCollectionType] = useState<'learning' | 'repertoire' | null>('learning');
  const notifiedTask = useRef<string | null>(null);
  const task = useQuery({
    queryKey: ['import-task', taskId],
    enabled: Boolean(taskId),
    queryFn: () => api<ImportTask>(`/api/tasks/${taskId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ['done', 'failed', 'cancelled'].includes(status) ? false : 700;
    }
  });
  const running = task.data?.status === 'pending' || task.data?.status === 'running';
  const result = useMemo(() => {
    if (!task.data?.result) return null;
    try { return JSON.parse(task.data.result) as { imported?: number; reused?: number; needsConfirmation?: unknown[] }; }
    catch { return null; }
  }, [task.data?.result]);

  useEffect(() => {
    if (!task.data || notifiedTask.current === task.data.id) return;
    if (task.data.status === 'done') {
      notifiedTask.current = task.data.id;
      void client.invalidateQueries({ queryKey: ['library-search'] });
      notify(`导入完成：新增 ${result?.imported ?? 0} 首，复用 ${result?.reused ?? 0} 首${result?.needsConfirmation?.length ? `，${result.needsConfirmation.length} 首待审核` : ''}。`);
    } else if (task.data.status === 'failed') {
      notifiedTask.current = task.data.id;
      notify(task.data.error ?? '导入失败，请检查文件内容后重试。');
    } else if (task.data.status === 'cancelled') {
      notifiedTask.current = task.data.id;
      notify('导入任务已取消。');
    }
  }, [client, notify, result, task.data]);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const extension = file.name.toLowerCase().split('.').pop();
    const detected = extension === 'json' ? 'json' : extension === 'csv' ? 'csv' : 'text';
    setFormat(detected); setFileName(file.name); setContent(await file.text()); setTaskId(null); event.target.value = '';
  };
  const submit = async () => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      const created = await api<{ taskId: string }>('/api/imports', { method: 'POST', body: JSON.stringify({ format, content, collectionType }) });
      setTaskId(created.taskId); notifiedTask.current = null; notify('导入任务已创建，正在处理。');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '导入失败'); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!taskId || !running) return;
    try { await api(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: '{}' }); await task.refetch(); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '取消导入失败，请重试。'); }
  };
  return <Sheet open={open} onOpenChange={onOpenChange} title="批量收歌"><div className="sheet-stack">
    <p className="helper">支持逐行粘贴，也可以选择 TXT、CSV 或 JSON 文件。CSV 需要包含 title、artist 列。</p>
    <label>选择文件<input type="file" accept=".txt,.csv,.json,text/plain,text/csv,application/json" onChange={(event) => void chooseFile(event)} /></label>
    {fileName && <p className="helper">已选择：{fileName}</p>}
    <label>导入格式<select value={format} onChange={(event) => setFormat(event.target.value as 'text' | 'csv' | 'json')}><option value="text">文本：歌名 - 歌手</option><option value="csv">CSV：title,artist,version</option><option value="json">JSON：歌曲对象数组</option></select></label>
    <label>个人归属<select value={collectionType ?? ''} onChange={(event) => setCollectionType((event.target.value || null) as 'learning' | 'repertoire' | null)}><option value="learning">待学清单</option><option value="repertoire">会唱曲库</option><option value="">仅维护全局资料，不收录到我的个人曲库</option></select></label>
    <textarea className="import-area" value={content} onChange={(event) => setContent(event.target.value)} placeholder={'晴天 - 周杰伦\n富士山下 - 陈奕迅'} />
    {task.data && <div className={`import-task-status ${task.data.status}`} role="status"><strong>{task.data.status === 'pending' ? '等待处理' : task.data.status === 'running' ? '正在导入' : task.data.status === 'done' ? '导入完成' : task.data.status === 'cancelled' ? '已取消' : '导入失败'}</strong>{task.data.error && <span>{task.data.error}</span>}{result && <span>新增 {result.imported ?? 0} 首 · 复用 {result.reused ?? 0} 首{result.needsConfirmation?.length ? ` · 待审核 ${result.needsConfirmation.length} 首` : ''}</span>}</div>}
    <div className="import-actions"><Button disabled={!content.trim() || running} loading={busy} onClick={() => void submit()}>开始导入</Button>{running && <Button className="secondary" onClick={() => void cancel()}>取消任务</Button>}</div>
  </div></Sheet>;
}
