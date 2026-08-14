import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, Filter, Mic2, MoonStar, Pause, Play, SlidersHorizontal, Subtitles, X } from 'lucide-react';
import type { PickContextResponse, PickFilters, PickRequest, PickResponse } from '@picknext/shared';
import { api, ApiError } from './api.js';
import { Button, CoverImage, EmptyState, IconButton, PageHeader, Sheet } from './components.js';

const emptyFilters: PickFilters = { languages: [], genres: [], difficulties: [], ratings: [], performanceTypes: [] };

export interface PickController {
  current: PickResponse | null;
  sessionId: string | undefined;
  context: PickContextResponse | undefined;
  contextError: Error | null;
  filters: PickFilters;
  setFilters: Dispatch<SetStateAction<PickFilters>>;
  avoidRecent: boolean;
  setAvoidRecent: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  initializing: boolean;
  operation: 'idle' | 'picking' | 'saving' | 'ending';
  exhausted: boolean;
  ktvExhausted: boolean;
  exhaustedOpen: boolean;
  setExhaustedOpen(open: boolean): void;
  skipSuggestion: PickResponse['skipSuggestion'];
  dismissSkipSuggestion(): void;
  emptyMessage: string;
  pick(continueFromRepertoire?: boolean): Promise<void>;
  complete(rating?: number, note?: string, keyShift?: number): Promise<boolean>;
  endSession(): Promise<void>;
  refreshContext(): Promise<void>;
}

/**
 * Pick 状态由应用根节点持有，确保用户在曲库、Pick 和我的页面间切换时不会丢失当前场次。
 * 同步 busyRef 用于拦截移动端快速连点，服务端 request_id 幂等仍是最终防线。
 */
export function usePickController(notify: (message: string) => void, enabled = true): PickController {
  const client = useQueryClient();
  const contextQuery = useQuery({ queryKey: ['pick-context'], queryFn: () => api<PickContextResponse>('/api/picks/context'), enabled });
  const [current, setCurrent] = useState<PickResponse | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [filters, setFilters] = useState<PickFilters>(emptyFilters);
  const [avoidRecent, setAvoidRecent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<PickController['operation']>('idle');
  const [exhausted, setExhausted] = useState(false);
  const [ktvExhausted, setKtvExhausted] = useState(false);
  const [exhaustedOpen, setExhaustedOpen] = useState(false);
  const [skipSuggestion, setSkipSuggestion] = useState<PickResponse['skipSuggestion']>(null);
  const [emptyMessage, setEmptyMessage] = useState('把选择交给算法，下一首会更有新鲜感。');
  const busyRef = useRef(false);
  const pendingPickRef = useRef<PickRequest | null>(null);

  useEffect(() => {
    if (!contextQuery.data || busyRef.current) return;
    setCurrent(contextQuery.data.current);
    setSessionId(contextQuery.data.sessionId ?? undefined);
    setFilters(contextQuery.data.filters);
    setAvoidRecent(contextQuery.data.avoidRecent);
    setKtvExhausted(contextQuery.data.ktvExhausted);
    setSkipSuggestion(contextQuery.data.current?.skipSuggestion ?? null);
    if (contextQuery.data.ktvExhausted) setExhaustedOpen(true);
  }, [contextQuery.data]);

  const requestNext = useCallback(async (currentEventId?: string, continueFromRepertoire = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOperation('picking');
    const request = pendingPickRef.current ?? {
      requestId: crypto.randomUUID(), sessionId, currentEventId, avoidRecent, filters, continueFromRepertoire
    };
    pendingPickRef.current = request;
    try {
      const result = await api<PickResponse>('/api/picks', { method: 'POST', body: JSON.stringify(request) });
      pendingPickRef.current = null;
      setCurrent(result);
      setSessionId(result.sessionId);
      setSkipSuggestion(result.skipSuggestion);
      setExhausted(false);
      setKtvExhausted(false);
      setExhaustedOpen(false);
      setEmptyMessage('把选择交给算法，下一首会更有新鲜感。');
      if (request.currentEventId) notify('已跳过上一首，未计为唱完。');
      void client.invalidateQueries({ queryKey: ['pick-context'] });
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'NO_CANDIDATES') {
        pendingPickRef.current = null;
        setCurrent(null); setEmptyMessage(reason.message); setExhausted(Boolean(sessionId || current));
      }
      else notify(reason instanceof Error ? reason.message : 'Pick 失败');
    } finally { busyRef.current = false; setBusy(false); setOperation('idle'); }
  }, [avoidRecent, client, current, filters, notify, sessionId]);

  const pick = useCallback(async (continueFromRepertoire = false) => {
    await requestNext(current?.eventId, continueFromRepertoire);
  }, [current?.eventId, requestNext]);

  const complete = useCallback(async (rating?: number, note?: string, keyShift?: number) => {
    if (!current || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setOperation('saving');
    const completed = current;
    let saved = false;
    try {
      await api(`/api/picks/${completed.eventId}/complete`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), rating, note: note || undefined, keyShift }) });
      saved = true;
      setSkipSuggestion(null);
      notify('已记为唱完');
      client.setQueryData<{ playlist: unknown; songs: Array<{ id: number }> }>(['next-ktv'], (value) => value ? { ...value, songs: value.songs.filter((song) => song.id !== current.song.id) } : value);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['history'] }),
        client.invalidateQueries({ queryKey: ['next-ktv'] }),
        client.invalidateQueries({ queryKey: ['library-search'] })
      ]);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '记录失败，请重试');
    } finally { busyRef.current = false; setBusy(false); setOperation('idle'); }
    if (!saved) return false;
    setCurrent(null);
    if (completed.source === 'ktv' && completed.candidateCount === 1) {
      setKtvExhausted(true); setExhaustedOpen(true);
      await client.invalidateQueries({ queryKey: ['pick-context'] });
      return true;
    }
    setEmptyMessage('上一首已保存，正在加载下一首。');
    await requestNext();
    return true;
  }, [client, current, notify, requestNext]);

  const endSession = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOperation('ending');
    try {
      if (sessionId) await api(`/api/pick-sessions/${sessionId}/end`, { method: 'POST', body: '{}' });
      pendingPickRef.current = null;
      setSessionId(undefined); setCurrent(null); setSkipSuggestion(null); setExhausted(false); setKtvExhausted(false); setExhaustedOpen(false); setEmptyMessage('新一场准备好了。'); notify('本场已结束');
      await client.invalidateQueries({ queryKey: ['pick-context'] });
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '结束本场失败，请重试');
    } finally {
      busyRef.current = false; setBusy(false); setOperation('idle');
    }
  }, [client, notify, sessionId]);

  const refreshContext = useCallback(async () => { await contextQuery.refetch(); }, [contextQuery]);

  const dismissSkipSuggestion = useCallback(() => setSkipSuggestion(null), []);
  return { current, sessionId, context: contextQuery.data, contextError: contextQuery.error, filters, setFilters, avoidRecent, setAvoidRecent, busy, initializing: contextQuery.isLoading, operation, exhausted, ktvExhausted, exhaustedOpen, setExhaustedOpen, skipSuggestion, dismissSkipSuggestion, emptyMessage, pick, complete, endSession, refreshContext };
}

export function PickPage({ notify, controller, onOpenGlobalLibrary, canAddSongs }: { notify(message: string): void; controller: PickController; onOpenGlobalLibrary(): void; canAddSongs: boolean }) {
  const client = useQueryClient();
  const { current, sessionId, context, contextError, filters, setFilters, avoidRecent, setAvoidRecent, busy, initializing, operation, exhausted, ktvExhausted, exhaustedOpen, setExhaustedOpen, skipSuggestion, dismissSkipSuggestion, emptyMessage, pick, complete, endSession, refreshContext } = controller;
  const [filterOpen, setFilterOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [karaokeOpen, setKaraokeOpen] = useState(false);
  const [skipActionBusy, setSkipActionBusy] = useState<'snooze' | 'learning' | 'keep' | null>(null);
  const [lyricsCandidates, setLyricsCandidates] = useState<Array<{ id: string; title: string; artist: string; album: string; lyrics: string }> | null>(null);
  const lyrics = useQuery({
    queryKey: ['song-detail', current?.song.id],
    queryFn: () => api<PickSongDetail>(`/api/songs/${current!.song.id}`),
    enabled: Boolean(current)
  });
  useEffect(() => setKaraokeOpen(false), [current?.eventId]);
  const fetchLyrics = async () => {
    if (!current) return;
    try {
      const result = await api<{ candidates: Array<{ id: string; title: string; artist: string; album: string; lyrics: string }> }>(`/api/songs/${current.song.id}/lyrics-candidates`);
      if (!result.candidates.length) { notify('MTW 没有找到匹配歌词。'); return; }
      if (result.candidates.length === 1) { await saveLyrics(result.candidates[0]!); return; }
      setLyricsCandidates(result.candidates);
    } catch (reason) { notify(reason instanceof Error ? reason.message : '获取 MTW 歌词失败'); }
  };
  const saveLyrics = async (candidate: { lyrics: string; id: string }) => {
    if (!current) return;
    try {
      const result = await api<{ status: 'approved' | 'pending_review' }>(`/api/songs/${current.song.id}/lyrics-submissions`, { method: 'POST', body: JSON.stringify({ lyrics: candidate.lyrics, source: `mtw:${candidate.id}` }) });
      setLyricsCandidates(null); await lyrics.refetch(); notify(result.status === 'approved' ? 'MTW 歌词已保存。' : '歌词已提交审核。');
    } catch (reason) { notify(reason instanceof Error ? reason.message : '保存歌词失败'); }
  };
  const finish = async (rating?: number, note?: string, keyShift?: number) => {
    setCompleteError(null);
    const saved = await complete(rating, note, keyShift);
    if (saved) setCompleteOpen(false);
    else { setCompleteError('记录失败，数据未保存，请重试'); setCompleteOpen(true); }
  };
  const requestComplete = () => {
    setCompleteError(null);
    if (current?.song.rating) void finish();
    else setCompleteOpen(true);
  };
  const preview = useMemo(() => readableLyricLines(lyrics.data?.lyrics ?? '').slice(0, 3), [lyrics.data?.lyrics]);
  const resolveSkipSuggestion = async (action: 'snooze' | 'learning' | 'keep') => {
    if (!skipSuggestion || skipActionBusy) return;
    setSkipActionBusy(action);
    try {
      if (action === 'snooze') {
        await api(`/api/user-songs/${skipSuggestion.songId}/snooze`, { method: 'PUT', body: JSON.stringify({ until: new Date(Date.now() + 30 * 86_400_000).toISOString() }) });
      } else if (action === 'learning') {
        await api(`/api/user-songs/${skipSuggestion.songId}/collection`, { method: 'PUT', body: JSON.stringify({ collectionType: 'learning' }) });
      }
      dismissSkipSuggestion();
      await Promise.all([client.invalidateQueries({ queryKey: ['library-search'] }), client.invalidateQueries({ queryKey: ['pick-context'] })]);
      notify(action === 'snooze' ? '已冷藏 30 天。' : action === 'learning' ? '已移至待学清单。' : '继续保留在会唱曲库。');
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : '跳过建议处理失败，请重试。');
    } finally { setSkipActionBusy(null); }
  };

  const empty = initializing
    ? <EmptyState title="正在恢复场次" description="正在读取最近一次 Pick 状态。" />
    : contextError && !context
      ? <EmptyState title="暂时无法读取 Pick 状态" description={contextError.message} action={<Button onClick={() => void refreshContext()}>重新连接</Button>} />
      : context?.counts.repertoire === 0
        ? <FirstUseGuide globalCount={context.counts.global} canAddSongs={canAddSongs} onOpenGlobalLibrary={onOpenGlobalLibrary} />
        : <EmptyState title={exhausted ? '本场候选已完成' : '准备好了吗？'} description={exhausted ? emptyMessage : `${emptyMessage} 点击下方 Pick 开始。`} />;

  return <section className="page pick-page"><PageHeader eyebrow="根据你的曲库来选" title="下一首唱什么" action={<IconButton label="筛选" onClick={() => setFilterOpen(true)}><SlidersHorizontal /></IconButton>} />
    {context && context.counts.nextKtv > 0 && <p className="pick-ktv-status"><Mic2 size={15} />下一次 KTV · 剩余 {context.counts.nextKtv} 首</p>}
    <div className="pick-stage"><AnimatePresence mode="wait">{current ? <motion.article key={current.eventId} className="pick-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
      <div className="vinyl"><CoverImage className="vinyl-cover" url={current.song.coverUrl} alt={`${current.song.title}封面`} /></div><p className="pick-reason">{current.reason}</p><h2>{current.song.title}</h2><h3>{current.song.artist}{current.song.version ? ` · ${current.song.version}` : ''}</h3><div className="pick-meta"><span>{current.song.album ?? '专辑未填'}</span><span>{current.song.language ?? '语种未填'}</span><span>{current.song.genre ?? '曲风未填'}</span>{current.song.keyShift !== null && <span>{current.song.keyShift > 0 ? '+' : ''}{current.song.keyShift} Key</span>}</div>
      <button className={`pick-lyrics-preview ${preview.length ? '' : 'empty'}`} onClick={() => preview.length ? setKaraokeOpen(true) : void fetchLyrics()}><Subtitles size={17} /><span>{preview.length ? preview.map((line) => <i key={line}>{line}</i>) : <i>暂无歌词</i>}</span><b>{preview.length ? '歌词计时跟唱' : '从 MTW 获取'}</b></button>
      <p className="candidate-count">本轮候选 {current.candidateCount} 首 · {current.algorithmVersion}</p>
      <Button className="complete" onClick={requestComplete} loading={operation === 'saving'} disabled={busy}><Check />{operation === 'saving' ? '正在保存' : '唱完了'}</Button>
    </motion.article> : <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>{empty}</motion.div>}</AnimatePresence></div>
    {sessionId && <button className="text-action" disabled={busy} onClick={endSession}>{operation === 'ending' ? '正在结束…' : '结束本场'} <ChevronRight size={16} /></button>}
    <FilterSheet open={filterOpen} onOpenChange={setFilterOpen} filters={filters} setFilters={setFilters} avoidRecent={avoidRecent} setAvoidRecent={setAvoidRecent} facets={context?.facets ?? { languages: [], genres: [] }} onApply={() => { setFilterOpen(false); if (exhausted) { setExhaustedOpen(false); void pick(); } else notify('筛选将在下一次 Pick 生效'); }} />
    <CompleteSheet open={completeOpen} onOpenChange={(open) => { setCompleteOpen(open); if (open) setCompleteError(null); }} onComplete={finish} error={completeError} busy={busy} />
    <SkipSuggestionSheet suggestion={skipSuggestion} busy={skipActionBusy} onOpenChange={(open) => { if (!open) dismissSkipSuggestion(); }} onAction={(action) => void resolveSkipSuggestion(action)} />
    <Sheet open={exhaustedOpen} onOpenChange={setExhaustedOpen} title={ktvExhausted ? '下一次 KTV 已唱完' : '本场已经唱完'}><div className="sheet-stack"><p className="helper">{ktvExhausted ? '准备的 KTV 歌曲已经全部处理完，可以继续从会唱曲库 Pick，或结束本场。' : '当前条件下没有尚未抽取的歌曲。本场不会重复推荐已经抽取过的歌曲。'}</p>{ktvExhausted ? <Button onClick={() => void pick(true)}><Mic2 size={18} />继续唱会唱曲库</Button> : <Button onClick={() => { setExhaustedOpen(false); setFilterOpen(true); }}><SlidersHorizontal size={18} />调整筛选继续</Button>}<Button className="secondary" loading={operation === 'ending'} onClick={() => void endSession()}><Check size={18} />结束本场</Button></div></Sheet>
    <KaraokeOverlay open={karaokeOpen} song={current ? { id: current.song.id, title: current.song.title, artist: current.song.artist } : null} lyrics={lyrics.data?.lyrics ?? ''} onClose={() => setKaraokeOpen(false)} onComplete={() => { setKaraokeOpen(false); requestComplete(); }} onNext={() => { setKaraokeOpen(false); void pick(); }} notify={notify} />
    <Sheet open={Boolean(lyricsCandidates)} onOpenChange={(open) => !open && setLyricsCandidates(null)} title="选择 MTW 歌词"><div className="sheet-stack">{lyricsCandidates?.map((candidate) => <button className="candidate-option" key={candidate.id} onClick={() => void saveLyrics(candidate)}><strong>{candidate.album}</strong><span>{candidate.title} · {candidate.artist}</span><small>{readableLyricLines(candidate.lyrics).slice(0, 2).join(' / ')}</small></button>)}</div></Sheet>
  </section>;
}

export function FirstUseGuide({ globalCount, canAddSongs, onOpenGlobalLibrary }: { globalCount: number; canAddSongs: boolean; onOpenGlobalLibrary(): void }) {
  const description = globalCount > 0
    ? '先从全部曲库选择几首你会唱的歌。会唱歌曲会进入普通 Pick，待学歌曲不会；下一次 KTV 会在 Pick 时优先。'
    : canAddSongs
      ? '全部曲库还是空的，请先添加歌曲，再标记为会唱或待学。'
      : '全部曲库还是空的，请联系管理员或曲库管家添加歌曲。';
  return <EmptyState title="先准备你的会唱曲库" description={description} action={(globalCount > 0 || canAddSongs) && <Button onClick={onOpenGlobalLibrary}>{globalCount > 0 ? '去全部曲库选歌' : '去添加第一首歌'}</Button>} />;
}

interface PickSongDetail { lyrics: string | null }
interface KaraokeLine { time: number | null; text: string }

function readableLyricLines(input: string): string[] {
  return input.split(/\r?\n/).map((line) => line.replace(/\[[^\]]+\]/g, '').trim()).filter(Boolean);
}

function parseKaraokeLines(input: string): KaraokeLine[] {
  const timed: KaraokeLine[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const timestamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+\]/g, '').trim();
    for (const match of timestamps) {
      // LRC 中的空时间轴常用于分隔或占位，不应在跟唱界面显示成“♪”。
      if (text) timed.push({ time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`), text });
    }
  }
  if (timed.length) return timed.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return readableLyricLines(input).map((text) => ({ time: null, text }));
}

function formatKaraokeTime(time: number | null): string {
  if (time === null) return '未计时';
  const minutes = Math.floor(time / 60);
  const seconds = time % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

/** PWA 跟唱使用应用内计时，不缓存音频；点击歌词行可随时重新对齐当前进度。 */
function KaraokeOverlay({ open, song, lyrics, onClose, onComplete, onNext, notify }: { open: boolean; song: { id: number; title: string; artist: string } | null; lyrics: string; onClose(): void; onComplete(): void; onNext(): void; notify(message: string): void }) {
  const lines = useMemo(() => parseKaraokeLines(lyrics), [lyrics]);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [offset, setOffset] = useState(0);
  const [manualLine, setManualLine] = useState(0);
  const startedAt = useRef(0);
  const wakeLock = useRef<any>(null);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [playing]);
  useEffect(() => { if (!open) { setPlaying(false); setElapsed(0); setOffset(0); setManualLine(0); void wakeLock.current?.release?.(); wakeLock.current = null; } }, [open]);
  if (!open || !song) return null;
  const timed = lines.some((line) => line.time !== null);
  const active = timed ? lines.findLastIndex((line) => line.time !== null && line.time <= elapsed + offset) : manualLine;
  const toggle = async () => {
    if (playing) { setPlaying(false); await wakeLock.current?.release?.(); wakeLock.current = null; return; }
    startedAt.current = Date.now() - elapsed * 1000; setPlaying(true);
    try { wakeLock.current = await (navigator as any).wakeLock?.request('screen'); } catch { notify('浏览器未允许屏幕常亮，歌词计时仍会继续。'); }
  };
  const align = (line: KaraokeLine, index: number) => {
    setManualLine(index);
    if (line.time !== null) { setElapsed(Math.max(0, line.time - offset)); startedAt.current = Date.now() - Math.max(0, line.time - offset) * 1000; }
  };
  return <section className="karaoke-overlay" role="dialog" aria-modal="true" aria-label={`${song.title}歌词计时跟唱`}><header><div><strong>{song.title}</strong><span>{song.artist}</span></div><IconButton label="关闭跟唱" onClick={onClose}><X /></IconButton></header><div className="karaoke-controls"><Button className="secondary" onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}{playing ? '暂停' : '开始计时'}</Button><button onClick={() => setOffset((value) => value - .5)}>−0.5s</button><span>{offset > 0 ? '+' : ''}{offset.toFixed(1)}s</span><button onClick={() => setOffset((value) => value + .5)}>+0.5s</button></div><div className="karaoke-lines">{lines.map((line, index) => <button className={index === active ? 'active' : ''} key={`${line.time}-${index}`} onClick={() => align(line, index)}><small>{formatKaraokeTime(line.time)}</small><span>{line.text}</span></button>)}</div><p className="karaoke-hint">上下拖动浏览歌词，点击歌词行重新对齐；只提供歌词计时，不播放伴奏、不录音或评分</p><footer><Button className="secondary" onClick={onComplete}><Check size={18} />唱完了</Button><Button onClick={onNext}>跳过这首<ChevronRight size={18} /></Button></footer></section>;
}

function FilterSheet({ open, onOpenChange, filters, setFilters, avoidRecent, setAvoidRecent, facets, onApply }: any) {
  const toggle = (group: keyof PickFilters, value: any) => setFilters((current: PickFilters) => {
    const values = current[group] as readonly any[];
    return { ...current, [group]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] };
  });
  return <Sheet open={open} onOpenChange={onOpenChange} title="Pick 筛选"><div className="sheet-stack"><label className="switch-row"><span><MoonStar />避开最近唱过的 10 首<small>无候选时会自动放宽并明确提示</small></span><input type="checkbox" checked={avoidRecent} onChange={(event) => setAvoidRecent(event.target.checked)} /></label>{facets.languages.length > 0 && <FilterGroup title="语言" values={facets.languages.map((value: string) => [value, value])} selected={filters.languages} onToggle={(value) => toggle('languages', value)} />}{facets.genres.length > 0 && <FilterGroup title="曲风" values={facets.genres.map((value: string) => [value, value])} selected={filters.genres} onToggle={(value) => toggle('genres', value)} />}<FilterGroup title="个人难度" values={[['easy', '轻松'], ['medium', '适中'], ['hard', '挑战']]} selected={filters.difficulties} onToggle={(value) => toggle('difficulties', value)} /><FilterGroup title="演唱类型" values={[['solo', '独唱'], ['duet', '对唱'], ['chorus', '合唱']]} selected={filters.performanceTypes} onToggle={(value) => toggle('performanceTypes', value)} /><FilterGroup title="长期把握" values={[[3, '3星'], [4, '4星'], [5, '5星']]} selected={filters.ratings} onToggle={(value) => toggle('ratings', value)} /><Button onClick={onApply}><Filter size={18} />应用筛选</Button><Button className="ghost" onClick={() => setFilters(emptyFilters)}>清空筛选</Button></div></Sheet>;
}

function FilterGroup({ title, values, selected, onToggle }: { title: string; values: Array<[any, string]>; selected: any[]; onToggle(value: any): void }) {
  return <fieldset className="filter-group"><legend>{title}</legend><div className="chips">{values.map(([value, label]) => <button type="button" className={selected.includes(value) ? 'selected' : ''} key={value} onClick={() => onToggle(value)}>{label}</button>)}</div></fieldset>;
}

function CompleteSheet({ open, onOpenChange, onComplete, error, busy }: { open: boolean; onOpenChange(open: boolean): void; onComplete(rating: number, note?: string, keyShift?: number): Promise<void>; error: string | null; busy: boolean }) {
  const [rating, setRating] = useState(4); const [note, setNote] = useState(''); const [keyShift, setKeyShift] = useState(0);
  return <Sheet open={open} onOpenChange={onOpenChange} title="第一次唱完"><div className="sheet-stack"><p className="helper">请选择长期演唱把握，这会帮助以后筛选歌曲。</p><div className="rating" aria-label="长期演唱把握">{[1,2,3,4,5].map((value) => <button key={value} onClick={() => setRating(value)} className={value <= rating ? 'active' : ''}>★</button>)}</div><details className="complete-details"><summary>补充记录（选填）</summary><div className="sheet-stack"><label>个人升降调<select value={keyShift} onChange={(event) => setKeyShift(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index - 6).map((value) => <option key={value} value={value}>{value > 0 ? '+' : ''}{value} Key</option>)}</select></label><label>本次备注<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="今天高音有点紧……" /></label></div></details>{error && <p className="form-error" role="alert">{error}</p>}<Button loading={busy} onClick={() => void onComplete(rating, note, keyShift)}><Check />保存并下一首</Button></div></Sheet>;
}

export function SkipSuggestionSheet({ suggestion, busy, onOpenChange, onAction }: { suggestion: PickResponse['skipSuggestion']; busy: 'snooze' | 'learning' | 'keep' | null; onOpenChange(open: boolean): void; onAction(action: 'snooze' | 'learning' | 'keep'): void }) {
  return <Sheet open={Boolean(suggestion)} onOpenChange={onOpenChange} title="这首歌连续 3 场未唱"><div className="sheet-stack"><p className="helper">「{suggestion?.title}」已经连续三个不同场次被跳过，要怎么处理？</p><Button loading={busy === 'snooze'} disabled={Boolean(busy)} onClick={() => onAction('snooze')}>冷藏 30 天</Button><Button className="secondary" loading={busy === 'learning'} disabled={Boolean(busy)} onClick={() => onAction('learning')}>移至待学清单</Button><Button className="ghost" loading={busy === 'keep'} disabled={Boolean(busy)} onClick={() => onAction('keep')}>继续保留</Button></div></Sheet>;
}
