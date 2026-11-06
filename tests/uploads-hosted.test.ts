// The upload sources that work when this server is hosted (mcp-host): bytes
// inline as base64, and the blob store's upload slots (`therapyportal_upload_slot`
// mints a signed PUT URL; `blob_key` hands the uploaded object back).
//
// The blob store is the REAL mcp-utils client (`createBlobStore`) over a
// stubbed `fetch` that keeps objects in a Map — so key shape, signing and the
// GET/DELETE exchanges are the ones production makes.
//
// Every fixture is synthetic: invented names, ids and filler bytes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@chrischall/mcp-utils/export';
import { MAX_UPLOAD_BYTES, isHostedDeployment, registerUploadTools, type UploadToolOptions } from '../src/tools/uploads.js';
import { capture, gated, okJson, textOf, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5_000, 0x41)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4]);
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
const b64 = (b: Buffer) => b.toString('base64');
const sha = async (b: Buffer) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(b).digest('hex');
};

const CLIENTS = [{ Id: 101, FirstName: 'Robin', Nickname: '' }];
const PENDING = {
  PortalDocumentRequests: [
    {
      RequestId: 1,
      PatientId: 101,
      PortalDocuments: [
        { PortalDocumentId: 601, Title: 'Example request', PortalDocumentStatus: 1, IsUploadRequired: true, PatientSignatureRequired: false, PatientId: 101 },
      ],
    },
  ],
};

function portal(over: Record<string, FetchResult> = {}) {
  return (call: FakeCall): FetchResult => {
    if (over[call.path] !== undefined) return over[call.path]!;
    switch (call.path) {
      case 'document/getpatientsforportaluser':
        return okJson(CLIENTS);
      case 'documents/api/getportaluserdocumentrequestsbystatus':
        return okJson(PENDING);
      case 'SEGMENT':
        return { status: 200, body: '' };
      case 'document/stageduploadvalidation':
        return okJson({ FormAdvice: [] });
      case 'document/uploadportalresponse':
        return okJson({ FormAdvice: [] });
      default:
        throw new Error(`unexpected ${call.path}`);
    }
  };
}

// ---- an in-memory blob store behind a stubbed fetch -------------------------

const BASE = 'https://blobs.example.test/b/reg-1';
interface Stored { bytes: Uint8Array; type: string }
let objects: Map<string, Stored>;
let blobLog: string[];
let failDelete: boolean;

function keyOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/b\/reg-1\//, ''));
}

beforeEach(() => {
  objects = new Map();
  blobLog = [];
  failDelete = false;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = keyOf(url);
    blobLog.push(`${method} ${key}`);
    if (method === 'GET') {
      const o = objects.get(key);
      if (!o) return new Response('missing', { status: 404 });
      return new Response(o.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'content-type': o.type } });
    }
    if (method === 'DELETE') {
      if (failDelete) return new Response('nope', { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 405 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const store = (): BlobStore => createBlobStore({ baseUrl: BASE, signingKey: 'test-signing-key' });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-upload-hosted-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function rig(opts: Partial<UploadToolOptions> = {}, over: Record<string, FetchResult> = {}) {
  const { handlers, transport } = capture(
    ((server: never, client: never) =>
      registerUploadTools(server, client, { allowedRoots: [dir], blobStore: store, ...opts })) as never,
    portal(over),
  );
  const slot = async (args: Record<string, unknown>) =>
    JSON.parse(textOf(await handlers.get('therapyportal_upload_slot')!(args))) as Record<string, unknown>;
  return { transport, up: gated(handlers.get('therapyportal_upload_document')!, transport), slot };
}

/** Mint a slot and "PUT" bytes into it, as the caller's curl would. */
async function uploaded(r: ReturnType<typeof rig>, filename: string, bytes: Buffer): Promise<string> {
  const s = await r.slot({ filename });
  objects.set(s.blobKey as string, { bytes: new Uint8Array(bytes), type: s.mimeType as string });
  return s.blobKey as string;
}

const segmentBytes = (calls: FakeCall[]) =>
  Buffer.concat(calls.filter((c) => c.via === 'segment').map((c) => Buffer.from(c.body!, 'base64')));

describe('isHostedDeployment', () => {
  it('is true when mcp-host lent a data dir or a blob store, false otherwise', () => {
    expect(isHostedDeployment({ MCP_DATA_DIR: '/data' })).toBe(true);
    expect(isHostedDeployment({ MCP_BLOB_BASE_URL: BASE })).toBe(true);
    expect(isHostedDeployment({ MCP_DATA_DIR: '${MCP_DATA_DIR}' })).toBe(false);
    expect(isHostedDeployment({})).toBe(false);
  });
});

describe('therapyportal_upload_document — exactly one source', () => {
  it('refuses no source, and any two sources, before reading anything', async () => {
    const r = rig();
    await expect(r.up.raw({ portal_document_id: 601 })).rejects.toThrow(/exactly one of file_path, inline or blob_key/);
    await expect(
      r.up.raw({ portal_document_id: 601, file_path: join(dir, 'a.pdf'), inline: { filename: 'a.pdf', content_base64: b64(PDF) } }),
    ).rejects.toThrow(/exactly one of file_path, inline or blob_key/);
    await expect(
      r.up.raw({ portal_document_id: 601, inline: { filename: 'a.pdf', content_base64: b64(PDF) }, blob_key: 'uploads/x/y' }),
    ).rejects.toThrow(/exactly one/);
    expect(r.transport.calls).toEqual([]);
    expect(blobLog).toEqual([]);
  });

  it('when hosted, the refusal points at the slot flow', async () => {
    const r = rig({ hosted: true });
    await expect(r.up.raw({ portal_document_id: 601 })).rejects.toMatchObject({ hint: expect.stringMatching(/therapyportal_upload_slot/) });
  });
});

describe('therapyportal_upload_document — inline', () => {
  it('uploads strictly-decoded bytes, with the SHA-256 in the preview', async () => {
    const r = rig();
    const args = { portal_document_id: 601, inline: { filename: 'scan.pdf', content_base64: b64(PDF) } };
    const preview = await r.up.preview(args);
    expect(JSON.stringify(preview)).toContain(await sha(PDF));
    expect(preview.preview).toMatchObject({ willSend: { source: 'inline', file: { name: 'scan.pdf', type: 'application/pdf', size: PDF.length } } });
    expect(JSON.stringify(preview)).not.toContain(b64(PDF).slice(0, 200));
    const out = await r.up.confirmed(args);
    expect(out).toMatchObject({ uploaded: true, file: { name: 'scan.pdf', size: PDF.length } });
    expect(segmentBytes(r.transport.calls).equals(PDF)).toBe(true);
    const req = JSON.parse(r.transport.calls.find((c) => c.via === 'send')!.fields.request!);
    expect(req).toMatchObject({ FileName: 'scan.pdf', MimeType: 'application/pdf', FileSize: PDF.length });
  });

  it('sends a .docx with its Office MIME type and strips |<>" from the name', async () => {
    const r = rig();
    await r.up.confirmed({ portal_document_id: 601, inline: { filename: 'a"b.docx', content_base64: b64(DOCX) } });
    const req = JSON.parse(r.transport.calls.find((c) => c.via === 'send')!.fields.request!);
    expect(req).toMatchObject({ FileName: 'ab.docx', MimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  });

  it('accepts a matching mime_type and refuses one that contradicts the extension', async () => {
    const r = rig();
    await expect(
      r.up.preview({ portal_document_id: 601, inline: { filename: 'p.png', content_base64: b64(PNG), mime_type: 'image/PNG; charset=binary' } }),
    ).resolves.toMatchObject({ confirmToken: expect.any(String) });
    await expect(
      r.up.raw({ portal_document_id: 601, inline: { filename: 'p.png', content_base64: b64(PNG), mime_type: 'application/pdf' } }),
    ).rejects.toThrow(/mime_type application\/pdf does not match \.png/);
    await expect(
      r.up.raw({ portal_document_id: 601, inline: { filename: 'p.png', content_base64: b64(PNG), mime_type: 'not a type' } }),
    ).rejects.toThrow(/not a type\/subtype/);
  });

  it('refuses bad base64, oversize, empty, a .doc, an unlisted type, a path-like name and a bad signature — sending nothing', async () => {
    const r = rig({ maxBytes: 1000 });
    const inline = (filename: string, content_base64: string) =>
      r.up.raw({ portal_document_id: 601, inline: { filename, content_base64 } });
    await expect(inline('a.pdf', 'JVBERi0x!!!')).rejects.toThrow(/not valid base64/);
    await expect(inline('a.pdf', b64(PDF).slice(0, -3))).rejects.toThrow(/not valid base64/);
    await expect(inline('a.pdf', b64(PDF))).rejects.toThrow(/too large/);
    await expect(inline('a.pdf', '')).rejects.toThrow(/empty/);
    await expect(inline('old.doc', b64(PNG))).rejects.toThrow(/Legacy \.doc/);
    await expect(inline('notes.txt', b64(Buffer.from('hello')))).rejects.toThrow(/\.txt is not an allowed type/);
    await expect(inline('noext', b64(PNG))).rejects.toThrow(/no extension is not an allowed type/);
    await expect(inline('../up/a.png', b64(PNG))).rejects.toThrow(/bare filename/);
    await expect(inline('fake.png', b64(Buffer.from('not a png at all')))).rejects.toThrow(/does not look like a \.png/);
    expect(r.transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
  });

  it('the default cap is 25 MB', async () => {
    const r = rig();
    const big = 'A'.repeat(Math.ceil((MAX_UPLOAD_BYTES + 3) / 3) * 4);
    await expect(r.up.raw({ portal_document_id: 601, inline: { filename: 'big.pdf', content_base64: big } })).rejects.toThrow(/too large/);
  });
});

describe('therapyportal_upload_slot', () => {
  it('mints a signed PUT slot whose MIME is the one the portal is sent, without touching the portal', async () => {
    const r = rig();
    const s = await r.slot({ filename: 'form scan.docx' });
    expect(s.blobKey).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
    expect(s).toMatchObject({
      method: 'PUT',
      filename: 'form scan.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      uploadUrl: expect.stringMatching(/^https:\/\/blobs\.example\.test\/b\/reg-1\/uploads\//),
      expiresAt: expect.any(String),
      curl: expect.stringContaining("Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    });
    expect(String(s.next)).toMatch(/therapyportal_upload_document with blob_key/);
    expect(r.transport.calls).toEqual([]);
    expect(blobLog).toEqual([]);
  });

  it('refuses with no blob store, and refuses a type the upload would refuse', async () => {
    const none = rig({ blobStore: () => undefined });
    await expect(none.slot({ filename: 'a.pdf' })).rejects.toThrow(/no blob store/);
    const r = rig();
    await expect(r.slot({ filename: 'old.doc' })).rejects.toThrow(/Legacy \.doc/);
    await expect(r.slot({ filename: 'a.txt' })).rejects.toThrow(/not an allowed type/);
    await expect(r.slot({ filename: 'a.png', mime_type: 'image/jpeg' })).rejects.toThrow(/does not match \.png/);
    await expect(r.slot({ filename: '.hidden.pdf' })).rejects.toThrow(/must not start with a dot/);
  });
});

describe('therapyportal_upload_document — blob_key', () => {
  it('previews by reading the blob (no delete), and binds its SHA-256', async () => {
    const r = rig();
    const key = await uploaded(r, 'photo.png', PNG);
    const preview = await r.up.preview({ portal_document_id: 601, blob_key: key });
    expect(JSON.stringify(preview)).toContain(await sha(PNG));
    expect(preview.preview).toMatchObject({ willSend: { source: 'upload_slot', file: { name: 'photo.png', type: 'image/png' } } });
    expect(blobLog).toEqual([`GET ${key}`]);
    expect(objects.has(key)).toBe(true);
    expect(r.transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
  });

  it('the confirmed upload re-reads, sends the bytes, then deletes the blob', async () => {
    const r = rig();
    const key = await uploaded(r, 'photo.png', PNG);
    const out = await r.up.confirmed({ portal_document_id: 601, blob_key: key });
    expect(out).toMatchObject({ uploaded: true, blobDeleted: true });
    expect(segmentBytes(r.transport.calls).equals(PNG)).toBe(true);
    expect(blobLog).toEqual([`GET ${key}`, `GET ${key}`, `DELETE ${key}`]);
    expect(objects.has(key)).toBe(false);
  });

  it('a failed upload keeps the blob', async () => {
    const r = rig({}, { 'document/stageduploadvalidation': okJson({ FormAdvice: [{ Type: 3, Message: 'Unsupported.' }] }) });
    const key = await uploaded(r, 'photo.png', PNG);
    await expect(r.up.confirmedRaw({ portal_document_id: 601, blob_key: key })).rejects.toThrow(/Unsupported\./);
    expect(blobLog).not.toContain(`DELETE ${key}`);
    expect(objects.has(key)).toBe(true);
  });

  it('an unconfirmed (5xx) submit keeps the blob and says so', async () => {
    const r = rig({}, { 'document/uploadportalresponse': { status: 503, body: '' } });
    const key = await uploaded(r, 'photo.png', PNG);
    const out = await r.up.confirmed({ portal_document_id: 601, blob_key: key });
    expect(out).toMatchObject({ status: 'unknown', blobDeleted: false, blobKept: expect.stringMatching(/kept/) });
    expect(objects.has(key)).toBe(true);
  });

  it('a blob that changed after the preview is refused, and nothing is sent or deleted', async () => {
    const r = rig();
    const key = await uploaded(r, 'photo.png', PNG);
    const preview = await r.up.preview({ portal_document_id: 601, blob_key: key });
    objects.set(key, { bytes: new Uint8Array(Buffer.concat([PNG, Buffer.from([9])])), type: 'image/png' });
    r.transport.calls.length = 0;
    const res = await r.up.raw({ portal_document_id: 601, blob_key: key, confirmToken: preview.confirmToken });
    expect(textOf(res)).toContain('DRAFT_CHANGED');
    expect(r.transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
    expect(blobLog).not.toContain(`DELETE ${key}`);
  });

  it('a failed delete after a successful upload is reported, not thrown', async () => {
    const r = rig();
    const key = await uploaded(r, 'photo.png', PNG);
    failDelete = true;
    const out = await r.up.confirmed({ portal_document_id: 601, blob_key: key });
    expect(out).toMatchObject({ uploaded: true, blobDeleted: false, blobDeleteError: expect.stringMatching(/HTTP 500/) });
  });

  it('refuses a key it did not mint, a missing object, a bad object and no store', async () => {
    const r = rig({ maxBytes: 1000 });
    await expect(r.up.raw({ portal_document_id: 601, blob_key: 'exports/some.zip' })).rejects.toThrow(/not an upload key.*therapyportal_upload_slot/);
    const gone = await r.slot({ filename: 'gone.png' });
    await expect(r.up.raw({ portal_document_id: 601, blob_key: gone.blobKey })).rejects.toThrow(/not found/);
    const fake = await uploaded(r, 'fake.png', Buffer.from('not a png at all'));
    await expect(r.up.raw({ portal_document_id: 601, blob_key: fake })).rejects.toThrow(/does not look like a \.png/);
    const big = await uploaded(r, 'big.pdf', PDF);
    await expect(r.up.raw({ portal_document_id: 601, blob_key: big })).rejects.toThrow(/1000|too large|limit/);
    const empty = await uploaded(r, 'empty.pdf', Buffer.alloc(0));
    await expect(r.up.raw({ portal_document_id: 601, blob_key: empty })).rejects.toThrow(/empty/);
    // A well-formed key whose name decodes to a hidden file is still refused.
    const hidden = `uploads/00000000-0000-4000-8000-000000000000/${Buffer.from('.secret.pdf').toString('base64url')}`;
    await expect(r.up.raw({ portal_document_id: 601, blob_key: hidden })).rejects.toThrow(/must not start with a dot/);
    // No store configured at all (the default).
    const none = rig({ blobStore: undefined });
    await expect(none.up.raw({ portal_document_id: 601, blob_key: fake })).rejects.toThrow(/no blob store/);
    expect(r.transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
  });
});

describe('therapyportal_upload_document — file_path when hosted', () => {
  it('says the server is remote (pointing at upload slots), never ENOENT, and reads nothing', async () => {
    const r = rig({ hosted: true });
    const res = r.up.raw({ portal_document_id: 601, file_path: '/Users/someone/Downloads/scan.pdf' });
    await expect(res).rejects.toThrow(/remote and can't read files on your machine/);
    await expect(res).rejects.toMatchObject({ hint: expect.stringMatching(/therapyportal_upload_slot.*blob_key.*inline/s) });
    expect(r.transport.calls).toEqual([]);
  });

  it('with no blob store, points at inline only', async () => {
    const r = rig({ hosted: true, blobStore: () => undefined });
    await expect(r.up.raw({ portal_document_id: 601, file_path: '/x/scan.pdf' })).rejects.toMatchObject({
      hint: expect.not.stringMatching(/therapyportal_upload_slot/),
    });
  });

  it('inline still works when hosted', async () => {
    const r = rig({ hosted: true });
    await expect(r.up.confirmed({ portal_document_id: 601, inline: { filename: 'p.png', content_base64: b64(PNG) } })).resolves.toMatchObject({
      uploaded: true,
    });
  });

  it('locally, file_path keeps its guards and still uploads (no blob fields)', async () => {
    const p = join(dir, 'local.png');
    writeFileSync(p, PNG);
    const r = rig();
    const out = await r.up.confirmed({ portal_document_id: 601, file_path: p });
    expect(out).toMatchObject({ uploaded: true });
    expect(out.blobDeleted).toBeUndefined();
    const preview = await r.up.preview({ portal_document_id: 601, file_path: p });
    expect(preview.preview).toMatchObject({ willSend: { source: 'file_path', file: { sha256: await sha(PNG) } } });
    expect(blobLog).toEqual([]);
  });
});
