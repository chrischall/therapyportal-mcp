import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PORT, FetchproxyTransport } from '../src/transport-fetchproxy.js';
import { loginPage, signedInPage } from './_tools.js';

type Init = { method: string; path: string; headers?: Record<string, string>; body?: string };

function fakeInner(answer: (init: Init) => { status: number; body: string }) {
  const fetched: Init[] = [];
  let opts: Record<string, unknown> = {};
  const inner = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    status: vi.fn(() => ({ role: 'host' })),
    runProbe: vi.fn(async () => ({ ok: true })),
    fetch: vi.fn(async (init: Init) => {
      fetched.push(init);
      return { ...answer(init), url: undefined };
    }),
    server: { download: vi.fn(async () => ({ path: '/Users/x/Downloads/Form.pdf', bytes: 10, mime: 'application/pdf' })) },
  };
  const createInner = ((o: Record<string, unknown>) => {
    opts = o;
    return inner;
  }) as never;
  return { inner, fetched, createInner, opts: () => opts };
}

describe('FetchproxyTransport', () => {
  it('declares fetch + download on therapyportal.com at the fleet port', () => {
    const f = fakeInner(() => ({ status: 200, body: '' }));
    new FetchproxyTransport({ practice: 'example777', version: '1.0.0', createInner: f.createInner });
    expect(f.opts()).toMatchObject({
      port: DEFAULT_PORT,
      serverName: 'therapyportal-mcp',
      domains: ['therapyportal.com'],
      defaultSubdomain: 'www',
      capabilities: ['fetch', 'download'],
    });
  });

  it('boots tokens from the practice page once, then posts with them', async () => {
    const f = fakeInner((i) => (i.method === 'GET' ? { status: 200, body: signedInPage() } : { status: 200, body: '[]' }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', port: 4000, createInner: f.createInner });
    await t.call('a', { k: 'v' });
    await t.call('b');
    expect(f.fetched.map((i) => `${i.method} ${i.path}`)).toEqual([
      'GET /p/example777/',
      'POST /portal/practice/a.aspx?msg=1',
      'POST /portal/practice/b.aspx?msg=1',
    ]);
    const body = new URLSearchParams(f.fetched[1]!.body);
    expect(body.get('k')).toBe('v');
    expect(body.get('tnrac')).toBe('tok-abc');
    expect(f.fetched[1]!.headers?.['X-Requested-With']).toBe('XMLHttpRequest');
    expect(f.opts().port).toBe(4000);
  });

  it('answers 401 without posting when the tab is not signed in', async () => {
    const f = fakeInner(() => ({ status: 200, body: loginPage() }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    expect(await t.call('a')).toEqual({ status: 401, body: '' });
    expect(f.fetched).toHaveLength(1);
  });

  it('treats a non-200 page as not signed in', async () => {
    const f = fakeInner(() => ({ status: 500, body: signedInPage() }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    expect((await t.call('a')).status).toBe(401);
  });

  it('re-reads the page once when a cached token is refused', async () => {
    let posts = 0;
    const f = fakeInner((i) => {
      if (i.method === 'GET') return { status: 200, body: signedInPage({ tnrac: `t${f.fetched.length}` }) };
      posts++;
      return posts === 2 ? { status: 401, body: '' } : { status: 200, body: '[]' };
    });
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    await t.call('a');
    const res = await t.call('b');
    expect(res.status).toBe(200);
    expect(f.fetched.filter((i) => i.method === 'GET')).toHaveLength(2);
  });

  it('returns the refusal when the re-read page is signed out', async () => {
    let gets = 0;
    const f = fakeInner((i) => {
      if (i.method === 'GET') return { status: 200, body: ++gets === 1 ? signedInPage() : loginPage() };
      return { status: gets === 1 ? 200 : 401, body: '' };
    });
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    await t.call('a');
    // force the second POST to be refused
    f.inner.fetch.mockImplementationOnce(async (init: Init) => {
      f.fetched.push(init);
      return { status: 401, body: '', url: undefined };
    });
    expect((await t.call('b')).status).toBe(401);
  });

  it('does not retry a refusal on the very first boot', async () => {
    const f = fakeInner((i) => (i.method === 'GET' ? { status: 200, body: signedInPage() } : { status: 401, body: '' }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    expect((await t.call('a')).status).toBe(401);
    expect(f.fetched).toHaveLength(2);
  });

  it('downloads through the browser and reports the saved path', async () => {
    const f = fakeInner(() => ({ status: 200, body: '' }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    expect(await t.download('/document/download/E/')).toEqual({
      kind: 'saved',
      path: '/Users/x/Downloads/Form.pdf',
      size: 10,
      mimeType: 'application/pdf',
    });
    expect(f.inner.server.download).toHaveBeenCalledWith({
      url: 'https://www.therapyportal.com/p/example777/document/download/E/',
      timeoutMs: 120_000,
    });
  });

  it('delegates lifecycle, status and probes', async () => {
    const f = fakeInner(() => ({ status: 200, body: '' }));
    const t = new FetchproxyTransport({ practice: 'example777', version: '1', createInner: f.createInner });
    await t.start();
    await t.close();
    expect(t.status()).toEqual({ role: 'host' });
    await t.runProbe(async () => 'x', 'p');
    expect(f.inner.start).toHaveBeenCalled();
    expect(f.inner.close).toHaveBeenCalled();
    expect(f.inner.runProbe).toHaveBeenCalled();
  });
});
