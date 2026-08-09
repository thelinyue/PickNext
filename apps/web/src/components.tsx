import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { BookOpen, Check, Dice5, History, Library, LoaderCircle, Mic2, Music2, RefreshCw, UserRound, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { GlobalSongListItem, PersonalSongListItem } from '@picknext/shared';

export function Button({ className = '', children, loading = false, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return <button className={`button ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading && <LoaderCircle className="spin" size={18} />}{children}</button>;
}

export function IconButton({ label, children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

export function Sheet({ open, onOpenChange, title, children }: PropsWithChildren<{ open: boolean; onOpenChange(open: boolean): void; title: string }>) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="sheet">
      <div className="sheet-handle" /><div className="sheet-header"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><IconButton label="关闭"><X /></IconButton></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Music2 /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export interface SongLike { id: number; title: string; artist: string; version?: string | null; rating?: number | null }

type SongCardProps = {
  song: PersonalSongListItem | GlobalSongListItem;
  variant: 'personal-repertoire' | 'personal-learning' | 'global';
  action?: ReactNode;
  onClick?: () => void;
};

/**
 * 曲库卡片按数据范围展示信息：个人卡片可以读取个人元数据，全部曲库卡片只展示全局资料和匿名聚合。
 * 这里明确使用三种变体，避免后续新增字段时误把其他用户的个人信息带到全部曲库。
 */
export function SongCard({ song, variant, action, onClick }: SongCardProps) {
  const personal = song.scope === 'personal' ? song : null;
  const global = song.scope === 'global' ? song : null;
  const meta = variant === 'personal-repertoire' && personal
    ? [performanceLabels[personal.performanceType], difficultyLabels[personal.personalDifficulty ?? ''], formatKeyShift(personal.keyShift)]
    : variant === 'personal-learning' && personal
      ? [personal.language, personal.genre, performanceLabels[personal.performanceType], difficultyLabels[personal.personalDifficulty ?? '']]
      : global
        ? [global.language, global.genre, performanceLabels[global.performanceType], difficultyLabels[global.referenceDifficulty ?? '']]
        : [];
  const statuses = personal ? personalStatuses(personal, variant) : [];
  const content = <><div className="song-art"><Music2 size={19} /></div>
    <div className="song-copy">
      <div className="song-title-line"><strong>{song.title}</strong>{song.version && <span className="song-version">{song.version}</span>}
        {personal?.rating && variant === 'personal-repertoire' && <span className="song-rating" aria-label={`${personal.rating} 星`}>{'★'.repeat(personal.rating)}{'☆'.repeat(5 - personal.rating)}</span>}
        {variant === 'personal-learning' && <span className="collection-badge learning">待学</span>}
        {global && <span className={`collection-badge ${global.collectionType ?? 'uncollected'}`}>{collectionLabels[global.collectionType ?? 'uncollected']}</span>}
      </div>
      <div className="song-meta-line"><span className="song-artist">{song.artist}</span>{meta.filter(Boolean).map((item) => <span className="meta-chip" key={item}>{item}</span>)}</div>
      {(statuses.length > 0 || global?.aggregateRating) && <div className="song-status-line">
        {statuses.map((item) => <span key={item}>{item}</span>)}
        {global?.aggregateRating && <span className="aggregate-rating">★ {global.aggregateRating.toFixed(1)} · {global.aggregateRatingCount}人</span>}
      </div>}
    </div></>;
  return <motion.article layout className={`song-card song-card-${variant}`}>
    {onClick ? <button className="song-card-body" aria-label={`查看${song.title}详情`} onClick={onClick}>{content}</button> : <div className="song-card-body">{content}</div>}
    {action && <div className="song-action" onClick={(event) => event.stopPropagation()}>{action}</div>}
  </motion.article>;
}

export function BasicSongCard({ song, action, onClick }: { song: SongLike; action?: ReactNode; onClick?: () => void }) {
  return <motion.article layout className="song-card basic-song-card" {...(onClick ? { onClick, whileTap: { scale: .985 } } : {})}>
    <div className="song-art"><Music2 size={19} /></div><div className="song-copy"><div className="song-title-line"><strong>{song.title}</strong>{song.rating && <span className="song-rating">{'★'.repeat(song.rating)}{'☆'.repeat(5 - song.rating)}</span>}</div><div className="song-meta-line"><span className="song-artist">{song.artist}{song.version ? ` · ${song.version}` : ''}</span></div></div>{action}
  </motion.article>;
}

const performanceLabels = { solo: '独唱', duet: '对唱', chorus: '合唱' } as const;
const difficultyLabels: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难', '': '' };
const collectionLabels = { repertoire: '会唱', learning: '待学', uncollected: '未收录' } as const;

function formatKeyShift(value: number | null): string {
  if (!value) return '';
  return `${value > 0 ? '+' : ''}${value} Key`;
}

function personalStatuses(song: PersonalSongListItem, variant: SongCardProps['variant']): string[] {
  const result: string[] = [];
  if (variant === 'personal-repertoire' && song.playCount > 0) result.push(`唱过 ${song.playCount} 次`);
  if (variant === 'personal-repertoire' && song.lastPlayedAt) result.push(relativePlayedAt(song.lastPlayedAt));
  if (song.hasLyrics) result.push('歌词');
  if (song.hasNote || song.hasMemoryCue) result.push('备注');
  if (song.snoozedUntil && new Date(song.snoozedUntil).getTime() > Date.now()) result.push('冷藏中');
  return result;
}

function relativePlayedAt(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return '今天唱过';
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

export function Toast({ message }: { message: string | null }) {
  return <div className={`toast ${message ? 'visible' : ''}`} role="status" aria-live="polite">{message}</div>;
}

export function NetworkBanner() {
  return <div className="network-banner" role="status">当前处于离线状态；已加载内容仍可查看，新的操作需要恢复网络。</div>;
}

export type NavigationPage = 'library' | 'pick' | 'me';
export type PickNavState = 'idle' | 'continue' | 'switch' | 'loading' | 'exhausted';

const pickNavPresentation = {
  idle: { label: 'PICK', accessibleName: '开始 Pick', icon: Dice5 },
  continue: { label: '继续', accessibleName: '返回当前歌曲', icon: Mic2 },
  switch: { label: '跳过', accessibleName: '跳过这首', icon: RefreshCw },
  loading: { label: '抽取中', accessibleName: '正在抽取', icon: Dice5 },
  exhausted: { label: '结束', accessibleName: '处理本场', icon: Check }
} as const;

/** 底部导航只负责展示明确状态；Pick 的业务动作由应用级控制器统一决定。 */
export function AppShell({ page, onNavigate, onPickAction, pickState, children }: PropsWithChildren<{ page: NavigationPage; onNavigate(page: NavigationPage): void; onPickAction(): void; pickState: PickNavState }>) {
  const items = [
    { id: 'library' as const, label: '曲库', icon: Library },
    { id: 'me' as const, label: '我的', icon: UserRound }
  ];
  const pick = pickNavPresentation[pickState];
  const PickIcon = pick.icon;
  return <div className="app-shell"><main>{children}</main><nav className="bottom-nav" aria-label="主导航"><span className="bottom-nav-surface" aria-hidden="true" />{items.map((item) => {
    const Icon = item.icon;
    return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => onNavigate(item.id)}><Icon /><span>{item.label}</span></button>;
  })}<motion.button className={`nav-pick state-${pickState} ${page === 'pick' ? 'active' : ''}`} disabled={pickState === 'loading'} aria-label={pick.accessibleName} aria-busy={pickState === 'loading'} onClick={onPickAction}><span className="nav-pick-orb"><PickIcon /><b>{pick.label}</b></span></motion.button></nav></div>;
}

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1></div>{action}</header>;
}

export const LibraryIcon = BookOpen;
export const HistoryIcon = History;
