export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'picknext-theme';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * 主题偏好只属于当前浏览器用户，不写入后端，避免把设备显示偏好混入账户资料。
 * 自适应模式交给 prefers-color-scheme，显式模式通过 data-theme 覆盖系统设置。
 */
export function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode = readThemeMode()): void {
  if (typeof document === 'undefined') return;
  const effectiveTheme = getEffectiveTheme(mode);
  const root = document.documentElement;

  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  root.style.colorScheme = effectiveTheme;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = effectiveTheme === 'dark' ? '#111016' : '#f7f7fa';
}

export function setThemeMode(mode: ThemeMode): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // 本地存储不可用时仍立即应用本次选择，刷新后再回到自适应模式。
    }
  }
  applyTheme(mode);
}

export function applyStoredTheme(): void {
  applyTheme(readThemeMode());
}

/** 系统主题变化时只更新自适应模式，显式浅色或深色不受系统切换影响。 */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const legacyMedia = media as unknown as { addListener(listener: () => void): void; removeListener(listener: () => void): void };
  const onChange = () => { if (readThemeMode() === 'system') applyTheme('system'); };

  if ('addEventListener' in media) media.addEventListener('change', onChange);
  else legacyMedia.addListener(onChange);

  return () => {
    if ('removeEventListener' in media) media.removeEventListener('change', onChange);
    else legacyMedia.removeListener(onChange);
  };
}
