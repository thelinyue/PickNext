import { describe, expect, it, vi } from 'vitest';
import { LoginRateLimiter } from './login-rate-limit.js';

describe('登录失败限流', () => {
  it('达到失败阈值后拒绝，成功后清除窗口', () => {
    const limiter = new LoginRateLimiter(2, 60_000);
    limiter.failed('ip|user');
    expect(limiter.check('ip|user').allowed).toBe(true);
    limiter.failed('ip|user');
    expect(limiter.check('ip|user').allowed).toBe(false);
    limiter.succeeded('ip|user');
    expect(limiter.check('ip|user').allowed).toBe(true);
  });

  it('窗口过期后允许重新尝试', () => {
    vi.useFakeTimers();
    const limiter = new LoginRateLimiter(1, 1_000);
    limiter.failed('key');
    expect(limiter.check('key').allowed).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(limiter.check('key').allowed).toBe(true);
    vi.useRealTimers();
  });
});
