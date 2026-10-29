import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DOWNLOAD_ROOTS,
  InlineDownloadIO,
  NodeDownloadIO,
  downloadRoots,
  makeDownloadIO,
} from '../src/download-io.js';

const temps: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'therapyportal-dl-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('NodeDownloadIO', () => {
  it('writes the bytes to the per-call dir and reports the path', () => {
    const dir = tmp();
    const io = new NodeDownloadIO([dir]);
    const out = io.deliver({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.savedTo).toBeDefined();
    expect(out.savedTo!.endsWith('.pdf')).toBe(true);
    expect(out.size).toBe(4);
    expect([...readFileSync(out.savedTo!)]).toEqual([1, 2, 3, 4]);
    expect(out.base64).toBeUndefined();
  });

  it('derives the extension from the MIME type when the name has none', () => {
    const dir = tmp();
    const out = new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: 'scan',
      mimeType: 'image/png',
      dest: dir,
    });
    expect(out.savedTo!.endsWith('.png')).toBe(true);
  });

  it('falls back to the MIME extension when the name extension is unsafe', () => {
    const dir = tmp();
    const out = new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: 'weird.name!',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.savedTo!.endsWith('.pdf')).toBe(true);
  });

  it('falls back to a default stem when the name has none', () => {
    const dir = tmp();
    const out = new NodeDownloadIO([dir]).deliver({
      bytes: new Uint8Array([0]),
      fileName: '',
      mimeType: 'application/pdf',
      dest: dir,
    });
    expect(out.savedTo!.replace(/\\/g, '/')).toMatch(/\/download\.pdf$/);
  });

  it('refuses a per-call dir outside the allowed roots', () => {
    const allowed = tmp();
    const outside = tmp();
    const io = new NodeDownloadIO([allowed]);
    expect(() =>
      io.deliver({ bytes: new Uint8Array([0]), fileName: 'x.pdf', dest: outside }),
    ).toThrow();
  });
});

describe('InlineDownloadIO', () => {
  it('returns the bytes as base64 when they fit', () => {
    const out = new InlineDownloadIO().deliver({
      bytes: new Uint8Array([65, 66, 67]),
      fileName: 'a.txt',
      mimeType: 'text/plain',
    });
    expect(out.savedTo).toBeUndefined();
    expect(out.base64).toBe(Buffer.from([65, 66, 67]).toString('base64'));
    expect(out.size).toBe(3);
    expect(out.tooLarge).toBeUndefined();
  });

  it('reports too-large instead of inlining past the cap', () => {
    const out = new InlineDownloadIO(2).deliver({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'big.bin',
    });
    expect(out.tooLarge).toBe(true);
    expect(out.base64).toBeUndefined();
    expect(out.size).toBe(3);
  });
});

describe('downloadRoots', () => {
  it('uses THERAPYPORTAL_OUTPUT_DIR as a delimiter list, trimmed', () => {
    expect(downloadRoots({ THERAPYPORTAL_OUTPUT_DIR: ` /a ${process.platform === 'win32' ? ';' : ':'} /b ` })).toEqual(
      ['/a', '/b'],
    );
  });

  it('treats a blank value as unset and falls back', () => {
    expect(downloadRoots({ THERAPYPORTAL_OUTPUT_DIR: '   ' })).toEqual(DEFAULT_DOWNLOAD_ROOTS);
  });

  it('uses $MCP_DATA_DIR/downloads when hosted and no output dir is set', () => {
    expect(downloadRoots({ MCP_DATA_DIR: '/data' })).toEqual([join('/data', 'downloads')]);
  });

  it('defaults to Downloads and Documents', () => {
    expect(downloadRoots({})).toEqual(DEFAULT_DOWNLOAD_ROOTS);
  });
});

describe('makeDownloadIO', () => {
  it('defaults to the disk-backed IO', () => {
    expect(makeDownloadIO({}).persistsFiles).toBe(true);
  });

  it('selects the inline IO when THERAPYPORTAL_INLINE_DOWNLOADS is truthy', () => {
    expect(makeDownloadIO({ THERAPYPORTAL_INLINE_DOWNLOADS: '1' }).persistsFiles).toBe(false);
  });
});
