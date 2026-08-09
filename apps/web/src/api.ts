export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly data: Record<string, unknown> = {}) { super(message); }
}

export const API_TIMEOUT_MS = 15_000;
export const isNetworkError = (reason: unknown) => reason instanceof ApiError && ['OFFLINE', 'NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(reason.code);

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ApiError('当前处于离线状态，请恢复网络后重试。', 'OFFLINE', 0);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, API_TIMEOUT_MS);
  const abort = () => controller.abort();
  options?.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      headers,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.message ?? '请求失败，请稍后重试。', data.code ?? 'REQUEST_FAILED', response.status, data);
    return data as T;
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    if (timedOut) throw new ApiError('请求超时，请检查网络后重试。', 'REQUEST_TIMEOUT', 0);
    if (controller.signal.aborted) throw new ApiError('请求已取消。', 'REQUEST_ABORTED', 0);
    throw new ApiError('网络连接失败，请检查网络后重试。', 'NETWORK_ERROR', 0);
  } finally {
    window.clearTimeout(timeout);
    options?.signal?.removeEventListener('abort', abort);
  }
}
