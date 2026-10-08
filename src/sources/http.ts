/**
 * The one way referpipe talks to the outside: a timeout, a user agent that
 * says who is asking, and two retries with backoff on the failures worth
 * retrying. Copied from jobpipe, with headers and plain-text reads added.
 */

// Plain and honest. Overpass answers a Mozilla-style agent with 406.
export const USER_AGENT = 'referpipe/0.1 (+https://webcraftmn.com)';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, detail = '') { super(`http ${status}${detail ? `: ${detail}` : ''}`); this.status = status; }
}

export type RequestInit = {
  method?: string; body?: unknown; accept?: string; timeoutMs?: number; retries?: number;
  headers?: Record<string, string>;
  /** form-encoded body instead of JSON (Overpass wants this). */
  form?: Record<string, string>;
};

/**
 * One request, retried on network errors, 429 and 5xx. Any other 4xx is an
 * answer, and asking again will not change it.
 */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const { method = init.body || init.form ? 'POST' : 'GET', body, form, accept = 'application/json',
    timeoutMs = 30_000, retries = 2, headers = {} } = init;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept, 'user-agent': USER_AGENT,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return res;
      if (attempt >= retries || (res.status < 500 && res.status !== 429)) {
        throw new HttpError(res.status, (await res.text().catch(() => '')).slice(0, 300));
      }
    } catch (err) {
      if (err instanceof HttpError || attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
}

export async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  return (await request(url, init)).json();
}
