// Bridge-less transport: signs in to TherapyPortal server-side with a cookie
// jar, no browser involved. Selected when an email and password are configured.
//
// Sign-in (from the portal's own login.js / dobauthenticationviewer.js):
//   1. GET  /p/<code>/login/                     → session cookies, siteVersion, PracticeID
//   2. POST /portal/practice/login/processlogin.aspx
//      email=<email>&password=<SHA-512 of the NFC-normalised password, UPPERCASE hex>
//      &doCookieCheck=false (+ correlationid, tnv, portalpractice)
//      → { IsSuccessful, ErrorMessage, NeedsDobAuthentication, … }
//   3. only when NeedsDobAuthentication: the same endpoint again with
//      dob=<MM/DD/YYYY>&authenticationAttempt=0&isExpiredToken=<from step 2>.
//      The portal disables the form after a few wrong dates, so this is tried
//      ONCE, from THERAPYPORTAL_DOB, never guessed and never retried.
//   4. GET  /p/<code>/  → the signed-in page, whose TNRAC/siteVersion/PracticeID
//      every later data call carries.
//
// A rejected sign-in is NEVER retried: it is a PermanentTransportError, which
// the session manager caches. The password and DOB are registered with the
// scrubber in the constructor, so even a half-finished sign-in cannot leak them.
//
// Verified: the endpoint, field names and hashing (a deliberately nonexistent
// @example.com account is answered `{"IsSuccessful":false,"ErrorMessage":"The
// email and password you entered did not match any account…"}`, i.e. the client
// identity is accepted). A real account's success response and the DOB step are
// not verified yet — see docs/THERAPYPORTAL-API.md.

import { createHash } from 'node:crypto';
import { CookieJar, McpToolError } from '@chrischall/mcp-utils';
import { createCookieSessionManager, type CookieSessionManager } from '@chrischall/mcp-utils/session';
import { SecretScrubber } from './secrets.js';
import {
  PORTAL_ORIGIN,
  PermanentTransportError,
  callBody,
  callPath,
  isSignedOut,
  parsePageTokens,
  type DownloadedFile,
  type FetchResult,
  type PageTokens,
  type TherapyPortalTransport,
} from './transport.js';

const USER_AGENT = 'Mozilla/5.0';
const API_HINT = 'The portal sign-in flow may have changed; see docs/THERAPYPORTAL-API.md.';
const SITE_VERSION_RE = /siteVersion\s*=\s*"([^"]+)"/;
const PRACTICE_ID_RE = /"PracticeID"\s*:\s*(\d+)/;

interface Session {
  jar: CookieJar;
  tokens: PageTokens;
}

export interface ServerTransportOptions {
  /** The validated practice code (see parsePracticeCode). */
  practice: string;
  email: string | undefined;
  password: string | undefined;
  /** MM/DD/YYYY, only needed when the portal asks for a date of birth at sign-in. */
  dob: string | undefined;
  scrubber: SecretScrubber;
  /** Injectable for tests; the real `fetch` otherwise. */
  fetchImpl?: typeof fetch;
}

/** The password exactly as the portal's PasswordHasher sends it. */
export function hashPassword(password: string): string {
  return createHash('sha512').update(password.normalize(), 'utf8').digest('hex').toUpperCase();
}

/**
 * A date of birth as the portal's DOB field formats it, MM/DD/YYYY. Accepts
 * M/D/YYYY (what people type) and ISO YYYY-MM-DD; anything else is refused
 * before it is sent, because the portal counts wrong dates.
 */
export function normalizeDob(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  let [mm, dd, yyyy] = m === null ? [] : [m[1], m[2], m[3]];
  if (m === null) {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m === null) return undefined;
    [yyyy, mm, dd] = [m[1], m[2], m[3]];
  }
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${yyyy}`;
}

/** The `Content-Disposition` filename, when there is one. */
function dispositionName(header: string | null): string | undefined {
  if (header === null) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star !== undefined) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      // fall through to the plain form
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

export class ServerTransport implements TherapyPortalTransport {
  private readonly sessions: CookieSessionManager<Session, FetchResult>;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ServerTransportOptions) {
    /* v8 ignore next */
    this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    // Up front, not after a successful sign-in: a failed one can still raise an
    // error, and these must already be redacted from it.
    opts.scrubber.add(opts.password, opts.dob);
    if (opts.dob !== undefined) opts.scrubber.add(normalizeDob(opts.dob));
    if (opts.password !== undefined) opts.scrubber.add(hashPassword(opts.password));
    this.sessions = createCookieSessionManager<Session, FetchResult>({
      login: () => this.login(),
      isExpired: (res) => isSignedOut(res),
      isPermanentError: (err) => err instanceof PermanentTransportError,
    });
  }

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  status(): unknown {
    return { mode: 'server', signedIn: this.sessions.current !== undefined };
  }

  call(path: string, fields: Record<string, string> = {}): Promise<FetchResult> {
    return this.sessions.withSession((s) =>
      this.post(s.jar, callPath(path), callBody(fields, s.tokens)),
    );
  }

  async download(path: string): Promise<DownloadedFile> {
    const res = await this.sessions.withSession(async (s) => {
      const r = await this.raw(s.jar, 'GET', this.practiceUrl(path), { Accept: '*/*' });
      const contentType = r.headers.get('content-type') ?? undefined;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const texty = contentType === undefined || /text\/html/i.test(contentType);
      return {
        status: r.status,
        url: r.headers.get('location') ?? undefined,
        // A short decoded prefix only for an HTML answer, so isSignedOut can see a
        // Log In page; real file bytes leave it empty.
        body: texty ? Buffer.from(bytes.subarray(0, 4096)).toString('utf8') : '',
        bytes,
        contentType,
        fileName: dispositionName(r.headers.get('content-disposition')),
      };
    });
    const file = res as FetchResult & {
      bytes: Uint8Array;
      contentType?: string;
      fileName?: string;
    };
    if (file.status !== 200 || /text\/html/i.test(file.contentType ?? '')) {
      throw new McpToolError(`The portal did not return the file (HTTP ${file.status}).`, {
        hint: 'The document may have been removed, or the id is wrong; list the documents again.',
      });
    }
    return { kind: 'bytes', bytes: file.bytes, contentType: file.contentType, fileName: file.fileName };
  }

  private practiceUrl(path: string): string {
    return `${PORTAL_ORIGIN}/p/${this.opts.practice}/${path.replace(/^\/+/, '')}`;
  }

  // Every fetch goes to the one portal origin, built here from a fixed base —
  // redirects are never followed with the cookie jar attached.
  private async raw(
    jar: CookieJar,
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    /* v8 ignore next 3 */
    if (new URL(url).origin !== PORTAL_ORIGIN) {
      throw new McpToolError('Refusing a request outside therapyportal.com.', { hint: API_HINT });
    }
    const res = await this.doFetch(url, {
      method,
      redirect: 'manual',
      headers: { Cookie: jar.header(), 'User-Agent': USER_AGENT, ...headers },
      body,
    });
    jar.absorb(res.headers);
    return res;
  }

  private async get(jar: CookieJar, url: string): Promise<FetchResult> {
    const res = await this.raw(jar, 'GET', url, { Accept: 'text/html' });
    return { status: res.status, body: await res.text(), url: res.headers.get('location') ?? undefined };
  }

  private async post(jar: CookieJar, path: string, body: string): Promise<FetchResult> {
    const res = await this.raw(
      jar,
      'POST',
      `${PORTAL_ORIGIN}${path}`,
      {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
      },
      body,
    );
    return { status: res.status, body: await res.text(), url: res.headers.get('location') ?? undefined };
  }

  private async login(): Promise<Session> {
    const { email, password, dob } = this.opts;
    if (email === undefined || password === undefined) {
      throw new PermanentTransportError(
        'THERAPYPORTAL_EMAIL and THERAPYPORTAL_PASSWORD are required for server-side sign-in.',
        {
          hint:
            'Set both in the environment (or a .env), or use THERAPYPORTAL_TRANSPORT=fetchproxy ' +
            'to relay through a signed-in browser tab.',
          kind: 'no_credential',
        },
      );
    }

    const jar = new CookieJar();
    const page = await this.get(jar, this.practiceUrl('login/'));
    const tnv = SITE_VERSION_RE.exec(page.body)?.[1];
    const practiceId = PRACTICE_ID_RE.exec(page.body)?.[1];
    if (page.status !== 200 || tnv === undefined || practiceId === undefined) {
      throw new PermanentTransportError(
        `Could not open the sign-in page for practice "${this.opts.practice}".`,
        { hint: 'Check THERAPYPORTAL_PRACTICE: it is the code after /p/ in your portal URL.' },
      );
    }
    const base = { correlationid: '', tnv, portalpractice: practiceId };
    const send = async (fields: Record<string, string>): Promise<Record<string, unknown>> => {
      const res = await this.post(
        jar,
        '/portal/practice/login/processlogin.aspx?msg=1',
        new URLSearchParams({ ...fields, ...base, correlationid: crypto.randomUUID() }).toString(),
      );
      return this.parseLoginJson(res);
    };

    const hint =
      'Check THERAPYPORTAL_EMAIL and THERAPYPORTAL_PASSWORD. Nothing retries automatically, so ' +
      'a wrong password is never resubmitted.';
    let result = await send({ email, password: hashPassword(password), doCookieCheck: 'false' });
    if (result.IsSuccessful !== true) {
      throw new PermanentTransportError(this.portalMessage(result, 'TherapyPortal did not accept the email and password.'), {
        hint,
        kind: 'credential_rejected',
      });
    }
    if (result.NeedsDobAuthentication === true) {
      if (dob === undefined) {
        throw new PermanentTransportError(
          'TherapyPortal asks for a date of birth to finish signing in.',
          {
            hint:
              'Set THERAPYPORTAL_DOB to the date the portal asks for, as MM/DD/YYYY. It is tried ' +
              'once: the portal locks the check after a few wrong dates.',
            kind: 'no_credential',
          },
        );
      }
      const formatted = normalizeDob(dob);
      if (formatted === undefined) {
        throw new PermanentTransportError('THERAPYPORTAL_DOB is not a date.', {
          hint: 'Set it as MM/DD/YYYY (e.g. 01/31/1980). Nothing was sent.',
        });
      }
      result = await send({
        authenticationAttempt: '0',
        dob: formatted,
        isExpiredToken: String(result.IsExpiredToken === true),
      });
      if (result.IsSuccessful !== true) {
        throw new PermanentTransportError(
          this.portalMessage(result, 'TherapyPortal did not accept the date of birth.'),
          {
            hint:
              'Check THERAPYPORTAL_DOB (MM/DD/YYYY). It is not retried: the portal locks the check ' +
              'after a few wrong dates.',
            kind: 'credential_rejected',
          },
        );
      }
    }

    const home = await this.get(jar, this.practiceUrl(''));
    const tokens = parsePageTokens(home.body);
    if (tokens === undefined) {
      throw new McpToolError('Signed in to TherapyPortal but the portal page is not signed in.', {
        hint: API_HINT,
      });
    }
    this.opts.scrubber.add(tokens.tnrac);
    return { jar, tokens };
  }

  /** The portal's own error sentence, which never echoes the password. */
  private portalMessage(result: Record<string, unknown>, fallback: string): string {
    const msg = result.ErrorMessage;
    return typeof msg === 'string' && msg.trim() !== '' ? `TherapyPortal: ${msg.trim()}` : fallback;
  }

  private parseLoginJson(res: FetchResult): Record<string, unknown> {
    if (res.status !== 200 || !res.body.trimStart().startsWith('{')) {
      throw new McpToolError(
        `TherapyPortal sign-in did not return the expected response (HTTP ${res.status}).`,
        { hint: 'The portal may be unavailable; retry shortly.' },
      );
    }
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      throw new McpToolError('TherapyPortal sign-in returned a response that could not be parsed.', {
        hint: 'The portal may be unavailable; retry shortly.',
      });
    }
  }
}
