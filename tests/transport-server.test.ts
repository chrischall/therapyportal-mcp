import { describe, expect, it } from 'vitest';
import { SecretScrubber } from '../src/secrets.js';
import { ServerTransport, hashPassword, normalizeDob } from '../src/transport-server.js';
import { PermanentTransportError } from '../src/transport.js';
import { loginPage, signedInPage } from './_tools.js';

const PASSWORD = 'synthetic-pass 1';

interface Seen {
  method: string;
  url: string;
  body: URLSearchParams;
  cookie: string;
}

/**
 * A fake portal: the login page sets a cookie; processlogin answers with the
 * queued login results in order; the practice page is signed in once a login
 * succeeded; data calls answer `data` (or 401 when `expired` is set).
 */
function fakePortal(opts: {
  logins: Array<Record<string, unknown>>;
  data?: (path: string) => Response;
  file?: () => Response;
  loginPageStatus?: number;
}) {
  const seen: Seen[] = [];
  let signedIn = false;
  const state = { expireNext: false };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    seen.push({ method: init?.method ?? 'GET', url, body, cookie: String((init?.headers as Record<string, string>)?.Cookie ?? '') });
    const u = new URL(url);
    if (u.pathname.endsWith('/login/')) {
      return new Response(loginPage(), { status: opts.loginPageStatus ?? 200, headers: { 'set-cookie': 'ASP.NET_SessionId=s1; Path=/' } });
    }
    if (u.pathname === '/portal/practice/login/processlogin.aspx') {
      const next = opts.logins.shift() ?? { IsSuccessful: false };
      if (next.IsSuccessful === true && next.NeedsDobAuthentication !== true) signedIn = true;
      if (body.has('dob') && next.IsSuccessful === true) signedIn = true;
      return new Response(JSON.stringify(next), { status: 200, headers: { 'set-cookie': 'access-token=a1; Path=/' } });
    }
    if (/^\/p\/[^/]+\/$/.test(u.pathname)) return new Response(signedIn ? signedInPage() : loginPage());
    if (u.pathname.startsWith('/portal/practice/')) {
      if (state.expireNext) {
        state.expireNext = false;
        signedIn = false;
        return new Response('<title>Error | TherapyPortal</title>', { status: 401 });
      }
      return opts.data?.(u.pathname) ?? new Response('[]');
    }
    if (opts.file) return opts.file();
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen, state };
}

function transport(portal: ReturnType<typeof fakePortal>, extra: Partial<ConstructorParameters<typeof ServerTransport>[0]> = {}) {
  const scrubber = new SecretScrubber();
  const t = new ServerTransport({
    practice: 'example777',
    email: 'parent@example.com',
    password: PASSWORD,
    dob: undefined,
    scrubber,
    fetchImpl: portal.fetchImpl,
    ...extra,
  });
  return { t, scrubber };
}

const logins = (seen: Seen[]) => seen.filter((s) => s.url.includes('processlogin'));

describe('hashPassword', () => {
  it('is the uppercase hex SHA-512 of the normalised password', () => {
    expect(hashPassword('abc')).toBe(
      'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
    );
    // NFC: a decomposed é hashes like the composed one.
    expect(hashPassword('é')).toBe(hashPassword('é'));
  });
});

describe('normalizeDob', () => {
  it('formats M/D/YYYY and ISO as MM/DD/YYYY', () => {
    expect(normalizeDob('9/1/1980')).toBe('09/01/1980');
    expect(normalizeDob(' 12-31-1980 ')).toBe('12/31/1980');
    expect(normalizeDob('1980-02-03')).toBe('02/03/1980');
  });
  it('refuses anything that is not a date', () => {
    expect(normalizeDob('1980')).toBeUndefined();
    expect(normalizeDob('13/01/1980')).toBeUndefined();
    expect(normalizeDob('01/32/1980')).toBeUndefined();
    expect(normalizeDob('0/10/1980')).toBeUndefined();
  });
});

describe('ServerTransport sign-in', () => {
  it('signs in with the hashed password, then calls with the page tokens', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true }], data: () => new Response('[{"x":1}]') });
    const { t } = transport(portal);
    const res = await t.call('billing/payments/getreceiptsforportaluser', { a: 'b' });
    expect(res).toMatchObject({ status: 200, body: '[{"x":1}]' });
    const [login] = logins(portal.seen);
    expect(login!.body.get('email')).toBe('parent@example.com');
    expect(login!.body.get('password')).toBe(hashPassword(PASSWORD));
    expect(login!.body.get('portalpractice')).toBe('777');
    expect(login!.body.get('tnv')).toBe('2026.1.1.1');
    expect(login!.cookie).toContain('ASP.NET_SessionId=s1');
    const data = portal.seen.at(-1)!;
    expect(data.url).toBe('https://www.therapyportal.com/portal/practice/billing/payments/getreceiptsforportaluser.aspx?msg=1');
    expect(data.body.get('a')).toBe('b');
    expect(data.body.get('tnrac')).toBe('tok-abc');
    expect(data.body.get('portalpractice')).toBe('777');
    expect(data.cookie).toContain('access-token=a1');
    expect(t.status()).toEqual({ mode: 'server', signedIn: true });
  });

  it('runs the date-of-birth step once with a normalised date', async () => {
    const portal = fakePortal({
      logins: [{ IsSuccessful: true, NeedsDobAuthentication: true, IsExpiredToken: false }, { IsSuccessful: true }],
    });
    const { t } = transport(portal, { dob: '9/1/1980' });
    await t.call('x');
    const [, dob] = logins(portal.seen);
    expect(dob!.body.get('dob')).toBe('09/01/1980');
    expect(dob!.body.get('authenticationAttempt')).toBe('0');
    expect(dob!.body.get('isExpiredToken')).toBe('false');
  });

  it('never resubmits a rejected password, and quotes the portal’s reason', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: false, ErrorMessage: 'Wrong password.' }] });
    const { t } = transport(portal);
    await expect(t.call('x')).rejects.toThrow(/TherapyPortal: Wrong password\./);
    await expect(t.call('x')).rejects.toBeInstanceOf(PermanentTransportError);
    expect(logins(portal.seen)).toHaveLength(1);
  });

  it('falls back to a generic message when the portal gives no reason', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: false }] });
    await expect(transport(portal).t.call('x')).rejects.toThrow(/did not accept the email and password/);
  });

  it('asks for THERAPYPORTAL_DOB when the portal wants one and it is unset', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true, NeedsDobAuthentication: true }] });
    await expect(transport(portal).t.call('x')).rejects.toThrow(/asks for a date of birth/);
    expect(logins(portal.seen)).toHaveLength(1);
  });

  it('refuses a malformed DOB without sending it', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true, NeedsDobAuthentication: true }] });
    await expect(transport(portal, { dob: 'last tuesday' }).t.call('x')).rejects.toThrow(/not a date/);
    expect(logins(portal.seen)).toHaveLength(1);
  });

  it('never retries a rejected DOB', async () => {
    const portal = fakePortal({
      logins: [{ IsSuccessful: true, NeedsDobAuthentication: true }, { IsSuccessful: false }],
    });
    const { t } = transport(portal, { dob: '01/02/1980' });
    await expect(t.call('x')).rejects.toThrow(/did not accept the date of birth/);
    await expect(t.call('x')).rejects.toThrow(/did not accept the date of birth/);
    expect(logins(portal.seen)).toHaveLength(2);
  });

  it('needs both email and password', async () => {
    const portal = fakePortal({ logins: [] });
    await expect(transport(portal, { email: undefined }).t.call('x')).rejects.toThrow(/are required/);
    expect(portal.seen).toHaveLength(0);
  });

  it('reports an unknown practice code', async () => {
    const portal = fakePortal({ logins: [], loginPageStatus: 404 });
    await expect(transport(portal).t.call('x')).rejects.toThrow(/sign-in page for practice "example777"/);
  });

  it('rejects a non-JSON or unparsable sign-in answer', async () => {
    const bad = (body: string, status = 200) => {
      const p = fakePortal({ logins: [] });
      const inner = p.fetchImpl;
      p.fetchImpl = (async (u: string, i?: RequestInit) =>
        String(u).includes('processlogin') ? new Response(body, { status }) : inner(u, i)) as typeof fetch;
      return transport(p).t.call('x');
    };
    await expect(bad('<html>')).rejects.toThrow(/expected response \(HTTP 200\)/);
    await expect(bad('{"x":', 200)).rejects.toThrow(/could not be parsed/);
    await expect(bad('{}', 500)).rejects.toThrow(/HTTP 500/);
  });

  it('fails clearly when the page is still signed out after sign-in', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true, NeedsDobAuthentication: true }, { IsSuccessful: true }] });
    // The DOB answer succeeds but the fake only signs in on a body carrying dob:
    // strip it so the practice page stays signed out.
    const inner = portal.fetchImpl;
    portal.fetchImpl = (async (u: string, i?: RequestInit) => {
      if (String(u).includes('processlogin') && typeof i?.body === 'string' && i.body.includes('dob=')) {
        return new Response('{"IsSuccessful":true}');
      }
      return inner(u, i);
    }) as typeof fetch;
    await expect(transport(portal, { dob: '01/02/1980' }).t.call('x')).rejects.toThrow(/page is not signed in/);
  });

  it('signs in again once when a call comes back 401', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true }, { IsSuccessful: true }] });
    const { t } = transport(portal);
    await t.call('x');
    portal.state.expireNext = true;
    const res = await t.call('x');
    expect(res.status).toBe(200);
    expect(logins(portal.seen)).toHaveLength(2);
  });

  it('registers the password, its hash, the DOB and the TNRAC with the scrubber', async () => {
    const portal = fakePortal({ logins: [{ IsSuccessful: true }] });
    const { t, scrubber } = transport(portal, { dob: '9/1/1980' });
    expect(scrubber.has(PASSWORD)).toBe(true);
    expect(scrubber.has(hashPassword(PASSWORD))).toBe(true);
    expect(scrubber.has('9/1/1980')).toBe(true);
    expect(scrubber.has('09/01/1980')).toBe(true);
    await t.call('x');
    expect(scrubber.has('tok-abc')).toBe(true);
    await t.start();
    await t.close();
  });

  it('constructs without a password', () => {
    const { scrubber } = transport(fakePortal({ logins: [] }), { password: undefined });
    expect(scrubber.size).toBe(0);
  });
});

describe('ServerTransport.download', () => {
  it('returns the bytes, type and Content-Disposition name', async () => {
    const portal = fakePortal({
      logins: [{ IsSuccessful: true }],
      file: () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Form A.pdf"' },
        }),
    });
    const { t } = transport(portal);
    const f = await t.download('/document/download/ENC/');
    expect(f).toMatchObject({ kind: 'bytes', contentType: 'application/pdf', fileName: 'Form A.pdf' });
    expect(portal.seen.at(-1)!.url).toBe('https://www.therapyportal.com/p/example777/document/download/ENC/');
  });

  it('prefers an RFC 5987 filename* and tolerates a bad escape', async () => {
    const make = (cd: string) =>
      fakePortal({
        logins: [{ IsSuccessful: true }],
        file: () => new Response('x', { headers: { 'content-type': 'application/pdf', 'content-disposition': cd } }),
      });
    const ok = await transport(make(`attachment; filename="a.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`)).t.download('f/');
    expect(ok).toMatchObject({ fileName: 'résumé.pdf' });
    const bad = await transport(make(`attachment; filename="plain.pdf"; filename*=UTF-8''%E0%A4%A.pdf`)).t.download('f/');
    expect(bad).toMatchObject({ fileName: 'plain.pdf' });
    const none = await transport(
      fakePortal({ logins: [{ IsSuccessful: true }], file: () => new Response('x', { headers: { 'content-type': 'application/pdf' } }) }),
    ).t.download('f/');
    expect(none).toMatchObject({ fileName: undefined });
  });

  it('rejects an HTML answer or a non-200 as no file', async () => {
    const html = fakePortal({ logins: [{ IsSuccessful: true }], file: () => new Response('<html>gone</html>', { headers: { 'content-type': 'text/html' } }) });
    await expect(transport(html).t.download('f/')).rejects.toThrow(/did not return the file \(HTTP 200\)/);
    const notFound = fakePortal({ logins: [{ IsSuccessful: true }], file: () => new Response('x', { status: 404, headers: { 'content-type': 'application/pdf' } }) });
    await expect(transport(notFound).t.download('f/')).rejects.toThrow(/HTTP 404/);
    const untyped = fakePortal({ logins: [{ IsSuccessful: true }], file: () => new Response(null, { status: 200, headers: {} }) });
    // No content-type at all: judged as possibly-HTML (body prefix decoded), but a 200 non-HTML is a file.
    await expect(transport(untyped).t.download('f/')).resolves.toMatchObject({ kind: 'bytes' });
  });
});
