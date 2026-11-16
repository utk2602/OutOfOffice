export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class LocalClient {
  constructor(readonly baseUrl: string, private readonly token: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') throw new Error('The CLI only connects to a local HTTP API.');
  }
  async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    if (!/^\/(api\/v1\/|health\/)/.test(path) || path.includes('..') || path.includes('\\')) throw new Error('Invalid API path.');
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method, headers: { ...headers, Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new ApiError(response.status, value.error?.code ?? 'REQUEST_FAILED', value.error?.message ?? 'The local API request failed.');
    }
    return response;
  }
  async json<T = any>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    return (await this.request(path, method, body, headers)).json() as Promise<T>;
  }
}
