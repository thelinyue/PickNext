interface FailureWindow {
  count: number;
  firstFailureAt: number;
}

/**
 * 单进程登录失败保护。PickNext 当前是单进程部署，因此内存窗口足够；
 * 多副本部署前必须把该状态迁移到共享存储。
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, FailureWindow>();

  constructor(private readonly maxFailures = 5, private readonly windowMs = 15 * 60 * 1000) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const value = this.failures.get(key);
    if (!value) return { allowed: true, retryAfterSeconds: 0 };
    const elapsed = Date.now() - value.firstFailureAt;
    if (elapsed >= this.windowMs) {
      this.failures.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (value.count < this.maxFailures) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil((this.windowMs - elapsed) / 1000) };
  }

  failed(key: string): void {
    const now = Date.now();
    const value = this.failures.get(key);
    if (!value || now - value.firstFailureAt >= this.windowMs) {
      this.failures.set(key, { count: 1, firstFailureAt: now });
      return;
    }
    value.count += 1;
  }

  succeeded(key: string): void {
    this.failures.delete(key);
  }
}
