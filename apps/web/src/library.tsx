import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { Archive, ChevronRight, Filter, ListChecks, ListPlus, Mic2, Pause, Pencil, Play, Plus, RotateCcw, Save, Search, Sparkles, Subtitles, Trash2, X } from 'lucide-react';
import type { CollectionType, Difficulty, LibraryFilters, LibraryScene, PersonalSongListItem, SearchSongsResponse, SongListItem, SongListScope } from '@picknext/shared';
import { api, ApiError } from './api.js';
import { BasicSongCard, Button, EmptyState, IconButton, PageHeader, Sheet, SongCard } from './components.js';

interface PlaylistSummary { id: number; name: string; songCount: number; access?: 'owner' | 'collaborator' }
interface KtvSong { id: number; title: string; artist: string; version: string | null }

const emptyFilters = (): LibraryFilters => ({ languages: [], genres: [], difficulties: [], scene: 'all' });
const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];
const sceneOptions: Record<string, Array<[LibraryScene, string]>> = {
  repertoire: [['all', '全部'], ['strong', '⭐ 拿手'], ['challenge', '🔥 想挑战'], ['recent', '🕐 近期唱过'], ['note', '📌 有备注'], ['new', '✨ 最近添加']],
  learning: [['all', '全部'], ['challenge', '🔥 想挑战'], ['note', '📌 有备注'], ['new', '✨ 最近添加']],
  global: [['all', '全部'], ['high', '⭐ 高分'], ['hard', '🔥 高难度'], ['new', '✨ 最近添加']]
};

export function LibraryPage({ notify, canEditGlobal, initialScope = 'personal' }: { notify(message: string): void; canEditGlobal: boolean; initialScope?: SongListScope }) {
  const client = useQueryClient();
  const [scope, setScope] = useState<SongListScope>(initialScope);
  const [collection, setCollection] = useState<CollectionType>('repertoire');
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [ktvOpen, setKtvOpen] = useState(false);
  const [ktvAddOpen, setKtvAddOpen] = useState(false);
  const [ktvSearch, setKtvSearch] = useState('');
  const [clearKtvConfirm, setClearKtvConfirm] = useState(false);
  const [detail, setDetail] = useState<SongListItem | null>(null);
  const [editSong, setEditSong] = useState<SongListItem | null>(null);
  const [lyricsSong, setLyricsSong] = useState<PersonalSongListItem | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersByView, setFiltersByView] = useState<Record<string, LibraryFilters>>({ repertoire: emptyFilters(), learning: emptyFilters(), global: emptyFilters() });
  const [jumpOffset, setJumpOffset] = useState(0);
  const [letterFeedback, setLetterFeedback] = useState<string | null>(null);
  const viewKey = scope === 'global' ? 'global' : collection;
  const filters = filtersByView[viewKey] ?? emptyFilters();
  const serializedFilters = JSON.stringify(filters);
  const list = useInfiniteQuery({
    queryKey: ['library-search', scope, collection, search, serializedFilters, jumpOffset],
    initialPageParam: jumpOffset,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ scope, q: search.trim(), limit: '30', offset: String(pageParam) });
      if (scope === 'personal') params.set('collection', collection);
      if (filters.languages.length) params.set('languages', filters.languages.join(','));
      if (filters.genres.length) params.set('genres', filters.genres.join(','));
      if (filters.difficulties.length) params.set('difficulties', filters.difficulties.join(','));
      if (filters.minRating) params.set('minRating', String(filters.minRating));
      params.set('scene', filters.scene);
      return api<SearchSongsResponse>(`/api/search?${params}`);
    },
    getNextPageParam: (lastPage, pages) => lastPage.hasMore
      ? jumpOffset + pages.reduce((total, page) => total + page.songs.length, 0)
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
  const resultMeta = list.data?.pages[0];

  const updateCollection = useMutation({
    mutationFn: ({ id, target }: { id: number; target: CollectionType }) => api(`/api/user-songs/${id}/collection`, { method: 'PUT', body: JSON.stringify({ collectionType: target }) }),
    onSuccess: async (_result, variables) => {
      await client.invalidateQueries({ queryKey: ['library-search'] });
      setDetail(null);
      notify(variables.target === 'repertoire' ? '已加入会唱曲库' : '已加入待学清单');
    }
  });
  const batchUpdate = useMutation({
    mutationFn: (body: { action: 'set_collection' | 'snooze' | 'unsnooze' | 'remove'; collectionType?: CollectionType; until?: string }) => api<{ updated: number }>('/api/user-songs/batch', {
      method: 'POST', body: JSON.stringify({ ...body, songIds: [...selectedIds] })
    }),
    onSuccess: async (_result, variables) => {
      setSelectedIds(new Set()); setSelectionMode(false); setBatchOpen(false);
      await client.invalidateQueries({ queryKey: ['library-search'] });
      const labels = { set_collection: variables.collectionType === 'repertoire' ? '已批量移入会唱曲库' : '已批量移入待学清单', snooze: '已批量冷藏 30 天', unsnooze: '已批量解除冷藏', remove: '已批量移出个人曲库' };
      notify(labels[variables.action]);
    },
    onError: (reason) => notify(reason instanceof Error ? reason.message : '批量操作未保存，请重试')
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
    onSuccess: async () => {
      client.setQueryData<{ playlist: { id: number; name: string } | null; songs: KtvSong[] }>(['next-ktv'], (current) => current ? { ...current, songs: [] } : current);
      setClearKtvConfirm(false);
      await client.invalidateQueries({ queryKey: ['next-ktv'] });
      notify('下一次 KTV 已清空');
    },
    onError: (reason) => notify(reason instanceof Error ? reason.message : '清空失败，请重试')
  });
  const addPlaylist = useMutation({
    mutationFn: ({ playlistId, songId }: { playlistId: number; songId: number }) => api(`/api/playlists/${playlistId}/songs/${songId}`, { method: 'PUT', body: '{}' }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['playlists'] }); notify('已加入歌单'); }
  });

  useEffect(() => { setJumpOffset(0); setSelectedIds(new Set()); setSelectionMode(false); }, [scope, collection, search, serializedFilters]);
  const goPersonal = (target: CollectionType) => { setCollection(target); setScope('personal'); setDetail(null); };
  const setScene = (scene: LibraryScene) => setFiltersByView((current) => ({ ...current, [viewKey]: { ...emptyFilters(), scene } }));
  const clearFilters = () => setFiltersByView((current) => ({ ...current, [viewKey]: emptyFilters() }));
  const toggleSelection = (songId: number) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(songId)) next.delete(songId); else next.add(songId);
    return next;
  });
  const leaveSelectionMode = () => { setSelectionMode(false); setSelectedIds(new Set()); };
  const jumpTo = (initial: string) => {
    const target = resultMeta?.alphabetIndex.find((item) => item.initial === initial);
    if (!target) return;
    setLetterFeedback(initial); window.setTimeout(() => setLetterFeedback(null), 500);
    const element = document.getElementById(`song-group-${initial}`);
    if (element) element.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    else setJumpOffset(target.offset);
  };
  const cardVariant = (song: SongListItem) => song.scope === 'global'
    ? 'global' as const
    : song.collectionType === 'repertoire' ? 'personal-repertoire' as const : 'personal-learning' as const;

  return <section className="page library-page"><PageHeader eyebrow="你的歌，随时想得起来" title="曲库" action={<div className="library-header-actions">{scope === 'personal' && <Button className="secondary compact" onClick={() => selectionMode ? leaveSelectionMode() : setSelectionMode(true)}><ListChecks size={17} />{selectionMode ? '取消批量' : '批量管理'}</Button>}<IconButton label="添加歌曲" onClick={() => setAddOpen(true)}><Plus /></IconButton></div>} />
    <button className="ktv-card" onClick={() => setKtvOpen(true)}><span className="ktv-icon"><Mic2 /></span><span className="ktv-copy"><strong>下一次 KTV</strong><small>{ktv.data?.songs.length ? `已经准备 ${ktv.data.songs.length} 首 · Pick 时优先` : '先攒几首想唱的歌，Pick 时优先'}</small></span><span className="ktv-count">{ktv.data?.songs.length ?? 0}</span><ChevronRight size={19} /></button>
    <div className="library-search-row"><div className="search-box"><Search size={19} /><input aria-label="搜索歌曲" placeholder="歌名、歌手、拼音或别名" value={search} onChange={(event) => setSearch(event.target.value)} /></div><IconButton label="筛选歌曲" onClick={() => setFiltersOpen(true)}><Filter />{activeFilterCount(filters) > 0 && <small className="filter-count">{activeFilterCount(filters)}</small>}</IconButton></div>
    <Tabs.Root value={scope} onValueChange={(value) => setScope(value as SongListScope)}><Tabs.List className="tabs scope-tabs" aria-label="曲库范围"><Tabs.Trigger value="personal">我的曲库 <small>{counts?.personal ?? 0}</small></Tabs.Trigger><Tabs.Trigger value="global">全部曲库 <small>{counts?.global ?? 0}</small></Tabs.Trigger></Tabs.List></Tabs.Root>
    {scope === 'personal' && <Tabs.Root value={collection} onValueChange={(value) => setCollection(value as CollectionType)}><Tabs.List className="tabs collection-tabs" aria-label="个人曲库分类"><Tabs.Trigger value="repertoire">会唱 <small>{counts?.repertoire ?? 0}</small></Tabs.Trigger><Tabs.Trigger value="learning">待学 <small>{counts?.learning ?? 0}</small></Tabs.Trigger></Tabs.List></Tabs.Root>}
    <div className="scene-chips" aria-label="快捷筛选">{(sceneOptions[viewKey] ?? []).map(([value, label]) => <button key={value} className={filters.scene === value ? 'active' : ''} onClick={() => setScene(value)}>{label}</button>)}{filters.scene === 'custom' && <button className="active">自定义</button>}</div>
    <p className="library-context">{scope === 'global' ? '全站共享歌曲，只展示公共资料和匿名评分' : collection === 'repertoire' ? '普通 Pick 只从这里选择歌曲' : '正在学习的歌曲不会进入普通 Pick'}</p>
    <div className="library-result-head"><span>{list.isLoading ? '正在查找…' : `找到 ${resultMeta?.total ?? 0} 首`}</span>{activeFilterCount(filters) > 0 && <button onClick={clearFilters}><RotateCcw size={14} />清除筛选</button>}</div>
    {selectionMode && selectedIds.size > 0 && <div className="batch-toolbar" role="region" aria-label="批量曲库操作"><span>已选 {selectedIds.size} 首</span><Button onClick={() => setBatchOpen(true)}>选择操作</Button><button className="text-action" onClick={() => setSelectedIds(new Set())}>清空选择</button></div>}
    <div className="library-list-wrap"><div className="song-list alphabet-song-list">{shown.map((song, index) => <div key={`${song.scope}-${song.id}`} className={`alphabet-song-group ${selectionMode && selectedIds.has(song.id) ? 'selection-selected' : ''}`}>{(index === 0 || shown[index - 1]?.titleInitial !== song.titleInitial) && <h3 id={`song-group-${song.titleInitial}`} className="alphabet-group-title">{song.titleInitial}</h3>}{selectionMode && song.scope === 'personal' && <label className="song-selection"><input type="checkbox" checked={selectedIds.has(song.id)} onChange={() => toggleSelection(song.id)} aria-label={`选择${song.title}`} /><span>选择</span></label>}<SongCard song={song} variant={cardVariant(song)} onClick={() => selectionMode && song.scope === 'personal' ? toggleSelection(song.id) : setDetail(song)} action={selectionMode && song.scope === 'personal' ? undefined : song.scope === 'personal' ? song.collectionType === 'repertoire'
      ? <IconButton label={`将${song.title}加入下一次 KTV`} onClick={() => addKtv.mutate(song.id)}><ListPlus size={19} /></IconButton>
      : <IconButton label={`将${song.title}转为会唱`} onClick={() => updateCollection.mutate({ id: song.id, target: 'repertoire' })}><Sparkles size={19} /></IconButton>
      : song.collectionType === null ? <button className="collect-button" onClick={() => setDetail(song)}>＋ 收录</button> : undefined} /></div>)}</div>{Boolean(resultMeta?.alphabetIndex.length) && <nav className="alphabet-rail" aria-label="按歌名首字母定位">{alphabet.map((letter) => <button key={letter} disabled={!resultMeta?.alphabetIndex.some((item) => item.initial === letter)} onPointerEnter={(event) => event.buttons === 1 && jumpTo(letter)} onClick={() => jumpTo(letter)} aria-label={`定位到 ${letter} 组`}>{letter}</button>)}</nav>}</div>
    {letterFeedback && <div className="letter-feedback" role="status">{letterFeedback}</div>}
    {!list.isLoading && !shown.length && <EmptyState
      title={search || activeFilterCount(filters) ? '没有符合条件的歌曲' : scope === 'global' ? '全部曲库还是空的' : collection === 'repertoire' ? '会唱曲库还是空的' : '待学清单还是空的'}
      description={search || activeFilterCount(filters) ? '搜索范围包含歌名、歌手、版本、拼音、别名、歌词和个人备注；可以修改关键词或清除筛选。' : scope === 'global' ? '添加第一首全站歌曲，收录后即可长期管理。' : collection === 'repertoire' ? '从全部曲库收录会唱的歌，Pick 才真正懂你。' : '把想学的歌先放在这里，不会进入普通 Pick。'}
      action={scope === 'personal' && collection === 'repertoire'
        ? search || activeFilterCount(filters) ? <Button onClick={() => { setSearch(''); clearFilters(); }}>清除查找条件</Button> : <><Button onClick={() => setScope('global')}>去全部曲库选歌</Button><Button className="secondary" onClick={() => setCollection('learning')}>查看待学清单</Button></>
        : <Button onClick={() => setAddOpen(true)}><Plus size={18} />添加歌曲</Button>}
    />}
    {list.hasNextPage && <Button className="secondary load-more" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage ? '正在加载' : '加载更多'}</Button>}
    <AddSongSheet open={addOpen} onOpenChange={setAddOpen} defaultCollection={collection} onAdded={async (message) => { setAddOpen(false); await client.invalidateQueries({ queryKey: ['library-search'] }); notify(message); }} />
    <BatchActionSheet open={batchOpen} count={selectedIds.size} onOpenChange={setBatchOpen} loading={batchUpdate.isPending} onAction={(body) => batchUpdate.mutate(body)} />
    <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)} title="歌曲操作">{detail && <div className="sheet-stack"><SongCard song={detail} variant={cardVariant(detail)} />{canEditGlobal && <Button className="secondary" onClick={() => { setEditSong(detail); setDetail(null); }}><Pencil size={18} />编辑全局歌曲信息</Button>}{detail.scope === 'global' ? detail.collectionType === null ? <>
      <Button onClick={() => updateCollection.mutate({ id: detail.id, target: 'repertoire' })}>我会唱，加入会唱曲库</Button>
      <Button className="secondary" onClick={() => updateCollection.mutate({ id: detail.id, target: 'learning' })}>还不会，加入待学清单</Button>
    </> : <Button onClick={() => goPersonal(detail.collectionType!)}>查看我的{detail.collectionType === 'repertoire' ? '会唱曲库' : '待学清单'}</Button> : <><PersonalSongSettings songId={detail.id} notify={notify} onSaved={async () => { await client.invalidateQueries({ queryKey: ['library-search'] }); }} />
      {detail.collectionType === 'repertoire' && <Button onClick={() => addKtv.mutate(detail.id)}><ListPlus size={18} />加入下一次 KTV</Button>}
      {Boolean(playlists.data?.playlists.length) && <div><p className="helper">加入普通歌单</p><div className="chips playlist-chips">{playlists.data!.playlists.map((playlist) => <button key={playlist.id} onClick={() => addPlaylist.mutate({ playlistId: playlist.id, songId: detail.id })}>{playlist.name}</button>)}</div></div>}
      <Button className="secondary" onClick={() => { setLyricsSong(detail); setDetail(null); }}><Subtitles size={18} />歌词跟唱</Button>
      <Button className="secondary" onClick={() => updateCollection.mutate({ id: detail.id, target: detail.collectionType === 'repertoire' ? 'learning' : 'repertoire' })}><Sparkles size={18} />移至{detail.collectionType === 'repertoire' ? '待学清单' : '会唱曲库'}</Button>
    </>}</div>}</Sheet>
    <Sheet open={ktvOpen} onOpenChange={(open) => { setKtvOpen(open); if (!open) setClearKtvConfirm(false); }} title="下一次 KTV"><div className="sheet-stack"><p className="helper">这里的歌曲会成为 Pick 的第一候选池，唱完后自动移出。</p><div className="ktv-sheet-actions"><Button onClick={() => setKtvAddOpen(true)}><Plus size={18} />添加歌曲</Button>{Boolean(ktv.data?.songs.length) && <Button className="secondary danger-button" onClick={() => setClearKtvConfirm(true)}>清空歌单</Button>}</div>{clearKtvConfirm && <div className="inline-confirm"><span>确定移除歌单内全部歌曲？</span><button type="button" onClick={() => setClearKtvConfirm(false)}>取消</button><button type="button" className="danger-text" disabled={clearKtv.isPending} onClick={() => clearKtv.mutate()}>{clearKtv.isPending ? '正在清空' : '确认清空'}</button></div>}<div className="song-list">{ktv.data?.songs.map((song) => <BasicSongCard key={song.id} song={song} action={<IconButton label={`从下一次 KTV 移除${song.title}`} disabled={removeKtv.isPending} onClick={() => removeKtv.mutate(song.id)}><X size={18} /></IconButton>} />)}</div>{!ktv.isLoading && !ktv.data?.songs.length && <EmptyState title="还没有准备歌曲" description="从会唱曲库挑选几首下次一定想唱的歌。" action={<Button onClick={() => setKtvAddOpen(true)}><Plus size={18} />添加歌曲</Button>} />}</div></Sheet>
    <Sheet open={ktvAddOpen} onOpenChange={setKtvAddOpen} title="添加到下一次 KTV"><div className="sheet-stack"><div className="search-box"><Search size={18} /><input aria-label="搜索会唱歌曲" value={ktvSearch} onChange={(event) => setKtvSearch(event.target.value)} placeholder="搜索会唱曲库" /></div><div className="song-list">{ktvCandidates.data?.songs.filter((song): song is PersonalSongListItem => song.scope === 'personal' && !ktv.data?.songs.some((item) => item.id === song.id)).map((song) => <SongCard key={song.id} song={song} variant="personal-repertoire" action={<IconButton label={`添加${song.title}到下一次 KTV`} disabled={addKtv.isPending} onClick={() => addKtv.mutate(song.id)}><Plus size={18} /></IconButton>} />)}</div>{!ktvCandidates.isLoading && !ktvCandidates.data?.songs.filter((song) => !ktv.data?.songs.some((item) => item.id === song.id)).length && <EmptyState title="没有可添加的歌曲" description="会唱曲库中的歌曲都已加入，或还没有符合搜索的歌曲。" />}</div></Sheet>
    <LyricsSheet song={lyricsSong} onClose={() => setLyricsSong(null)} notify={notify} />
    <EditSongSheet song={editSong} onClose={() => setEditSong(null)} notify={notify} onSaved={async () => {
      setEditSong(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['library-search'] }),
        client.invalidateQueries({ queryKey: ['song-detail'] }),
        client.invalidateQueries({ queryKey: ['next-ktv'] })
      ]);
    }} />
    <LibraryFilterSheet open={filtersOpen} onOpenChange={setFiltersOpen} value={filters} facets={resultMeta?.facets ?? { languages: [], genres: [] }} scope={scope} onApply={(value) => setFiltersByView((current) => ({ ...current, [viewKey]: value }))} />
  </section>;
}

function activeFilterCount(filters: LibraryFilters) {
  return filters.languages.length + filters.genres.length + filters.difficulties.length + (filters.minRating ? 1 : 0) + (filters.scene !== 'all' ? 1 : 0);
}

function BatchActionSheet({ open, count, loading, onOpenChange, onAction }: {
  open: boolean;
  count: number;
  loading: boolean;
  onOpenChange(open: boolean): void;
  onAction(body: { action: 'set_collection' | 'snooze' | 'unsnooze' | 'remove'; collectionType?: CollectionType; until?: string }): void;
}) {
  const [removeConfirm, setRemoveConfirm] = useState(false);
  useEffect(() => { if (!open) setRemoveConfirm(false); }, [open]);
  const snoozeUntil = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
  return <Sheet open={open} onOpenChange={onOpenChange} title={`批量管理 ${count} 首歌曲`}><div className="sheet-stack">
    <p className="helper">所有操作会一次性保存；如果有歌曲不属于当前曲库，整批都会取消。</p>
    <Button loading={loading} onClick={() => onAction({ action: 'set_collection', collectionType: 'repertoire' })}><Sparkles size={18} />移入会唱曲库</Button>
    <Button className="secondary" loading={loading} onClick={() => onAction({ action: 'set_collection', collectionType: 'learning' })}><Archive size={18} />移入待学清单</Button>
    <Button className="secondary" loading={loading} onClick={() => onAction({ action: 'snooze', until: snoozeUntil() })}><Archive size={18} />冷藏 30 天</Button>
    <Button className="secondary" loading={loading} onClick={() => onAction({ action: 'unsnooze' })}>解除冷藏</Button>
    {removeConfirm ? <div className="inline-confirm"><span>确认将这 {count} 首歌移出个人曲库？全局歌曲会保留。</span><button type="button" onClick={() => setRemoveConfirm(false)}>取消</button><button type="button" className="danger-text" onClick={() => onAction({ action: 'remove' })}>确认移出</button></div> : <Button className="secondary danger-button" onClick={() => setRemoveConfirm(true)}><Trash2 size={18} />移出个人曲库</Button>}
  </div></Sheet>;
}

function LibraryFilterSheet({ open, onOpenChange, value, facets, scope, onApply }: { open: boolean; onOpenChange(open: boolean): void; value: LibraryFilters; facets: { languages: string[]; genres: string[] }; scope: SongListScope; onApply(value: LibraryFilters): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  const toggle = <T extends string>(key: 'languages' | 'genres' | 'difficulties', item: T) => setDraft((current) => {
    const values = current[key] as string[];
    return { ...current, scene: 'custom', [key]: values.includes(item) ? values.filter((value) => value !== item) : [...values, item] };
  });
  const toggleRating = (value: string) => setDraft((current) => { const next: LibraryFilters = { ...current, scene: 'custom' }; if (current.minRating === Number(value)) delete next.minRating; else next.minRating = Number(value); return next; });
  return <Sheet open={open} onOpenChange={onOpenChange} title="筛选歌曲"><div className="filter-sheet"><FilterGroup title="语种" values={facets.languages} selected={draft.languages} onToggle={(value) => toggle('languages', value)} /><FilterGroup title="曲风" values={facets.genres} selected={draft.genres} onToggle={(value) => toggle('genres', value)} /><FilterGroup title={scope === 'personal' ? '我的难度' : '参考难度'} values={['easy', 'medium', 'hard']} labels={['简单', '中等', '困难']} selected={draft.difficulties} onToggle={(value) => toggle('difficulties', value as Difficulty)} /><FilterGroup title={scope === 'personal' ? '我的星级' : '匿名聚合星级'} values={['3', '4', '5']} labels={['★3 以上', '★4 以上', '★5']} selected={draft.minRating ? [String(draft.minRating)] : []} onToggle={toggleRating} /><div className="filter-actions"><Button className="secondary" onClick={() => setDraft(emptyFilters())}>重置</Button><Button onClick={() => { onApply(draft); onOpenChange(false); }}>应用</Button></div></div></Sheet>;
}

function FilterGroup({ title, values, labels, selected, onToggle }: { title: string; values: string[]; labels?: string[]; selected: string[]; onToggle(value: string): void }) {
  if (!values.length) return null;
  return <fieldset className="filter-group"><legend>{title}</legend><div className="chips">{values.map((value, index) => <button type="button" className={selected.includes(value) ? 'selected' : ''} key={value} onClick={() => onToggle(value)}>{labels?.[index] ?? value}</button>)}</div></fieldset>;
}

interface SongDetail {
  id: number; title: string; artist: string; version: string | null; language: string | null;
  genre: string | null; difficulty: 'easy' | 'medium' | 'hard' | null;
  performanceType: 'solo' | 'duet' | 'chorus'; lyrics: string | null; lyricsTranslit: string | null;
  aliases: string[];
  collectionType: CollectionType | null; rating: number | null; personalDifficulty: Difficulty | null;
  keyShift: number | null; note: string | null; memoryCue: string | null;
}

function PersonalSongSettings({ songId, notify, onSaved }: { songId: number; notify(message: string): void; onSaved(): Promise<void> }) {
  const detail = useQuery({ queryKey: ['song-detail', songId], queryFn: () => api<SongDetail>(`/api/songs/${songId}`) });
  const [rating, setRating] = useState<number | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [keyShift, setKeyShift] = useState<number | null>(null);
  const [note, setNote] = useState(''); const [memoryCue, setMemoryCue] = useState('');
  useEffect(() => { if (detail.data) { setRating(detail.data.rating); setDifficulty(detail.data.personalDifficulty); setKeyShift(detail.data.keyShift); setNote(detail.data.note ?? ''); setMemoryCue(detail.data.memoryCue ?? ''); } }, [detail.data]);
  const save = useMutation({
    mutationFn: () => api(`/api/user-songs/${songId}/meta`, { method: 'PATCH', body: JSON.stringify({ rating, personalDifficulty: difficulty, keyShift, note: note || null, memoryCue: memoryCue || null }) }),
    onSuccess: async () => { await Promise.all([detail.refetch(), onSaved()]); notify('个人歌曲设置已保存'); },
    onError: (reason) => notify(reason instanceof Error ? reason.message : '个人设置保存失败')
  });
  if (!detail.data) return <p className="helper">正在读取个人歌曲设置……</p>;
  return <section className="personal-song-settings"><h3>我的歌曲设置</h3><div className="settings-row"><span>长期演唱把握</span><div className="rating personal-rating">{[1,2,3,4,5].map((value) => <button key={value} className={rating !== null && value <= rating ? 'active' : ''} onClick={() => setRating(rating === value ? null : value)}>★</button>)}</div></div><div className="settings-row column"><span>我的难度</span><div className="chips">{([['easy','简单'],['medium','中等'],['hard','困难'],['','使用参考难度']] as const).map(([value,label]) => <button key={value || 'auto'} className={(difficulty ?? '') === value ? 'selected' : ''} onClick={() => setDifficulty(value ? value as Difficulty : null)}>{label}</button>)}</div></div><div className="form-grid"><label>个人升降调<select value={keyShift === null ? '' : keyShift} onChange={(event) => setKeyShift(event.target.value === '' ? null : Number(event.target.value))}><option value="">未设置</option>{Array.from({ length: 25 }, (_, index) => index - 12).map((value) => <option key={value} value={value}>{value === 0 ? '原调' : `${value > 0 ? '+' : ''}${value} Key`}</option>)}</select></label><label>记忆词<input value={memoryCue} onChange={(event) => setMemoryCue(event.target.value)} placeholder="一句话想起这首歌" /></label></div><label>我的备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="副歌高音、进歌提示……" /></label><Button loading={save.isPending} onClick={() => save.mutate()}><Save size={18} />保存个人设置</Button></section>;
}

/** 编辑表单只修改全局公共字段，避免误把当前用户的评分和难度写给所有用户。 */
function EditSongSheet({ song, onClose, onSaved, notify }: { song: SongListItem | null; onClose(): void; onSaved(): Promise<void>; notify(message: string): void }) {
  const detail = useQuery({ queryKey: ['song-detail', song?.id], queryFn: () => api<SongDetail>(`/api/songs/${song!.id}`), enabled: Boolean(song) });
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!song) return;
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/songs/${song.id}`, { method: 'PUT', body: JSON.stringify({
        title: data.get('title'), artist: data.get('artist'), version: data.get('version') || null,
        language: data.get('language') || null, genre: data.get('genre') || null,
        difficulty: data.get('difficulty') || null, performanceType: data.get('performanceType'),
        lyrics: data.get('lyrics') || null, lyricsTranslit: data.get('lyricsTranslit') || null,
        aliases: String(data.get('aliases') ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      }) });
      await onSaved();
      notify('全局歌曲信息已更新');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '歌曲信息保存失败'); }
    finally { setBusy(false); }
  };
  const value = detail.data;
  return <Sheet open={song !== null} onOpenChange={(open) => !open && onClose()} title="编辑全局歌曲">{value
    ? <form key={`${value.id}-${value.title}`} className="form-stack" onSubmit={submit}><label>歌名<input name="title" required defaultValue={value.title} /></label><label>歌手<input name="artist" required defaultValue={value.artist} /></label><div className="form-grid"><label>版本<input name="version" defaultValue={value.version ?? ''} /></label><label>语种<input name="language" defaultValue={value.language ?? ''} /></label></div><div className="form-grid"><label>曲风<input name="genre" defaultValue={value.genre ?? ''} /></label><label>参考难度<select name="difficulty" defaultValue={value.difficulty ?? ''}><option value="">未设置</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div><label>演唱类型<select name="performanceType" defaultValue={value.performanceType}><option value="solo">独唱</option><option value="duet">对唱</option><option value="chorus">合唱</option></select></label><label>别名（每行一个，最多 20 个）<textarea name="aliases" defaultValue={value.aliases.join('\n')} placeholder="粤语版\n现场版" /></label><label>LRC / 歌词<textarea className="global-lyrics-editor" name="lyrics" defaultValue={value.lyrics ?? ''} placeholder="[00:12.00]第一句歌词" /></label><label>音译歌词<textarea name="lyricsTranslit" defaultValue={value.lyricsTranslit ?? ''} /></label><Button disabled={busy} type="submit"><Save size={18} />保存全局信息</Button></form>
    : <p className="helper">正在读取歌曲信息……</p>}</Sheet>;
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

interface DuplicateMatch { id: number; title: string; artist: string; version: string | null }

function AddSongSheet({ open, onOpenChange, defaultCollection, onAdded }: { open: boolean; onOpenChange(open: boolean): void; defaultCollection: 'repertoire' | 'learning'; onAdded(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ code: string; matches: DuplicateMatch[] } | null>(null);
  const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const send = async (payload: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      const result = await api<{ status: 'created' | 'reused' | 'pending_review' }>('/api/songs', { method: 'POST', body: JSON.stringify(payload) });
      formRef.current?.reset(); setDuplicate(null); setPendingPayload(null);
      const collectionType = payload.collectionType as CollectionType | null;
      onAdded(result.status === 'pending_review'
        ? '已提交审核，管理员确认后会按本次选择处理'
        : collectionType
          ? result.status === 'reused' ? '已复用歌曲并收录到个人曲库' : '歌曲已加入全部曲库并收录到个人曲库'
          : result.status === 'reused' ? '已复用全部曲库歌曲，未收录到个人曲库' : '歌曲已加入全部曲库，未收录到个人曲库');
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === 'EXACT_DUPLICATE' || reason.code === 'SIMILAR_SONGS_FOUND')) {
        setPendingPayload(payload); setDuplicate({ code: reason.code, matches: (reason.data.matches as DuplicateMatch[] | undefined) ?? [] });
      } else setError(reason instanceof Error ? reason.message : '添加失败');
    } finally { setBusy(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const collectionType = (data.get('collectionType') || null) as CollectionType | null;
    await send({
      title: data.get('title'), artist: data.get('artist'), version: data.get('version') || undefined,
      language: data.get('language') || undefined, genre: data.get('genre') || undefined,
      difficulty: data.get('difficulty') || undefined, collectionType,
      performanceType: data.get('performanceType'),
      aliases: String(data.get('aliases') ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      personalDifficulty: collectionType ? data.get('personalDifficulty') || null : null,
      note: collectionType ? data.get('note') || undefined : undefined
    });
  };
  const resolve = (action: 'reuse' | 'submit_review' | 'create_anyway', matchedSongId?: number) => pendingPayload && send({ ...pendingPayload, duplicateAction: action, matchedSongId });
  return <Sheet open={open} onOpenChange={(value) => { onOpenChange(value); if (!value) { setDuplicate(null); setError(''); } }} title="收一首歌">
    <form ref={formRef} className="form-stack" onSubmit={submit}>
      <label>歌名<input name="title" required maxLength={120} autoFocus /></label>
      <label>歌手<input name="artist" required maxLength={120} /></label>
      <div className="form-grid"><label>版本<input name="version" placeholder="Live / 女声版" /></label><label>语种<input name="language" placeholder="国语" /></label></div>
      <div className="form-grid"><label>曲风<input name="genre" placeholder="流行" /></label><label>演唱类型<select name="performanceType"><option value="solo">独唱</option><option value="duet">对唱</option><option value="chorus">合唱</option></select></label></div>
      <div className="form-grid"><label>参考难度<select name="difficulty"><option value="">未设置</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label><label>我的难度<select name="personalDifficulty"><option value="">使用参考难度</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div>
      <label>别名（每行一个）<textarea name="aliases" placeholder="粤语版\n现场版" /></label>
      <label>个人归属<select name="collectionType" defaultValue={defaultCollection}><option value="learning">待学清单</option><option value="repertoire">会唱曲库</option><option value="">仅维护全局资料，不收录到我的个人曲库</option></select></label>
      <label>我的备注<textarea name="note" placeholder="副歌高音、进歌提示……" /></label>
      <p className="helper">不收录时歌曲仍会进入全部曲库，但不会影响你的个人曲库和 Pick。</p>
      {error && <p className="form-error">{error}</p>}
      <Button loading={busy} type="submit">收进曲库</Button>
    </form>
    {duplicate && <div className="duplicate-panel"><h3>{duplicate.code === 'EXACT_DUPLICATE' ? '曲库中已有这首歌' : '发现相似歌曲'}</h3><p>{duplicate.code === 'EXACT_DUPLICATE' ? '直接复用可避免重复数据；继续新增需管理员审核。' : '请先确认是否可以复用已有歌曲。'}</p>{duplicate.matches.map((song) => <BasicSongCard key={song.id} song={song} action={<Button className="secondary compact" loading={busy} onClick={() => resolve('reuse', song.id)}>复用</Button>} />)}<div className="duplicate-actions">{duplicate.code === 'EXACT_DUPLICATE' ? <Button className="secondary" loading={busy} onClick={() => resolve('submit_review', duplicate.matches[0]?.id)}>提交审核</Button> : <Button className="secondary" loading={busy} onClick={() => resolve('create_anyway')}>仍然新增</Button>}</div></div>}
  </Sheet>;
}
