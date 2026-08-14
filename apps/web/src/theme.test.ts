import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, readThemeMode, setThemeMode } from './theme.js';

describe('应用主题偏好', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#f7f7fa">';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
    window.localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('没有保存偏好时使用自适应', () => {
    expect(readThemeMode()).toBe('system');
    applyTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#f7f7fa');
  });

  it('保存浅色和深色选择，并更新页面主题色', () => {
    setThemeMode('dark');
    expect(readThemeMode()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#111016');

    setThemeMode('light');
    expect(readThemeMode()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#f7f7fa');
  });

  it('切回自适应时移除显式主题属性', () => {
    setThemeMode('dark');
    setThemeMode('system');
    expect(readThemeMode()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
