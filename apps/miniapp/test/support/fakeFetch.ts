export type FakeResponse = { status: number; body?: unknown };
export type FakeRoute = (input: {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}) => FakeResponse;

/** A `fetch` double: records every call and answers from a handler; `body: null` means no JSON body. */
export function fakeFetch(handler: FakeRoute): {
  fetch: typeof fetch;
  calls: { method: string; path: string; headers: Headers; body: unknown }[];
} {
  const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const call = { method: init?.method ?? 'GET', path, headers, body };
    calls.push(call);
    const answer = handler(call);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.body === undefined ? {} : { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}
