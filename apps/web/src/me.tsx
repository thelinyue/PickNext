import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CalendarDays, Download, FolderHeart, History, LogOut, Mic2, Music2, Plus, Save, ShieldCheck, Trash2, Upload, Users, X } from 'lucide-react';
import type { HistoryItem, HistorySummary, ImportTask, PersonalSongListItem, SearchSongsResponse } from '@picknext/shared';
import { api } from './api.js';
import { BasicSongCard, Button, EmptyState, IconButton, PageHeader, Sheet, SongCard } from './components.js';

interface CurrentUser { username: string; role: 'admin' | 'user'; isMaintainer: boolean }
interface PlaylistSummary { id: number; name: string; songCount: number; collaboratorCount: number; ownerName: string; access: 'owner' | 'collaborator' }

/** SQLite 默认时间没有时区，而导入测试数据可能已带 Z；统一转换后再按用户本地日期分组。 */
function parseHistoryTime(value: string) {
  const isoValue = value.replace(' ', 'T');
  return new Date(/[zZ]$|[+-]\d{2}:\d{2}$/.test(isoValue) ? isoValue : `${isoValue}Z`);
}

export function MePage({ user, onLogout, onManageUsers, notify }: { user: CurrentUser; onLogout(): void; onManageUsers(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false); const [playlistOpen, setPlaylistOpen] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistSummary | null>(null); const [importOpen, setImportOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false); const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const history = useQuery({ queryKey: ['history-summary'], queryFn: () => api<{ summary: HistorySummary }> (`/api/history?limit=1&timezoneOffset=${new Date().getTimezoneOffset()}`) });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: PlaylistSummary[] }>('/api/playlists') });
  const canReview = user.role === 'admin' || user.isMaintainer;
  const reviewCount = useQuery({ queryKey: ['review-count'], enabled: canReview, queryFn: () => api<{ count: number }>('/api/reviews/count') });
  const userSummary = useQuery({ queryKey: ['admin-users-summary'], enabled: user.role === 'admin', queryFn: () => api<{ summary: { total: number; maintainers: number } }>('/api/admin/users?limit=1') });
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); onLogout(); };
  const exportData = async () => {
    try {
      const data = await api<object>('/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `picknext-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
      notify('数据已导出，请妥善保管文件。');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '导出失败，请稍后重试。'); }
  };
  return <section className="page me-page"><PageHeader eyebrow="个人空间" title={user.username} />
    <div className="me-quick-grid"><button onClick={() => setHistoryOpen(true)}><CalendarDays /><strong>{history.data?.summary.playedToday ?? 0}</strong><span>今日唱</span></button><button onClick={() => setHistoryOpen(true)}><Music2 /><strong>{history.data?.summary.playedTotal ?? 0}</strong><span>累计唱</span></button><button onClick={() => setHistoryOpen(true)}><Mic2 /><strong>{history.data?.summary.favoriteArtist ?? '—'}</strong><span>常唱歌手</span></button></div>
    <div className="profile-actions"><Button className="secondary" onClick={() => setImportOpen(true)}><Upload size={18} />批量收歌</Button><Button className="secondary" onClick={() => setExportConfirmOpen(true)}><Download size={18} />导出数据</Button></div>
    {canReview && <button className="admin-entry" onClick={() => setReviewsOpen(true)}><span><ShieldCheck /></span><div><strong>审核中心</strong><small>处理重复歌曲 · 保护全局曲库</small></div><b>{reviewCount.data?.count ?? 0} 待处理 ›</b></button>}
    {user.role === 'admin' && <button className="admin-entry" onClick={onManageUsers}><span><Users /></span><div><strong>用户与权限</strong><small>{userSummary.data ? `${userSummary.data.summary.total} 位用户 · ${userSummary.data.summary.maintainers} 位曲库管家` : '搜索、批量授权与永久删除'}</small></div><b>管理 ›</b></button>}
    <div className="section-heading"><h2 className="section-title">我的歌单</h2><button onClick={() => setPlaylistOpen(true)}><Plus size={16} />新建</button></div>
    <div className="playlist-grid">{playlists.data?.playlists.map((playlist) => <button key={playlist.id} onClick={() => setSelectedPlaylist(playlist)}><FolderHeart /><strong>{playlist.name}</strong><span>{playlist.songCount} 首 · {playlist.access === 'owner' ? `${playlist.collaboratorCount} 位协作者` : `${playlist.ownerName} 创建`}</span></button>)}</div>
    {!playlists.isLoading && !playlists.data?.playlists.length && <p className="helper">可以新建主题歌单，再邀请朋友一起维护。</p>}
    <button className="history-entry" onClick={() => setHistoryOpen(true)}><History /><span><strong>点歌历史</strong><small>已唱、未唱和本周记录</small></span><b>查看 ›</b></button>
    <button className="logout" onClick={logout}><LogOut size={18} />退出登录</button>
    <HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} />
    <ImportSheet open={importOpen} onOpenChange={setImportOpen} notify={notify} />
    <Sheet open={exportConfirmOpen} onOpenChange={setExportConfirmOpen} title="确认导出数据"><div className="sheet-stack"><p className="helper">将下载你的个人曲库、歌单、点歌历史和演唱记录。导出文件包含个人数据，请妥善保管。</p><Button onClick={() => { setExportConfirmOpen(false); void exportData(); }}><Download size={18} />确认导出</Button><Button className="secondary" onClick={() => setExportConfirmOpen(false)}>取消</Button></div></Sheet>
    <CreatePlaylistSheet open={playlistOpen} onOpenChange={setPlaylistOpen} notify={notify} onCreated={async () => { await client.invalidateQueries({ queryKey: ['playlists'] }); }} />
    <PlaylistSheet playlist={selectedPlaylist} onClose={() => setSelectedPlaylist(null)} notify={notify} />
    <ReviewCenter open={reviewsOpen} onOpenChange={setReviewsOpen} notify={notify} />
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
  return <Sheet open={open} onOpenChange={onOpenChange} title="点歌历史"><div className="history-stats"><div><strong>{history.data?.summary.playedTotal ?? 0}</strong><span>累计已唱</span></div><div><strong>{history.data?.summary.playedToday ?? 0}</strong><span>今天</span></div><div><strong>{history.data?.summary.favoriteArtist ?? '—'}</strong><span>常唱歌手</span></div></div><div className="scene-chips">{([['all','全部'],['week','本周'],['played','已唱']] as const).map(([value,label]) => <button className={period === value ? 'active' : ''} key={value} onClick={() => setPeriod(value)}>{label}</button>)}</div><div className="history-groups">{groups.map(([date, items]) => <details key={date}><summary><span>{date}</span><small>抽取 {items.length} 首 · 唱了 {items.filter((item) => item.status === 'played').length} 首</small></summary>{items.map((item) => <BasicSongCard key={item.id} song={{ id: item.songId, title: item.title, artist: item.artist, version: item.version, rating: item.rating }} action={<div className={`history-status ${item.status}`}>{item.status === 'played' ? '已唱' : '未唱'}{item.note && <small>{item.note}</small>}</div>} />)}</details>)}</div>{!history.isLoading && !groups.length && <EmptyState title="还没有点歌记录" description="从 Pick 开始唱第一首吧。" />}</Sheet>;
}

function CreatePlaylistSheet({ open, onOpenChange, onCreated, notify }: { open: boolean; onOpenChange(open: boolean): void; onCreated(): Promise<void>; notify(message: string): void }) {
  const [name, setName] = useState(''); const [search, setSearch] = useState(''); const [selected, setSelected] = useState<number[]>([]);
  const users = useQuery({ queryKey: ['collaborator-search', search], enabled: open, queryFn: () => api<{ users: Array<{ id: number; username: string }> }>(`/api/users/search?q=${encodeURIComponent(search)}`) });
  const create = useMutation({ mutationFn: () => api('/api/playlists', { method: 'POST', body: JSON.stringify({ name, collaboratorUserIds: selected }) }), onSuccess: async () => { setName(''); setSelected([]); onOpenChange(false); await onCreated(); notify('歌单已创建'); }, onError: (reason) => notify(reason instanceof Error ? reason.message : '歌单创建失败') });
  return <Sheet open={open} onOpenChange={onOpenChange} title="新建歌单"><div className="sheet-stack"><label>歌单名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：生日局" autoFocus /></label><label>邀请协作者<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名" /></label><div className="user-candidates">{users.data?.users.map((user) => <button key={user.id} className={selected.includes(user.id) ? 'selected' : ''} onClick={() => setSelected((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])}><span>{user.username}</span><b>{selected.includes(user.id) ? '✓ 已选' : '选择'}</b></button>)}</div><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>创建歌单</Button></div></Sheet>;
}

function PlaylistSheet({ playlist, onClose, notify }: { playlist: PlaylistSummary | null; onClose(): void; notify(message: string): void }) {
  const client = useQueryClient(); const [songSearch, setSongSearch] = useState(''); const [userSearch, setUserSearch] = useState(''); const [deleteConfirm, setDeleteConfirm] = useState(false); const [name, setName] = useState('');
  const detail = useQuery({ queryKey: ['playlist', playlist?.id], queryFn: () => api<{ playlist: PlaylistSummary & { ownerName: string }; songs: Array<{ id: number; title: string; artist: string; version: string | null }>; collaborators: Array<{ id: number; username: string }> }>(`/api/playlists/${playlist!.id}`), enabled: Boolean(playlist) });
  const candidates = useQuery({ queryKey: ['playlist-candidates', songSearch], enabled: Boolean(playlist), queryFn: async () => { const [a,b] = await Promise.all([api<SearchSongsResponse>(`/api/search?scope=personal&collection=repertoire&limit=100&q=${encodeURIComponent(songSearch)}`), api<SearchSongsResponse>(`/api/search?scope=personal&collection=learning&limit=100&q=${encodeURIComponent(songSearch)}`)]); return [...a.songs, ...b.songs].filter((song): song is PersonalSongListItem => song.scope === 'personal'); } });
  const users = useQuery({ queryKey: ['playlist-user-search', userSearch], enabled: Boolean(playlist) && detail.data?.playlist.access === 'owner', queryFn: () => api<{ users: Array<{ id: number; username: string }> }>(`/api/users/search?q=${encodeURIComponent(userSearch)}`) });
  const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['playlist', playlist?.id] }), client.invalidateQueries({ queryKey: ['playlists'] })]); };
  const call = useMutation({ mutationFn: ({ path, method = 'PUT', body = '{}' }: { path: string; method?: string; body?: string }) => api(path, method === 'DELETE' ? { method } : { method, body }), onSuccess: refresh, onError: (reason) => notify(reason instanceof Error ? reason.message : '歌单操作失败') });
  const reorder = (songId: number, direction: -1 | 1) => { if (!detail.data || !playlist) return; const ids = detail.data.songs.map((song) => song.id); const from = ids.indexOf(songId); const to = from + direction; if (to < 0 || to >= ids.length) return; [ids[from], ids[to]] = [ids[to]!, ids[from]!]; call.mutate({ path: `/api/playlists/${playlist.id}/order`, body: JSON.stringify({ songIds: ids }) }); };
  const remove = (songId: number) => playlist && call.mutate({ path: `/api/playlists/${playlist.id}/songs/${songId}`, method: 'DELETE' });
  const owner = detail.data?.playlist.access === 'owner';
  return <Sheet open={playlist !== null} onOpenChange={(open) => !open && onClose()} title={playlist?.name ?? '歌单'}><div className="sheet-stack">{detail.data && <><p className="helper">{owner ? `你创建的歌单 · ${detail.data.collaborators.length} 位协作者` : `${detail.data.playlist.ownerName} 创建 · 你可以共同维护歌曲`}</p>{owner && <div className="inline-edit"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={detail.data.playlist.name} /><Button className="secondary compact" disabled={!name.trim()} onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}`, method: 'PATCH', body: JSON.stringify({ name }) })}><Save size={15} />改名</Button></div>}<label>从我的曲库加歌<input value={songSearch} onChange={(event) => setSongSearch(event.target.value)} placeholder="搜索歌曲" /></label><div className="playlist-candidates">{candidates.data?.filter((song) => !detail.data!.songs.some((item) => item.id === song.id)).slice(0, 8).map((song) => <SongCard key={song.id} song={song} variant={song.collectionType === 'repertoire' ? 'personal-repertoire' : 'personal-learning'} action={<IconButton label={`加入${song.title}`} onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/songs/${song.id}` })}><Plus /></IconButton>} />)}</div><div className="song-list playlist-song-list">{detail.data.songs.map((song, index) => <BasicSongCard key={song.id} song={song} action={<div className="playlist-row-actions"><IconButton label="上移" disabled={index === 0 || call.isPending} onClick={() => reorder(song.id, -1)}><ArrowUp /></IconButton><IconButton label="下移" disabled={index === detail.data!.songs.length - 1 || call.isPending} onClick={() => reorder(song.id, 1)}><ArrowDown /></IconButton><IconButton label="移除歌曲" onClick={() => remove(song.id)}><X /></IconButton></div>} />)}</div>{!detail.data.songs.length && <EmptyState title="歌单还是空的" description="从上方搜索个人曲库并添加歌曲。" />}{owner && <section className="collaborator-section"><h3>协作者</h3>{detail.data.collaborators.map((member) => <div className="collaborator-row" key={member.id}><span>{member.username}</span><button onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/collaborators/${member.id}`, method: 'DELETE' })}>移除</button></div>)}<input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="搜索用户并邀请" />{users.data?.users.filter((user) => !detail.data!.collaborators.some((member) => member.id === user.id)).slice(0, 6).map((user) => <div className="collaborator-row" key={user.id}><span>{user.username}</span><button onClick={() => call.mutate({ path: `/api/playlists/${playlist!.id}/collaborators/${user.id}` })}>邀请</button></div>)}</section>}{owner && <div className="danger-zone">{deleteConfirm ? <div className="inline-confirm"><span>确定删除歌单并解除协作关系？</span><button onClick={() => setDeleteConfirm(false)}>取消</button><button className="danger-text" onClick={() => { call.mutate({ path: `/api/playlists/${playlist!.id}`, method: 'DELETE' }); onClose(); }}>确认删除</button></div> : <Button className="secondary danger-button" onClick={() => setDeleteConfirm(true)}><Trash2 />删除歌单</Button>}</div>}</>}</div></Sheet>;
}

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
