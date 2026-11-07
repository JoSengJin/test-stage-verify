import { HttpError } from './errors.ts';

export interface RequestOptions {
  idempotencyKey?: string;
}

/** OrderService가 의존하는 협력 객체 계약. */
export interface HttpClient {
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  get<T>(path: string): Promise<T>;
}

export interface FetchHttpConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

/** 전역 fetch를 호출 시점에 사용하는 HttpClient 구현. */
export function createFetchHttpClient(config: FetchHttpConfig): HttpClient {
  async function request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    if (options?.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const res = await fetch(new URL(path, config.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new HttpError(res.status, data?.message ?? res.statusText);
    return data as T;
  }
  return {
    post: (path, body, options) => request('POST', path, body, options),
    get: (path) => request('GET', path),
  };
}
