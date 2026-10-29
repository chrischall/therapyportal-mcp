import { describe, expect, it } from 'vitest';
import {
  PermanentTransportError,
  callBody,
  callPath,
  isSignedOut,
  parsePageTokens,
  parsePracticeCode,
} from '../src/transport.js';
import { anonymousPage, loginPage, signedInPage } from './_tools.js';

describe('parsePageTokens', () => {
  it('reads TNRAC, siteVersion and the numeric PracticeID from a signed-in page', () => {
    expect(parsePageTokens(signedInPage({ tnrac: 'T1', tnv: '9.9', practiceId: 123 }))).toEqual({
      tnrac: 'T1',
      tnv: '9.9',
      practiceId: '123',
    });
  });

  it('treats the anonymous public page as not signed in', () => {
    expect(parsePageTokens(anonymousPage())).toBeUndefined();
  });

  it('treats the sign-in page as not signed in', () => {
    expect(parsePageTokens(loginPage())).toBeUndefined();
  });

  it('requires a non-empty TNRAC value', () => {
    expect(parsePageTokens(signedInPage({ tnrac: '' }))).toBeUndefined();
  });

  it('requires the user id even when a TNRAC is present', () => {
    const page = signedInPage().replace('"ID":424242,', '');
    expect(parsePageTokens(page)).toBeUndefined();
  });

  it('requires siteVersion and PracticeID', () => {
    expect(parsePageTokens(signedInPage().replace(/siteVersion = "[^"]+";/, ''))).toBeUndefined();
    expect(parsePageTokens(signedInPage().replace(/"PracticeID":\d+,/, ''))).toBeUndefined();
  });

  it('handles a TNRAC input with no value attribute', () => {
    expect(parsePageTokens(signedInPage().replace(/value="tok-abc"/, ''))).toBeUndefined();
  });
});

describe('callBody / callPath', () => {
  it('appends the four page-derived fields after the caller’s', () => {
    const body = new URLSearchParams(callBody({ request: '1' }, { tnrac: 'T', tnv: 'V', practiceId: '5' }));
    expect(body.get('request')).toBe('1');
    expect(body.get('tnrac')).toBe('T');
    expect(body.get('tnv')).toBe('V');
    expect(body.get('portalpractice')).toBe('5');
    expect(body.get('correlationid')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('builds the /portal/practice/<path>.aspx URL', () => {
    expect(callPath('billing/payments/getreceiptsforportaluser')).toBe(
      '/portal/practice/billing/payments/getreceiptsforportaluser.aspx?msg=1',
    );
    expect(callPath('/x')).toBe('/portal/practice/x.aspx?msg=1');
  });
});

describe('isSignedOut', () => {
  it('is true for 401, a redirect to login, and the Log In page', () => {
    expect(isSignedOut({ status: 401, body: '' })).toBe(true);
    expect(isSignedOut({ status: 302, body: '', url: '/p/example777/login/' })).toBe(true);
    expect(isSignedOut({ status: 200, body: loginPage() })).toBe(true);
  });

  it('is false for data and for an unrelated redirect', () => {
    expect(isSignedOut({ status: 200, body: '[]' })).toBe(false);
    expect(isSignedOut({ status: 302, body: '', url: '/p/example777/' })).toBe(false);
    expect(isSignedOut({ status: 302, body: '' })).toBe(false);
  });
});

describe('parsePracticeCode', () => {
  it('lowercases a bare code', () => {
    expect(parsePracticeCode(' Example777 ')).toBe('example777');
  });

  it('accepts a full portal URL', () => {
    expect(parsePracticeCode('https://www.therapyportal.com/p/Example777/documents/')).toBe('example777');
  });

  it('refuses missing and malformed values permanently', () => {
    expect(() => parsePracticeCode(undefined)).toThrow(PermanentTransportError);
    expect(() => parsePracticeCode('  ')).toThrow(/required/);
    expect(() => parsePracticeCode('a/b')).toThrow(/not a practice code/);
  });
});
