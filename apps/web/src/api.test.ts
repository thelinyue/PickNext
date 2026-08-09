import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, API_TIMEOUT_MS } from './api.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('API 弱网错误', () => {
  it('离线时立即返回可读错误', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(api('/api/test')).rejects.toMatchObject({ code: 'OFFLINE', status: 0 });
  });

  it('超过十五秒时中止请求并返回超时错误', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_path, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const request = api('/api/test');
    const assertion = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', status: 0 });
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    await assertion;
  });
});
