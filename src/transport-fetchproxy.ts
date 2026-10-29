// Adapter letting @fetchproxy/server satisfy TherapyPortalTransport.
//
// Requests run inside the user's own signed-in portal tab, so this server never
// holds the session cookie or any credential. The data-call tokens (TNRAC,
// siteVersion, PracticeID) are read from the signed-in practice page fetched
// through that same tab, cached, and re-read once when a call is refused — the
// portal can rotate TNRAC while the browser session itself stays alive.
//
// Downloads use the bridge's `download` verb: the browser fetches the file with
// its own cookies and saves it to its download folder, and the tool reports
// that path. (The bridge relays response bodies as text, so it cannot hand the
// bytes back.)
//
// The import of @fetchproxy/server behind createFetchproxyTransport only loads
// when this transport is constructed, which index.ts does solely in fetchproxy
// mode.

import {
  createFetchproxyTransport,
  type BridgeProbeResult,
  type FetchproxyTransport as InnerTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import {
  PORTAL_ORIGIN,
  callBody,
  callPath,
  parsePageTokens,
  type DownloadedFile,
  type FetchResult,
  type PageTokens,
  type TherapyPortalTransport,
} from './transport.js';

/**
 * The whole fetchproxy fleet shares this concentrator port — the ContextMint
 * Bridge extension dials this one port and servers host/peer-elect on it.
 */
export const DEFAULT_PORT = 37_149;

/** The longest a download may take; the portal renders forms to PDF on demand. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface FetchproxyTransportOptions {
  /** The validated practice code. */
  practice: string;
  version: string;
  port?: number;
  /** Injectable for tests; the real factory otherwise. */
  createInner?: typeof createFetchproxyTransport<InnerTransport>;
}

export class FetchproxyTransport implements TherapyPortalTransport {
  private readonly inner: InnerTransport;
  private readonly practice: string;
  private tokens?: PageTokens;

  constructor(opts: FetchproxyTransportOptions) {
    this.practice = opts.practice;
    /* v8 ignore next */
    const factory = opts.createInner ?? createFetchproxyTransport;
    this.inner = factory({
      port: opts.port ?? DEFAULT_PORT,
      serverName: 'therapyportal-mcp',
      version: opts.version,
      logListening: true,
      domains: ['therapyportal.com'],
      defaultSubdomain: 'www',
      capabilities: ['fetch', 'download'],
      captureWindowMs: DOWNLOAD_TIMEOUT_MS,
    });
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  status(): ReturnType<InnerTransport['status']> {
    return this.inner.status();
  }

  /** Run a healthcheck probe through the bridge (drives the bridge arm). */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string,
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }

  /** GET the signed-in practice page through the tab. */
  async page(): Promise<FetchResult> {
    const res = await this.inner.fetch({ method: 'GET', path: `/p/${this.practice}/` });
    return { status: res.status, body: res.body, url: res.url };
  }

  async call(path: string, fields: Record<string, string> = {}): Promise<FetchResult> {
    const first = this.tokens === undefined;
    const tokens = await this.boot(false);
    // No tokens means the tab is not signed in: hand back a 401 so the client
    // reports it exactly as it reports a refused call.
    if (tokens === undefined) return { status: 401, body: '' };
    const res = await this.post(path, fields, tokens);
    if (res.status !== 401 || first) return res;
    // A cached TNRAC can go stale while the browser session lives on: re-read
    // the page once and retry. Reads only, so the retry is safe.
    const fresh = await this.boot(true);
    return fresh === undefined ? res : this.post(path, fields, fresh);
  }

  async download(path: string): Promise<DownloadedFile> {
    const url = `${PORTAL_ORIGIN}/p/${this.practice}/${path.replace(/^\/+/, '')}`;
    const saved = await this.inner.server.download({ url, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    return { kind: 'saved', path: saved.path, size: saved.bytes, mimeType: saved.mime };
  }

  private async boot(force: boolean): Promise<PageTokens | undefined> {
    if (this.tokens !== undefined && !force) return this.tokens;
    const page = await this.page();
    this.tokens = page.status === 200 ? parsePageTokens(page.body) : undefined;
    return this.tokens;
  }

  private async post(
    path: string,
    fields: Record<string, string>,
    tokens: PageTokens,
  ): Promise<FetchResult> {
    const res = await this.inner.fetch({
      method: 'POST',
      path: callPath(path),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: callBody(fields, tokens),
    });
    return { status: res.status, body: res.body, url: res.url };
  }
}
