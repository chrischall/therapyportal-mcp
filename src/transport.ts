// The transport surface the client talks through, plus the value types and
// errors shared by both transports and the client.
//
// TherapyPortal (the TherapyNotes client portal) is ASP.NET. Every data call is
// a form POST to `/portal/practice/<area>/<verb>.aspx?msg=<n>`, and the page's
// own AJAX layer appends four fields to every one of them:
//
//   tnrac           the anti-forgery value of the practice page's <input id="TNRAC">
//   tnv             the page's `siteVersion` (a stale one is answered 409)
//   portalpractice  the NUMERIC `userInfo.PracticeID` — not the URL's practice code.
//                   Without it every endpoint answers 404 "Page Not Found".
//   correlationid   any uuid4
//
// Both transports therefore "boot" from the signed-in practice page
// (`GET /p/<code>/`) to read those values, then inject them into each call. A
// transport owns that, plus cookies or the bridge and re-sign-in on expiry; it
// returns a raw `{ status, body }` pair. Parsing and projection live in the client.

import { McpToolError } from '@chrischall/mcp-utils';

/** The raw result of one request. `url` is the `Location` header on a redirect. */
export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

/** A downloaded file: bytes in hand (server transport) or already saved by the browser (bridge). */
export type DownloadedFile =
  | { kind: 'bytes'; bytes: Uint8Array; contentType?: string; fileName?: string }
  | { kind: 'saved'; path: string; size: number; mimeType?: string };

/** What the client needs of a transport — faked wholesale in tests. */
export interface TherapyPortalTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  /** A diagnostic snapshot for the healthcheck tool; shape varies by transport. */
  status(): unknown;
  /**
   * POST one data call, `/portal/practice/<path>.aspx`, with `fields` plus the
   * four page-derived fields. `path` has no leading slash and no `.aspx`.
   */
  call(path: string, fields?: Record<string, string>): Promise<FetchResult>;
  /**
   * GET a file under the practice's `/p/<code>/` tree (`path` is relative to
   * it, e.g. `document/download/<id>/`).
   */
  download(path: string): Promise<DownloadedFile>;
}

/** The values a data call needs, read from the signed-in practice page. */
export interface PageTokens {
  tnrac: string;
  tnv: string;
  practiceId: string;
}

const TNRAC_INPUT_RE = /<input\b[^>]*\bid="TNRAC"[^>]*>/i;
const VALUE_RE = /\bvalue="([^"]*)"/i;
const SITE_VERSION_RE = /siteVersion\s*=\s*"([^"]+)"/;
const PRACTICE_ID_RE = /"PracticeID"\s*:\s*(\d+)/;
// A signed-in page's userInfo carries the portal user's numeric "ID"; the
// anonymous public page's carries none (and an empty Email).
const USER_ID_RE = /userInfo\s*=\s*\{[^;]*?"ID"\s*:\s*\d+/;

/**
 * Read the data-call tokens from the practice page, or `undefined` when the
 * page is not a signed-in one. The anonymous public page has no TNRAC input and
 * no user id, so either missing means "not signed in".
 */
export function parsePageTokens(html: string): PageTokens | undefined {
  const input = TNRAC_INPUT_RE.exec(html)?.[0];
  const tnrac = input === undefined ? undefined : VALUE_RE.exec(input)?.[1];
  const tnv = SITE_VERSION_RE.exec(html)?.[1];
  const practiceId = PRACTICE_ID_RE.exec(html)?.[1];
  if (!tnrac || tnv === undefined || practiceId === undefined || !USER_ID_RE.test(html)) {
    return undefined;
  }
  return { tnrac, tnv, practiceId };
}

/** The form body for one data call: the caller's fields, then the page-derived four. */
export function callBody(fields: Record<string, string>, tokens: PageTokens): string {
  return new URLSearchParams({
    ...fields,
    correlationid: crypto.randomUUID(),
    tnrac: tokens.tnrac,
    tnv: tokens.tnv,
    portalpractice: tokens.practiceId,
  }).toString();
}

/** The request path for a data call. `msg` is the page's request counter; any value works. */
export function callPath(path: string): string {
  return `/portal/practice/${path.replace(/^\/+/, '')}.aspx?msg=1`;
}

/**
 * Does this response mean "not signed in"? A data call without a live session
 * is answered 401 (an "Error | TherapyPortal" page); a page fetch is
 * redirected to, or served, the practice's Log In page.
 */
export function isSignedOut(res: { status: number; body: string; url?: string }): boolean {
  if (res.status === 401) return true;
  if (res.status >= 300 && res.status < 400) return /\/login\b/i.test(res.url ?? '');
  return /<title>\s*Log In\s*\|/i.test(res.body);
}

/**
 * A failure that MUST NOT be retried — a rejected password or date of birth,
 * a missing credential, or an invalid practice code. Cached by the session
 * manager so repeated tool calls do not each resubmit the password.
 */
export class PermanentTransportError extends McpToolError {
  constructor(message: string, opts: ConstructorParameters<typeof McpToolError>[1]) {
    super(message, opts);
    this.name = 'PermanentTransportError';
  }
}

const PRACTICE_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * Validate `THERAPYPORTAL_PRACTICE`: the code after `/p/` in the portal URL. A
 * full portal URL is accepted too and reduced to its code, since that is what
 * people copy. Returned lowercased: the portal's own links use it that way.
 */
export function parsePracticeCode(raw: string | undefined): string {
  const hint =
    'Set THERAPYPORTAL_PRACTICE to the code after /p/ in your portal URL, e.g. for ' +
    'https://www.therapyportal.com/p/example12345/ use example12345.';
  if (raw === undefined || raw.trim() === '') {
    throw new PermanentTransportError('THERAPYPORTAL_PRACTICE is required.', {
      hint,
      kind: 'no_credential',
    });
  }
  let code = raw.trim();
  const fromUrl = /^https:\/\/www\.therapyportal\.com\/p\/([^/?#]+)/i.exec(code);
  if (fromUrl !== null) code = fromUrl[1];
  if (!PRACTICE_CODE_RE.test(code)) {
    throw new PermanentTransportError(`THERAPYPORTAL_PRACTICE is not a practice code: ${raw}`, {
      hint,
    });
  }
  return code.toLowerCase();
}

/** The one portal origin. Every practice lives under it at `/p/<code>/`. */
export const PORTAL_ORIGIN = 'https://www.therapyportal.com';
