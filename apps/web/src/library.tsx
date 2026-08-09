import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { ChevronRight, ListPlus, Mic2, Pause, Play, Plus, Save, Search, Sparkles, Subtitles, X } from 'lucide-react';
import type { CollectionType, PersonalSongListItem, SearchSongsResponse, SongListItem, SongListScope } from '@picknext/shared';
import { api } from './api.js';
import { BasicSongCard, Button, EmptyState, IconButton, PageHeader, Sheet, SongCard } from './components.js';

interface PlaylistSummary { id: number; name: string; songCount: number }
interface KtvSong { id: number; title: string; artist: string; version: string | null }

export function LibraryPage({ notify }: { notify(message: string): void }) {
  const client = useQueryClient();
  const [scope, setScope] = useState<SongListScope>('personal');
  const [collection, setCollection] = useState<CollectionType>('repertoire');
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [ktvOpen, setKtvOpen] = useState(false);
  const [ktvAddOpen, setKtvAddOpen] = useState(false);
  const [ktvSearch, setKtvSearch] = useState('');
  const [clearKtvConfirm, setClearKtvConfirm] = useState(false);
  const [detail, setDetail] = useState<SongListItem | null>(null);
  const [lyricsSong, setLyricsSong] = useState<PersonalSongListItem | null>(null);
  const list = useInfiniteQuery({
    queryKey: ['library-search', scope, collection, search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope, q: search.trim(), limit: '30', offset: String(pageParam) });
      if (scope === 'personal') params.set('collection', collection);
      return api<SearchSongsResponse>(`/api/search?${params}`);
    },
    getNextPageParam: (lastPage, pages) => lastPage.hasMore
      ? pages.reduce((total, page) => total + page.songs.length, 0)
      : undefined
  });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: PlaylistSummary[] }>('/api/playlists') });
  const ktv = useQuery({ queryKey: ['next-ktv'], queryFn: () => api<{ playlist: { id: number; name: string } | null; songs: KtvSong[] }>('/api/playlists/next-ktv') });
  const ktvCandidates = useQuery({
    queryKey: ['ktv-candidates', ktvSearch],
    enabled: ktvAddOpen,
    queryFn: () => api<SearchSongsResponse>(`/api/search?scope=personal&collection=repertoire&limit=100&q=${encodeURIComponent(ktvSearch.trim())}`)
  });
  const shown = list.data?.pages.flatMap((page) => page.songs) ?? [];
  const counts = list.data?.pages[0]?.counts;

  const updateCollection = useMutation({
    mutationFn: ({ id, target }: { id: number; target: CollectionType }) => api(`/api/user-songs/${id}/collection`, { method: 'PUT', body: JSON.stringify({ collectionType: target }) }),
    onSuccess: async (_result, variables) => {
      await client.invalidateQueries({ queryKey: ['library-search'] });
      setDetail(null);
      notify(variables.target === 'repertoire' ? '已加入会唱曲库' : '已加入待学清单');
    }
  });
  const addKtv = useMutation({
    mutationFn: (id: number) => api(`/api/playlists/next-ktv/${id}`, { method: 'PUT', body: '{}' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['next-ktv'] }); notify('已加入下一次 KTV'); }
  });
  const removeKtv = useMutation({
    mutationFn: (id: number) => api(`/api/playlists/next-ktv/${id}`, { method: 'DELETE' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['next-ktv'] }); notify('已从下一次 KTV 移除'); }
  });
  const clearKtv = useMutation({
    mutationFn: () => api('/api/playlists/next-ktv', { method: 'DELETE' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['next-ktv'] }); setClearKtvConfirm(false); notify('下一次 KTV 已清空'); }
  });
  const addPlaylist = useMutation({
    mutationFn: ({ playlistId, songId }: { playlistId: number; songId: number }) => api(`/api/playlists/${playlistId}/songs/${songId}`, { method: 'PUT', body: '{}' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['playlists'] }); notify('已加入歌单'); }
  });

  const goPersonal = (target: CollectionType) => { setCollection(target); setScope('personal'); setDetail(null); };
  const cardVariant = (song: SongListItem) => song.scope === 'global'
    ? 'global' as const
    : song.collectionType === 'repertoire' ? 'personal-repertoire' as const : 'personal-learning' as const;

  return <section className="page library-page"><PageHeader eyebrow="你的歌，随时想得起来" title="曲库" action={<IconButton label="添加歌曲" onClick={() => setAddOpen(true)}><Plus /></IconButton>} />
    <button className="ktv-card" onClick={() => setKtvOpen(true)}><span className="ktv-icon"><Mic2 /></span><span className="ktv-copy"><strong>下一次 KTV</strong><small>{ktv.data?.songs.length ? `已经准备 ${ktv.data.songs.length} 首 · Pick 时优先` : '先攒几首想唱的歌，Pick 时优先'}</small></span><span className="ktv-count">{ktv.data?.songs.length ?? 0}</span><ChevronRight size={19} /></button>
    <div className="search-box"><Search size={19} /><input aria-label="搜索歌曲" placeholder="歌名、歌手、歌词、备注或记忆词" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
    <Tabs.Root value={scope} onValueChange={(value) => setScope(value as SongListScope)}><Tabs.List className="tabs scope-tabs" aria-label="曲库范围"><Tabs.Trigger value="personal">我的曲库 <small>{counts?.personal ?? 0}</small></Tabs.Trigger><Tabs.Trigger value="global">全部曲库 <small>{counts?.global ?? 0}</small></Tabs.Trigger></Tabs.List></Tabs.Root>
    {scope === 'personal' && <Tabs.Root value={collection} onValueChange={(value) => setCollection(value as CollectionType)}><Tabs.List className="tabs collection-tabs" aria-label="个人曲库分类"><Tabs.Trigger value="repertoire">会唱 <small>{counts?.repertoire ?? 0}</small></Tabs.Trigger><Tabs.Trigger value="learning">待学 <small>{counts?.learning ?? 0}</small></Tabs.Trigger></Tabs.List></Tabs.Root>}
    <p className="library-context">{scope === 'global' ? '全站共享歌曲，只展示公共资料和匿名评分' : collection === 'repertoire' ? '普通 Pick 只从这里选择歌曲' : '正在学习的歌曲不会进入普通 Pick'}</p>
    <div className="song-list">{shown.map((song) => <SongCard key={`${song.scope}-${song.id}`} song={song} variant={cardVariant(song)} onClick={() => setDetail(song)} action={song.scope === 'personal' ? song.collectionType === 'repertoire'
      ? <IconButton label={`将${song.title}加入下一次 KTV`} onClick={() => addKtv.mutate(song.id)}><ListPlus size={19} /></IconButton>
      : <IconButton label={`将${song.title}转为会唱`} onClick={() => updateCollection.mutate({ id: song.id, target: 'repertoire' })}><Sparkles size={19} /></IconButton>
      : song.collectionType === null ? <button className="collect-button" onClick={() => setDetail(song)}>＋ 收录</button> : undefined} />)}</div>
    {!list.isLoading && !shown.length && <EmptyState
      title={search ? '没有找到这首歌' : scope === 'global' ? '全部曲库还是空的' : collection === 'repertoire' ? '会唱曲库还是空的' : '待学清单还是空的'}
      description={search ? '可以换个记忆词，或直接添加新歌。' : scope === 'global' ? '添加第一首全站歌曲，收录后即可长期管理。' : collection === 'repertoire' ? '从全部曲库收录会唱的歌，Pick 才真正懂你。' : '把想学的歌先放在这里，不会进入普通 Pick。'}
      action={scope === 'personal' && collection === 'repertoire'
        ? <Button onClick={() => setScope('global')}>去全部曲库看看</Button>
        : <Button onClick={() => setAddOpen(true)}><Plus size={18} />添加歌曲</Button>}
    />}
    {list.hasNextPage && <Button className="secondary load-more" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage ? '正在加载' : '加载更多'}</Button>}
    <AddSongSheet open={addOpen} onOpenChange={setAddOpen} defaultCollection={collection} onAdded={async () => { setAddOpen(false); await client.invalidateQueries({ queryKey: ['library-search'] }); notify('歌曲已收进曲库'); }} />
    <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)} title="歌曲操作">{detail && <div className="sheet-stack"><SongCard song={detail} variant={cardVariant(detail)} />{detail.scope === 'global' ? detail.collectionType === null ? <>
      <Button onClick={() => updateCollection.mutate({ id: detail.id, target: 'repertoire' })}>加入会唱曲库</Button>
      <Button className="secondary" onClick={() => updateCollection.mutate({ id: detail.id, target: 'learning' })}>加入待学清单</Button>
    </> : <Button onClick={() => goPersonal(detail.collectionType!)}>查看我的{detail.collectionType === 'repertoire' ? '会唱曲库' : '待学清单'}</Button> : <>
      {detail.collectionType === 'repertoire' && <Button onClick={() => addKtv.mutate(detail.id)}><ListPlus size={18} />加入下一次 KTV</Button>}
      {Boolean(playlists.data?.playlists.length) && <div><p className="helper">加入普通歌单</p><div className="chips playlist-chips">{playlists.data!.playlists.map((playlist) => <button key={playlist.id} onClick={() => addPlaylist.mutate({ playlistId: playlist.id, songId: detail.id })}>{playlist.name}</button>)}</div></div>}
      <Button className="secondary" onClick={() => { setLyricsSong(detail); setDetail(null); }}><Subtitles size={18} />歌词跟唱</Button>
      <Button className="secondary" onClick={() => updateCollection.mutate({ id: detail.id, target: detail.collectionType === 'repertoire' ? 'learning' : 'repertoire' })}><Sparkles size={18} />移至{detail.collectionType === 'repertoire' ? '待学清单' : '会唱曲库'}</Button>
    </>}</div>}</Sheet>
    <Sheet open={ktvOpen} onOpenChange={(open) => { setKtvOpen(open); if (!open) setClearKtvConfirm(false); }} title="下一次 KTV"><div className="sheet-stack"><p className="helper">这里的歌曲会成为 Pick 的第一候选池，唱完后自动移出。</p><div className="ktv-sheet-actions"><Button onClick={() => setKtvAddOpen(true)}><Plus size={18} />添加歌曲</Button>{Boolean(ktv.data?.songs.length) && <Button className="secondary danger-button" onClick={() => setClearKtvConfirm(true)}>清空歌单</Button>}</div>{clearKtvConfirm && <div className="inline-confirm"><span>确定移除歌单内全部歌曲？</span><button onClick={() => setClearKtvConfirm(false)}>取消</button><button className="danger-text" disabled={clearKtv.isPending} onClick={() => clearKtv.mutate()}>确认清空</button></div>}<div className="song-list">{ktv.data?.songs.map((song) => <BasicSongCard key={song.id} song={song} action={<IconButton label={`从下一次 KTV 移除${song.title}`} disabled={removeKtv.isPending} onClick={() => removeKtv.mutate(song.id)}><X size={18} /></IconButton>} />)}</div>{!ktv.isLoading && !ktv.data?.songs.length && <EmptyState title="还没有准备歌曲" description="从会唱曲库挑选几首下次一定想唱的歌。" action={<Button onClick={() => setKtvAddOpen(true)}><Plus size={18} />添加歌曲</Button>} />}</div></Sheet>
    <Sheet open={ktvAddOpen} onOpenChange={setKtvAddOpen} title="添加到下一次 KTV"><div className="sheet-stack"><div className="search-box"><Search size={18} /><input aria-label="搜索会唱歌曲" value={ktvSearch} onChange={(event) => setKtvSearch(event.target.value)} placeholder="搜索会唱曲库" /></div><div className="song-list">{ktvCandidates.data?.songs.filter((song): song is PersonalSongListItem => song.scope === 'personal' && !ktv.data?.songs.some((item) => item.id === song.id)).map((song) => <SongCard key={song.id} song={song} variant="personal-repertoire" action={<IconButton label={`添加${song.title}到下一次 KTV`} disabled={addKtv.isPending} onClick={() => addKtv.mutate(song.id)}><Plus size={18} /></IconButton>} />)}</div>{!ktvCandidates.isLoading && !ktvCandidates.data?.songs.filter((song) => !ktv.data?.songs.some((item) => item.id === song.id)).length && <EmptyState title="没有可添加的歌曲" description="会唱曲库中的歌曲都已加入，或还没有符合搜索的歌曲。" />}</div></Sheet>
    <LyricsSheet song={lyricsSong} onClose={() => setLyricsSong(null)} notify={notify} />
  </section>;
}

interface LrcLine { time: number; text: string }

function LyricsSheet({ song, onClose, notify }: { song: PersonalSongListItem | null; onClose(): void; notify(message: string): void }) {
  const detail = useQuery({ queryKey: ['song-detail', song?.id], queryFn: () => api<any>(`/api/songs/${song!.id}`), enabled: Boolean(song) });
  const [lyrics, setLyrics] = useState('');
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [offset, setOffset] = useState(0);
  const startedAt = useRef(0);
  const wakeLock = useRef<any>(null);
  useEffect(() => { if (detail.data) setLyrics(detail.data.lyrics ?? ''); }, [detail.data]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [playing]);
  const lines = useMemo(() => parseLrc(lyrics), [lyrics]);
  const active = lines.findLastIndex((line) => line.time <= elapsed + offset);
  const toggle = async () => {
    if (playing) { setPlaying(false); await wakeLock.current?.release?.(); wakeLock.current = null; return; }
    startedAt.current = Date.now() - elapsed * 1000; setPlaying(true);
    try { wakeLock.current = await (navigator as any).wakeLock?.request('screen'); } catch { notify('浏览器未允许屏幕常亮，跟唱计时仍会继续。'); }
  };
  const seek = (time: number) => { setElapsed(Math.max(0, time - offset)); startedAt.current = Date.now() - Math.max(0, time - offset) * 1000; };
  const save = async () => { if (!song) return; await api(`/api/songs/${song.id}/lyrics`, { method: 'PUT', body: JSON.stringify({ lyrics }) }); setEditing(false); notify('歌词已保存'); };
  return <Sheet open={song !== null} onOpenChange={(open) => !open && onClose()} title={song ? `${song.title} · 跟唱` : '歌词跟唱'}><div className="lyrics-toolbar"><Button className="secondary" onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? '暂停' : '开始'}</Button><button onClick={() => setOffset((value) => value - .5)}>−0.5s</button><span>{offset > 0 ? '+' : ''}{offset.toFixed(1)}s</span><button onClick={() => setOffset((value) => value + .5)}>+0.5s</button></div>{editing ? <div className="sheet-stack"><textarea className="lyrics-editor" value={lyrics} onChange={(event) => setLyrics(event.target.value)} placeholder="[00:12.00]第一句歌词" /><Button onClick={save}><Save size={18} />保存歌词</Button></div> : lines.length ? <div className="lyrics-lines">{lines.map((line, index) => <button className={index === active ? 'active' : ''} key={`${line.time}-${index}`} onClick={() => seek(line.time)}>{line.text || '♪'}</button>)}</div> : <EmptyState title="还没有同步歌词" description="粘贴 LRC 后即可手动计时跟唱。" action={<Button onClick={() => setEditing(true)}>编辑 LRC</Button>} />}{!editing && lines.length > 0 && <button className="text-action" onClick={() => setEditing(true)}>编辑 LRC</button>}</Sheet>;
}

function parseLrc(input: string): LrcLine[] {
  const result: LrcLine[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+\]/g, '').trim();
    for (const match of matches) result.push({ time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`), text });
  }
  return result.sort((a, b) => a.time - b.time);
}

function AddSongSheet({ open, onOpenChange, defaultCollection, onAdded }: { open: boolean; onOpenChange(open: boolean): void; defaultCollection: 'repertoire' | 'learning'; onAdded(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api('/api/songs', { method: 'POST', body: JSON.stringify({
        title: data.get('title'), artist: data.get('artist'), version: data.get('version') || undefined,
        language: data.get('language') || undefined, genre: data.get('genre') || undefined,
        collectionType: data.get('collectionType'), performanceType: data.get('performanceType')
      }) });
      form.reset(); onAdded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '添加失败'); }
    finally { setBusy(false); }
  };
  return <Sheet open={open} onOpenChange={onOpenChange} title="收一首歌"><form className="form-stack" onSubmit={submit}><label>歌名<input name="title" required maxLength={120} autoFocus /></label><label>歌手<input name="artist" required maxLength={120} /></label><div className="form-grid"><label>版本<input name="version" placeholder="Live / 女声版" /></label><label>语种<input name="language" placeholder="国语" /></label></div><div className="form-grid"><label>曲风<input name="genre" placeholder="流行" /></label><label>演唱类型<select name="performanceType"><option value="solo">独唱</option><option value="duet">对唱</option><option value="chorus">合唱</option></select></label></div><label>先放到<select name="collectionType" defaultValue={defaultCollection}><option value="learning">待学清单</option><option value="repertoire">会唱曲库</option></select></label>{error && <p className="form-error">{error}</p>}<Button disabled={busy} type="submit">收进曲库</Button></form></Sheet>;
}
