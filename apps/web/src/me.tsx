import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderHeart, KeyRound, LogOut, Plus, ShieldCheck, Upload, UserPlus } from 'lucide-react';
import type { AdminUser } from '@picknext/shared';
import { api } from './api.js';
import { BasicSongCard, Button, EmptyState, PageHeader, Sheet } from './components.js';

export function MePage({ username, role, onLogout, notify }: { username: string; role: 'admin' | 'user'; onLogout(): void; notify(message: string): void }) {
  const client = useQueryClient();
  const history = useQuery({ queryKey: ['history'], queryFn: () => api<{ plays: any[] }>('/api/history') });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: Array<{ id: number; name: string; songCount: number }> }>('/api/playlists') });
  const [importOpen, setImportOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<{ id: number; name: string } | null>(null);
  const exportData = async () => {
    const data = await api('/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `picknext-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); onLogout(); };
  return <section className="page"><PageHeader eyebrow="个人空间" title={username} /><div className="profile-card"><div><strong>{history.data?.plays.length ?? 0}</strong><span>最近记录</span></div><Button className="secondary" onClick={() => setImportOpen(true)}><Upload size={18} />批量收歌</Button><Button className="secondary" onClick={exportData}><Download size={18} />导出数据</Button></div>{role === 'admin' && <button className="admin-entry" onClick={() => setUsersOpen(true)}><span><ShieldCheck /></span><div><strong>用户与权限</strong><small>创建账号 · 授予曲库管家 · 重置密码</small></div><b>管理 ›</b></button>}<div className="section-heading"><h2 className="section-title">我的歌单</h2><button onClick={() => setPlaylistOpen(true)}><Plus size={16} />新建</button></div><div className="playlist-grid">{playlists.data?.playlists.map((playlist) => <button key={playlist.id} onClick={() => setSelectedPlaylist(playlist)}><FolderHeart /><strong>{playlist.name}</strong><span>{playlist.songCount} 首</span></button>)}</div>{!playlists.isLoading && !playlists.data?.playlists.length && <p className="helper">可以新建主题歌单，再从歌曲卡加入。</p>}<h2 className="section-title">点歌历史</h2><div className="song-list">{history.data?.plays.map((play) => <BasicSongCard key={play.id} song={{ id: play.songId, title: play.title, artist: play.artist, version: play.version, rating: play.rating }} action={<time>{String(play.playedAt).slice(5, 16)}</time>} />)}</div>{!history.isLoading && !history.data?.plays.length && <EmptyState title="还没有演唱记录" description="从 Pick 唱完第一首后，这里会留下你的声音轨迹。" />}<button className="logout" onClick={logout}><LogOut size={18} />退出登录</button><ImportSheet open={importOpen} onOpenChange={setImportOpen} notify={notify} /><CreatePlaylistSheet open={playlistOpen} onOpenChange={setPlaylistOpen} onCreated={async () => { await client.invalidateQueries({ queryKey: ['playlists'] }); notify('歌单已创建'); }} /><PlaylistSheet playlist={selectedPlaylist} onClose={() => setSelectedPlaylist(null)} /><UserManagementSheet open={usersOpen} onOpenChange={setUsersOpen} notify={notify} /></section>;
}

/** 管理员用户面板只承载 v1 必需能力，不在这里加入删除用户等高风险操作。 */
function UserManagementSheet({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], enabled: open, queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users') });
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newMaintainer, setNewMaintainer] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const refresh = () => client.invalidateQueries({ queryKey: ['admin-users'] });
  const createUser = useMutation({
    mutationFn: () => api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: newUsername, password: newPassword, isMaintainer: newMaintainer, canAddSongs: true }) }),
    onSuccess: async () => { await refresh(); setNewUsername(''); setNewPassword(''); setNewMaintainer(false); setCreateOpen(false); notify('用户已创建'); },
    onError: (error) => notify(error instanceof Error ? error.message : '创建用户失败')
  });
  const updateUser = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { isMaintainer?: boolean; canAddSongs?: boolean } }) => api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => { await refresh(); notify('用户权限已更新'); },
    onError: (error) => notify(error instanceof Error ? error.message : '更新权限失败')
  });
  const reset = useMutation({
    mutationFn: () => api(`/api/admin/users/${resetTarget!.id}/password`, { method: 'PUT', body: JSON.stringify({ password: resetPassword }) }),
    onSuccess: () => { notify('密码已重置'); setResetTarget(null); setResetPassword(''); },
    onError: (error) => notify(error instanceof Error ? error.message : '重置密码失败')
  });
  return <Sheet open={open} onOpenChange={onOpenChange} title="用户与权限"><div className="sheet-stack"><p className="helper">曲库管家可以维护全局歌曲；添加权限关闭后仍可管理自己的已有歌曲。</p><Button className="secondary" onClick={() => setCreateOpen((value) => !value)}><UserPlus size={18} />{createOpen ? '取消新增' : '新增用户'}</Button>{createOpen && <div className="admin-user-form"><label>用户名<input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} minLength={2} maxLength={40} /></label><label>初始密码<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} /></label><label className="check-row"><input type="checkbox" checked={newMaintainer} onChange={(event) => setNewMaintainer(event.target.checked)} /><span>创建为曲库管家</span></label><Button disabled={createUser.isPending || newUsername.trim().length < 2 || newPassword.length < 8} onClick={() => createUser.mutate()}>创建账号</Button></div>}<div className="admin-user-list">{users.data?.users.map((user) => <div className="admin-user-row" key={user.id}><div className="admin-user-head"><div><strong>{user.username}</strong><span className={`role-badge ${user.role === 'admin' ? 'admin' : user.isMaintainer ? 'maintainer' : 'user'}`}>{user.role === 'admin' ? '管理员' : user.isMaintainer ? '曲库管家' : '普通用户'}</span></div><small>{new Date(user.createdAt).toLocaleDateString('zh-CN')}</small></div>{user.role !== 'admin' && <div className="admin-user-actions"><button onClick={() => updateUser.mutate({ id: user.id, body: { isMaintainer: !user.isMaintainer } })}>{user.isMaintainer ? '降为普通用户' : '授予曲库管家'}</button><label className="permission-toggle"><input type="checkbox" checked={user.canAddSongs} onChange={(event) => updateUser.mutate({ id: user.id, body: { canAddSongs: event.target.checked } })} />允许添加歌曲</label><button onClick={() => { setResetTarget(user); setResetPassword(''); }}><KeyRound size={15} />重置密码</button></div>}{resetTarget?.id === user.id && <div className="reset-password"><input aria-label={`为${user.username}设置新密码`} type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="至少 8 位" /><Button disabled={reset.isPending || resetPassword.length < 8} onClick={() => reset.mutate()}>确认重置</Button></div>}</div>)}</div></div></Sheet>;
}

function CreatePlaylistSheet({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(open: boolean): void; onCreated(): void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); try { await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name }) }); setName(''); onOpenChange(false); onCreated(); } finally { setBusy(false); } };
  return <Sheet open={open} onOpenChange={onOpenChange} title="新建歌单"><div className="sheet-stack"><label>歌单名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：深夜慢歌" autoFocus /></label><Button disabled={busy || !name.trim()} onClick={submit}>创建歌单</Button></div></Sheet>;
}

function PlaylistSheet({ playlist, onClose }: { playlist: { id: number; name: string } | null; onClose(): void }) {
  const detail = useQuery({ queryKey: ['playlist', playlist?.id], queryFn: () => api<{ songs: any[] }>(`/api/playlists/${playlist!.id}`), enabled: Boolean(playlist) });
  return <Sheet open={playlist !== null} onOpenChange={(open) => !open && onClose()} title={playlist?.name ?? '歌单'}><div className="song-list">{detail.data?.songs.map((song) => <BasicSongCard key={song.id} song={song} />)}</div>{!detail.isLoading && !detail.data?.songs.length && <EmptyState title="歌单还是空的" description="打开曲库中的歌曲卡，把喜欢的歌加入这里。" />}</Sheet>;
}

function ImportSheet({ open, onOpenChange, notify }: { open: boolean; onOpenChange(open: boolean): void; notify(message: string): void }) {
  const [content, setContent] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); try { await api('/api/imports', { method: 'POST', body: JSON.stringify({ format: 'text', content, collectionType: 'learning' }) }); setContent(''); onOpenChange(false); notify('已导入待学清单'); } catch (error) { notify(error instanceof Error ? error.message : '导入失败'); } finally { setBusy(false); } };
  return <Sheet open={open} onOpenChange={onOpenChange} title="批量粘贴收歌"><div className="sheet-stack"><p className="helper">每行一首，格式为“歌名 - 歌手”。默认进入待学清单。</p><textarea className="import-area" value={content} onChange={(event) => setContent(event.target.value)} placeholder={'晴天 - 周杰伦\n富士山下 - 陈奕迅'} /><Button disabled={busy || !content.trim()} onClick={submit}>开始导入</Button></div></Sheet>;
}
