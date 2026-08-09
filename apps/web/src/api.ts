export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.message ?? '请求失败，请稍后重试。', data.code ?? 'REQUEST_FAILED', response.status);
  return data as T;
}
