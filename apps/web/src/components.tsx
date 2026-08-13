import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ChangeEvent, type PropsWithChildren, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { BookOpen, Camera, Check, Dice5, History, Library, LoaderCircle, Mic2, Music2, Pencil, RefreshCw, UserRound, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { GlobalSongListItem, PersonalSongListItem } from '@picknext/shared';
import { api } from './api.js';

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

export interface SongLike { id: number; title: string; artist: string; version?: string | null; album?: string | null; coverUrl?: string | null; rating?: number | null }

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
  const content = <><CoverImage url={song.coverUrl} alt={`${song.title}封面`} />
    <div className="song-copy">
      <div className="song-title-line"><strong>{song.title}</strong>{song.version && <span className="song-version">{song.version}</span>}
        {personal?.rating && variant === 'personal-repertoire' && <span className="song-rating" aria-label={`${personal.rating} 星`}>{'★'.repeat(personal.rating)}{'☆'.repeat(5 - personal.rating)}</span>}
        {variant === 'personal-learning' && <span className="collection-badge learning">待学</span>}
        {global && <span className={`collection-badge ${global.collectionType ?? 'uncollected'}`}>{collectionLabels[global.collectionType ?? 'uncollected']}</span>}
      </div>
      <div className="song-meta-line"><span className="song-artist">{song.artist}</span>{song.album && <span className="meta-chip">{song.album}</span>}{meta.filter(Boolean).map((item) => <span className="meta-chip" key={item}>{item}</span>)}</div>
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
    <CoverImage url={song.coverUrl} alt={`${song.title}封面`} /><div className="song-copy"><div className="song-title-line"><strong>{song.title}</strong>{song.version && <span className="song-version">{song.version}</span>}{song.album && <span className="song-version">{song.album}</span>}{song.rating && <span className="song-rating">{'★'.repeat(song.rating)}{'☆'.repeat(5 - song.rating)}</span>}</div><div className="song-meta-line"><span className="song-artist">{song.artist}</span></div></div>{action}
  </motion.article>;
}

export function CoverImage({ url, alt, className = '' }: { url?: string | null | undefined; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={`song-art ${className}`.trim()}>{url && !failed ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /> : <Music2 size={19} aria-label="没有封面" />}</div>;
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

export type NavigationPage = 'library' | 'pick' | 'me' | 'admin';
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
  const standalone = page === 'admin';
  return <div className={`app-shell ${standalone ? 'admin-shell' : ''}`}><main>{children}</main>{!standalone && <nav className="bottom-nav" aria-label="主导航"><span className="bottom-nav-surface" aria-hidden="true" />{items.map((item) => {
    const Icon = item.icon;
    return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => onNavigate(item.id)}><Icon /><span>{item.label}</span></button>;
  })}<motion.button className={`nav-pick state-${pickState} ${page === 'pick' ? 'active' : ''}`} disabled={pickState === 'loading'} aria-label={pick.accessibleName} aria-busy={pickState === 'loading'} onClick={onPickAction}><span className="nav-pick-orb"><PickIcon /><b>{pick.label}</b></span></motion.button></nav>}</div>;
}

type ProfileHeaderUser = { username: string; nickname: string | null; displayName: string; avatarUrl: string | null };

function ProfileAvatar({ user, large = false }: { user: Pick<ProfileHeaderUser, 'displayName' | 'avatarUrl'>; large?: boolean }) {
  const initial = (user.displayName || '?').slice(0, 1).toUpperCase();
  return <div className={`profile-avatar ${large ? 'large' : ''}`}>{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <b className="profile-avatar-letter">{initial}</b>}</div>;
}

function ProfilePageHeader({ fallbackTitle }: { fallbackTitle: string }) {
  const client = useQueryClient();
  const profile = useQuery({ queryKey: ['profile-header'], queryFn: () => api<{ user: ProfileHeaderUser }>('/api/auth/me') });
  const [open, setOpen] = useState(false);
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const apiUser = profile.data?.user;
  const user = apiUser ? { ...apiUser, nickname: apiUser.nickname ?? null, displayName: apiUser.displayName ?? apiUser.nickname ?? apiUser.username, avatarUrl: apiUser.avatarUrl ?? null } : { username: fallbackTitle, nickname: null, displayName: fallbackTitle, avatarUrl: null };

  useEffect(() => { if (open) { setNickname(user.nickname ?? ''); setAvatar(undefined); } }, [open, user.nickname]);
  const save = useMutation({
    mutationFn: () => api<{ user: ProfileHeaderUser }>('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ nickname: nickname.trim() || null, ...(avatar !== undefined ? { avatar } : {}) }) }),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['profile-header'] }), client.invalidateQueries({ queryKey: ['me'] })]); setOpen(false); }
  });
  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) return;
    const reader = new FileReader(); reader.onload = () => setAvatar(typeof reader.result === 'string' ? reader.result : null); reader.readAsDataURL(file);
  };
  const avatarPreview = avatar === undefined ? user.avatarUrl : avatar;
  return <>
    <header className="page-header profile-page-header"><button className="profile-identity-trigger" onClick={() => setOpen(true)} aria-label="编辑个人信息"><div className="profile-identity-copy"><span>欢迎回来</span><h1>{user.displayName}</h1></div></button><button className="profile-avatar-trigger" onClick={() => setOpen(true)} aria-label="编辑头像"><ProfileAvatar user={user} /><Pencil size={14} /></button></header>
    <Sheet open={open} onOpenChange={setOpen} title="个人信息"><div className="profile-editor">
      <button className="profile-editor-avatar" onClick={() => fileRef.current?.click()} aria-label="更换头像"><ProfileAvatar user={{ ...user, avatarUrl: avatarPreview }} large /><span><Camera size={15} />更换头像</span></button>
      <input ref={fileRef} className="profile-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseAvatar} />
      {avatarPreview && <button className="profile-remove-avatar" onClick={() => setAvatar(null)}>移除头像</button>}
      <label>昵称<input maxLength={40} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="设置一个展示昵称" /></label>
      <label>登录用户名<input value={`@${user.username}`} readOnly /></label>
      <p className="helper">昵称会显示在个人页、歌单和管理后台；登录用户名保持不变。</p>
      <div className="profile-editor-actions"><Button className="secondary" onClick={() => setOpen(false)}>取消</Button><Button loading={save.isPending} onClick={() => save.mutate()}>保存资料</Button></div>
    </div></Sheet>
  </>;
}

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  if (eyebrow === '个人空间') return <ProfilePageHeader fallbackTitle={title} />;
  return <header className="page-header"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1></div>{action}</header>;
}

export const LibraryIcon = BookOpen;
export const HistoryIcon = History;
