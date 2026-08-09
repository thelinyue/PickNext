import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, Filter, Mic2, MoonStar, SlidersHorizontal } from 'lucide-react';
import type { PickFilters, PickResponse } from '@picknext/shared';
import { api, ApiError } from './api.js';
import { Button, EmptyState, IconButton, PageHeader, Sheet } from './components.js';

const emptyFilters: PickFilters = { languages: [], genres: [], difficulties: [], ratings: [], performanceTypes: [] };

export interface PickController {
  current: PickResponse | null;
  sessionId: string | undefined;
  filters: PickFilters;
  setFilters: Dispatch<SetStateAction<PickFilters>>;
  avoidRecent: boolean;
  setAvoidRecent: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  emptyMessage: string;
  pick(): Promise<void>;
  complete(rating?: number, note?: string, keyShift?: number): Promise<void>;
  endSession(): Promise<void>;
}

/**
 * Pick 状态由应用根节点持有，确保用户在曲库、Pick 和我的页面间切换时不会丢失当前场次。
 * 同步 busyRef 用于拦截移动端快速连点，服务端 request_id 幂等仍是最终防线。
 */
export function usePickController(notify: (message: string) => void): PickController {
  const client = useQueryClient();
  const [current, setCurrent] = useState<PickResponse | null>(null);
  const [sessionId, setSessionId] = useState<string>();
  const [filters, setFilters] = useState<PickFilters>(emptyFilters);
  const [avoidRecent, setAvoidRecent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [emptyMessage, setEmptyMessage] = useState('把选择交给算法，下一首会更有新鲜感。');
  const busyRef = useRef(false);

  const requestNext = useCallback(async (currentEventId?: string) => {
    const requestId = crypto.randomUUID();
    const result = await api<PickResponse>('/api/picks', { method: 'POST', body: JSON.stringify({
      requestId, sessionId, currentEventId, avoidRecent, filters
    }) });
    setCurrent(result);
    setSessionId(result.sessionId);
    if (result.skipSuggestion) notify('上一首已连续 3 场跳过，可以考虑冷藏或移到待学。');
  }, [avoidRecent, filters, notify, sessionId]);

  const pick = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await requestNext(current?.eventId);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'NO_CANDIDATES') { setCurrent(null); setEmptyMessage(reason.message); }
      else notify(reason instanceof Error ? reason.message : 'Pick 失败');
    } finally { busyRef.current = false; setBusy(false); }
  }, [current?.eventId, notify, requestNext]);

  const complete = useCallback(async (rating?: number, note?: string, keyShift?: number) => {
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api(`/api/picks/${current.eventId}/complete`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), rating, note: note || undefined, keyShift }) });
      notify('已记为唱完');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['history'] }),
        client.invalidateQueries({ queryKey: ['next-ktv'] }),
        client.invalidateQueries({ queryKey: ['library-search'] })
      ]);
      await requestNext(current.eventId);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'NO_CANDIDATES') { setCurrent(null); setEmptyMessage('本场候选已经唱完了，可以调整筛选或结束本场。'); }
      else notify(reason instanceof Error ? reason.message : '记录失败');
    } finally { busyRef.current = false; setBusy(false); }
  }, [client, current, notify, requestNext]);

  const endSession = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (sessionId) await api(`/api/pick-sessions/${sessionId}/end`, { method: 'POST', body: '{}' });
    setSessionId(undefined); setCurrent(null); setEmptyMessage('新一场准备好了。'); notify('本场已结束');
    busyRef.current = false;
    setBusy(false);
  }, [notify, sessionId]);

  return { current, sessionId, filters, setFilters, avoidRecent, setAvoidRecent, busy, emptyMessage, pick, complete, endSession };
}

export function PickPage({ notify, controller }: { notify(message: string): void; controller: PickController }) {
  const { current, sessionId, filters, setFilters, avoidRecent, setAvoidRecent, busy, emptyMessage, complete, endSession } = controller;
  const [filterOpen, setFilterOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const finish = async (rating?: number, note?: string, keyShift?: number) => { await complete(rating, note, keyShift); setCompleteOpen(false); };

  return <section className="page pick-page"><PageHeader eyebrow="感知随机 · 本场不重复" title="下一首唱什么" action={<IconButton label="筛选" onClick={() => setFilterOpen(true)}><SlidersHorizontal /></IconButton>} />
    <div className="pick-stage"><AnimatePresence mode="wait">{current ? <motion.article key={current.eventId} className="pick-card" initial={{ opacity: 0, y: 28, rotate: -1 }} animate={{ opacity: 1, y: 0, rotate: 0 }} exit={{ opacity: 0, y: -20, scale: .97 }}>
      <div className="vinyl"><Mic2 /></div><p className="pick-reason">{current.reason}</p><h2>{current.song.title}</h2><h3>{current.song.artist}{current.song.version ? ` · ${current.song.version}` : ''}</h3><div className="pick-meta"><span>{current.song.language ?? '语种未填'}</span><span>{current.song.genre ?? '曲风未填'}</span>{current.song.keyShift !== null && <span>{current.song.keyShift > 0 ? '+' : ''}{current.song.keyShift} Key</span>}</div><p className="candidate-count">本轮候选 {current.candidateCount} 首 · {current.algorithmVersion}</p>
      <Button className="complete" onClick={() => current.song.rating ? finish() : setCompleteOpen(true)} disabled={busy}><Check />唱完了</Button>
    </motion.article> : <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><EmptyState title="准备好了吗？" description={`${emptyMessage} 点击下方 Pick 开始。`} /></motion.div>}</AnimatePresence></div>
    {sessionId && <button className="text-action" onClick={endSession}>结束本场 <ChevronRight size={16} /></button>}
    <FilterSheet open={filterOpen} onOpenChange={setFilterOpen} filters={filters} setFilters={setFilters} avoidRecent={avoidRecent} setAvoidRecent={setAvoidRecent} onApply={() => { setFilterOpen(false); notify('筛选将在下一次 Pick 生效'); }} />
    <CompleteSheet open={completeOpen} onOpenChange={setCompleteOpen} onComplete={finish} busy={busy} />
  </section>;
}

function FilterSheet({ open, onOpenChange, filters, setFilters, avoidRecent, setAvoidRecent, onApply }: any) {
  const toggle = (group: keyof PickFilters, value: any) => setFilters((current: PickFilters) => {
    const values = current[group] as readonly any[];
    return { ...current, [group]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] };
  });
  return <Sheet open={open} onOpenChange={onOpenChange} title="Pick 筛选"><div className="sheet-stack"><label className="switch-row"><span><MoonStar />避开最近唱过的 10 首<small>无候选时会自动放宽并明确提示</small></span><input type="checkbox" checked={avoidRecent} onChange={(event) => setAvoidRecent(event.target.checked)} /></label><FilterGroup title="个人难度" values={[['easy', '轻松'], ['medium', '适中'], ['hard', '挑战']]} selected={filters.difficulties} onToggle={(value) => toggle('difficulties', value)} /><FilterGroup title="演唱类型" values={[['solo', '独唱'], ['duet', '对唱'], ['chorus', '合唱']]} selected={filters.performanceTypes} onToggle={(value) => toggle('performanceTypes', value)} /><FilterGroup title="长期把握" values={[[3, '3星'], [4, '4星'], [5, '5星']]} selected={filters.ratings} onToggle={(value) => toggle('ratings', value)} /><Button onClick={onApply}><Filter size={18} />应用筛选</Button><Button className="ghost" onClick={() => setFilters(emptyFilters)}>清空筛选</Button></div></Sheet>;
}

function FilterGroup({ title, values, selected, onToggle }: { title: string; values: Array<[any, string]>; selected: any[]; onToggle(value: any): void }) {
  return <fieldset className="filter-group"><legend>{title}</legend><div className="chips">{values.map(([value, label]) => <button type="button" className={selected.includes(value) ? 'selected' : ''} key={value} onClick={() => onToggle(value)}>{label}</button>)}</div></fieldset>;
}

function CompleteSheet({ open, onOpenChange, onComplete, busy }: { open: boolean; onOpenChange(open: boolean): void; onComplete(rating: number, note?: string, keyShift?: number): void; busy: boolean }) {
  const [rating, setRating] = useState(4); const [note, setNote] = useState(''); const [keyShift, setKeyShift] = useState(0);
  return <Sheet open={open} onOpenChange={onOpenChange} title="第一次唱完"><div className="sheet-stack"><p className="helper">记录长期演唱把握，以后不会重复打扰。</p><div className="rating" aria-label="长期演唱把握">{[1,2,3,4,5].map((value) => <button key={value} onClick={() => setRating(value)} className={value <= rating ? 'active' : ''}>★</button>)}</div><label>个人升降调<select value={keyShift} onChange={(event) => setKeyShift(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index - 6).map((value) => <option key={value} value={value}>{value > 0 ? '+' : ''}{value} Key</option>)}</select></label><label>本次备注（可选）<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="今天高音有点紧……" /></label><Button disabled={busy} onClick={() => onComplete(rating, note, keyShift)}><Check />保存并下一首</Button></div></Sheet>;
}
