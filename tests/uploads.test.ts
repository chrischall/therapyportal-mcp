import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  DEFAULT_UPLOAD_ROOTS,
  MAX_UPLOAD_BYTES,
  UPLOAD_MIME_BY_EXT,
  portalFileName,
  registerUploadTools,
  uploadRoots,
} from '../src/tools/uploads.js';
import { capture, gated, okJson, textOf, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Real magic bytes so the vetting's signature check passes; the content is
// synthetic filler — no real document, no PHI.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200_000, 0x41)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]);

const CLIENTS = [
  { Id: 101, FirstName: 'Robin', Nickname: '' },
  { Id: 102, FirstName: 'Sam', Nickname: 'Sammy' },
  { Id: 104 },
];
const PENDING = {
  PortalDocumentRequests: [
    {
      RequestId: 1, RequestStatus: 1, PatientId: 101,
      PortalDocuments: [
        { PortalDocumentId: 601, Title: 'Insurance card', PortalDocumentStatus: 1, IsUploadRequired: true, PatientSignatureRequired: false, PatientId: 101 },
        { PortalDocumentId: 602, Title: 'Consent', PortalDocumentStatus: 1, IsUploadRequired: true, PatientSignatureRequired: true, PatientId: 101 },
        { PortalDocumentId: 603, Title: 'Questionnaire', PortalDocumentStatus: 1, IsUploadRequired: false, PatientId: 101 },
        { PortalDocumentId: 604, Title: 'Done', PortalDocumentStatus: 3, IsUploadRequired: true, PatientId: 101 },
        { PortalDocumentId: 605, PortalDocumentStatus: 2, IsUploadRequired: true },
        { PortalDocumentId: 606, PortalDocumentStatus: 1, IsUploadRequired: true, PatientId: 103 },
      ],
    },
    { RequestId: 2, RequestStatus: 4, PatientId: 102, PortalDocuments: null },
  ],
};
const FORMS = [
  { PatientDocumentKey: 701, RevisionId: 9, PatientDocumentType: 2, IsUploadRequired: true, PatientSignatureRequired: false, PatientId: 101, Title: 'Photo ID' },
  { PatientDocumentKey: 701, RevisionId: 9, PatientDocumentType: 2, IsUploadRequired: true, PatientSignatureRequired: false, PatientId: 102, Title: 'Photo ID' },
  { PatientDocumentKey: 702, RevisionId: 3, PatientDocumentType: 2, IsUploadRequired: true, PatientSignatureRequired: true, PatientId: 101, Title: 'Signed form' },
  { PatientDocumentKey: 703, RevisionId: 4, PatientDocumentType: 3, IsUploadRequired: true, PatientId: 101 },
  { PatientDocumentKey: 704, PatientDocumentType: 2, IsUploadRequired: true, PatientId: 101 },
  { PatientDocumentKey: 705, RevisionId: 1, PatientDocumentType: 2, IsUploadRequired: false, PatientId: 101 },
  { PatientDocumentKey: 706, RevisionId: 2, PatientDocumentType: 2, IsUploadRequired: true, PatientSignatureRequired: false, PatientId: 104 },
];

let dir: string;
const file = (name: string, bytes: Buffer): string => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-upload-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function portal(over: Record<string, FetchResult> = {}) {
  return (call: FakeCall): FetchResult => {
    if (over[call.path] !== undefined) return over[call.path]!;
    switch (call.path) {
      case 'document/getpatientsforportaluser':
        return okJson(CLIENTS);
      case 'documents/api/getportaluserdocumentrequestsbystatus':
        return okJson(PENDING);
      case 'documents/api/getalwaysavailabledocumentsforportaluser':
        return okJson(FORMS);
      case 'SEGMENT':
        return { status: 200, body: '' };
      case 'document/stageduploadvalidation':
        return okJson({ FormAdvice: [{ Id: 'a', Type: 0, Message: 'Looks fine.', Fields: [] }] });
      case 'document/uploadportalresponse':
      case 'document/submitalwaysavailablelibrarydocumentupload':
        return okJson({ FormAdvice: [] });
      default:
        throw new Error(`unexpected ${call.path}`);
    }
  };
}

function rig(over: Record<string, FetchResult> = {}, opts: { maxBytes?: number; roots?: readonly string[] } = {}) {
  const { handlers, transport } = capture(
    ((server: never, client: never) =>
      registerUploadTools(server, client, { allowedRoots: opts.roots ?? [dir], maxBytes: opts.maxBytes })) as never,
    portal(over),
  );
  return { transport, up: gated(handlers.get('therapyportal_upload_document')!, transport) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('upload helpers', () => {
  it('strips |<>" from the file name', () => {
    expect(portalFileName('/x/a|b<c>"d".pdf')).toBe('abcd.pdf');
  });
  it('confines to THERAPYPORTAL_UPLOAD_DIR, else $MCP_DATA_DIR/uploads, else the defaults', () => {
    expect(uploadRoots({ THERAPYPORTAL_UPLOAD_DIR: `/a${delimiter} /b ` })).toEqual(['/a', '/b']);
    expect(uploadRoots({ THERAPYPORTAL_UPLOAD_DIR: delimiter, MCP_DATA_DIR: ' /data ' })).toEqual([join('/data', 'uploads')]);
    expect(uploadRoots({ MCP_DATA_DIR: '  ' })).toBe(DEFAULT_UPLOAD_ROOTS);
    expect(uploadRoots({})).toEqual(['~/Downloads', '~/Documents', '~/Desktop']);
  });
  it('allows exactly pdf, jpg, jpeg, png, heic and docx, up to 25 MB', () => {
    expect(Object.keys(UPLOAD_MIME_BY_EXT).sort()).toEqual(['docx', 'heic', 'jpeg', 'jpg', 'pdf', 'png']);
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('therapyportal_upload_document — pending document request', () => {
  it('phase 1 reads and previews only: no segment, no validation, no submit, and no base64', async () => {
    const path = file('card.pdf', PDF);
    const { up, transport } = rig();
    const preview = await up.preview({ portal_document_id: 601, file_path: path });
    expect(typeof preview.confirmToken).toBe('string');
    expect(transport.calls.every((c) => c.via === undefined)).toBe(true);
    expect(transport.calls.map((c) => c.path)).not.toContain('document/stageduploadvalidation');
    const text = JSON.stringify(preview);
    expect(text).toContain('card.pdf');
    expect(text).toContain('untrusted_content');
    expect(text).not.toContain(PDF.subarray(0, 3000).toString('base64'));
  });

  it('confirmed: stages segments, validates, then submits uploadportalresponse once', async () => {
    const path = file('card2.pdf', PDF);
    const { up, transport } = rig();
    const out = await up.confirmed({ portal_document_id: 601, file_path: path });
    const segs = transport.calls.filter((c) => c.via === 'segment');
    expect(segs).toHaveLength(2); // 200 009 bytes → 2 segments
    const guid = segs[0]!.headers!['X-Upload-Guid']!;
    expect(guid).toMatch(UUID);
    expect(segs[1]!.headers!['X-Upload-Segment-Is-Final']).toBe('true');
    expect(segs[0]!.headers!['X-Upload-File-Mime-Type']).toBe('application/pdf');
    const validation = transport.calls.find((c) => c.path === 'document/stageduploadvalidation')!;
    expect(validation.via).toBeUndefined();
    expect(JSON.parse(validation.fields.request!)).toEqual({ FileUploadGuid: guid, ReferenceId: 601, ReferenceType: 1 });
    const submits = transport.calls.filter((c) => c.via === 'send');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.path).toBe('document/uploadportalresponse');
    const req = JSON.parse(submits[0]!.fields.request!);
    expect(req).toMatchObject({
      ReferenceId: 601, ReferenceVersionId: null, ReferenceType: 1, PatientId: 101,
      FileSize: PDF.length, FileName: 'card2.pdf', MimeType: 'application/pdf', Guid: guid,
    });
    expect(new Date(req.DocumentDate).toISOString()).toBe(req.DocumentDate);
    // order: all segments, then validation, then submit
    const order = transport.calls
      .map((c) => c.via ?? c.path)
      .filter((v) => v === 'segment' || v === 'send' || v === 'document/stageduploadvalidation');
    // the plan's re-reads come first; then every segment, the validation, the submit
    expect(transport.calls.findIndex((c) => c.via === 'segment')).toBeGreaterThan(0);
    expect(order).toEqual(['segment', 'segment', 'document/stageduploadvalidation', 'send']);
    expect(out).toMatchObject({ untrusted_content: true, uploaded: true, documentTitle: 'Insurance card', portalNotes: ['Looks fine.'] });
  });

  it('mints a fresh guid per send (not bound into the token)', async () => {
    const path = file('again.png', PNG);
    const { up, transport } = rig();
    await up.confirmed({ portal_document_id: 601, file_path: path });
    const g1 = transport.calls.find((c) => c.via === 'segment')!.headers!['X-Upload-Guid'];
    await up.confirmed({ portal_document_id: 601, file_path: path });
    const g2 = transport.calls.find((c) => c.via === 'segment')!.headers!['X-Upload-Guid'];
    expect(g1).not.toBe(g2);
  });

  it('uses the request’s PatientId when the document has none, and checks a given patient_id', async () => {
    const path = file('x.jpg', JPG);
    const { up, transport } = rig();
    await up.confirmed({ portal_document_id: 605, file_path: path, patient_id: 101 });
    expect(JSON.parse(transport.calls.find((c) => c.via === 'send')!.fields.request!).PatientId).toBe(101);
    await expect(up.raw({ portal_document_id: 601, file_path: path, patient_id: 102 })).rejects.toThrow(/different client/);
  });

  it('a file that changed after the preview is refused (bytes are bound by hash)', async () => {
    const path = file('change.png', PNG);
    const { up, transport } = rig();
    const preview = await up.preview({ portal_document_id: 601, file_path: path });
    writeFileSync(path, Buffer.concat([PNG, Buffer.from([9])]));
    transport.calls.length = 0;
    const res = await up.raw({ portal_document_id: 601, file_path: path, confirmToken: preview.confirmToken });
    expect(textOf(res)).toContain('DRAFT_CHANGED');
    expect(transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
  });

  it('refuses a signature, a non-upload, a completed, a missing or an unlinked document — before reading the file', async () => {
    const { up, transport } = rig();
    const missing = join(dir, 'never-created.pdf');
    await expect(up.raw({ portal_document_id: 602, file_path: missing })).rejects.toMatchObject({
      hint: expect.stringMatching(/signature/),
    });
    await expect(up.raw({ portal_document_id: 603, file_path: missing })).rejects.toThrow(/does not ask for an upload/);
    await expect(up.raw({ portal_document_id: 604, file_path: missing })).rejects.toThrow(/already completed/);
    await expect(up.raw({ portal_document_id: 999, file_path: missing })).rejects.toThrow(/not in your pending/);
    await expect(up.raw({ portal_document_id: 606, file_path: missing })).rejects.toThrow(/Client 103 is not linked/);
    expect(transport.calls.filter((c) => c.via !== undefined)).toEqual([]);
  });

  it('a validation Error stops before anything is submitted', async () => {
    const path = file('bad.pdf', PDF);
    const { up, transport } = rig({ 'document/stageduploadvalidation': okJson({ FormAdvice: [{ Type: 3, Message: 'Unsupported.' }] }) });
    await expect(up.confirmedRaw({ portal_document_id: 601, file_path: path })).rejects.toThrow(/Unsupported\./);
    expect(transport.calls.filter((c) => c.via === 'send')).toEqual([]);
  });

  it('a submit Error is a rejection; a submit 5xx is status "unknown"', async () => {
    const path = file('sub.pdf', PDF);
    const rejected = rig({ 'document/uploadportalresponse': okJson({ FormAdvice: [{ Type: 3, Message: 'Closed.' }] }) });
    await expect(rejected.up.confirmedRaw({ portal_document_id: 601, file_path: path })).rejects.toThrow(/rejected the upload: Closed\./);
    const lost = rig({ 'document/uploadportalresponse': { status: 503, body: '' } });
    const out = await lost.up.confirmed({ portal_document_id: 601, file_path: path });
    expect(out).toMatchObject({ status: 'unknown' });
    expect(String(out.warning)).toMatch(/therapyportal_list_documents/);
  });

  it('a success with no advice omits portalNotes', async () => {
    const path = file('quiet.pdf', PDF);
    const { up } = rig({ 'document/stageduploadvalidation': okJson({}) });
    const out = await up.confirmed({ portal_document_id: 601, file_path: path });
    expect(out.portalNotes).toBeUndefined();
  });
});

describe('therapyportal_upload_document — always-available library form', () => {
  it('validates with ReferenceType 4 and submits the library upload with UploadedResponse ReferenceType 1', async () => {
    const path = file('id.heic', HEIC);
    const { up, transport } = rig();
    const out = await up.confirmed({ library_document_id: 701, patient_id: 102, file_path: path });
    const guid = transport.calls.find((c) => c.via === 'segment')!.headers!['X-Upload-Guid'];
    const validation = transport.calls.find((c) => c.path === 'document/stageduploadvalidation')!;
    expect(JSON.parse(validation.fields.request!)).toEqual({
      FileUploadGuid: guid, ReferenceId: 701, ReferenceVersionId: 9, ReferenceType: 4,
    });
    const submit = transport.calls.find((c) => c.via === 'send')!;
    expect(submit.path).toBe('document/submitalwaysavailablelibrarydocumentupload');
    const req = JSON.parse(submit.fields.request!);
    expect(req).toMatchObject({ PatientId: 102, LibraryDocumentId: 701, LibraryDocumentVersionId: 9 });
    expect(req.UploadedResponse).toMatchObject({
      ReferenceId: null, ReferenceVersionId: null, ReferenceType: 1, PatientId: 102,
      FileName: 'id.heic', MimeType: 'image/heic', FileSize: HEIC.length, Guid: guid,
    });
    expect(out).toMatchObject({ untrusted_content: true, uploaded: true, documentTitle: 'Photo ID', notice: expect.any(String) });
  });

  it('an untitled form for a nameless client is named by id; message-less advice is dropped', async () => {
    const path = file('u.png', PNG);
    const { up } = rig({ 'document/stageduploadvalidation': okJson({ FormAdvice: [{ Type: 1 }] }) });
    const preview = JSON.stringify(await up.preview({ library_document_id: 706, file_path: path }));
    expect(preview).toContain('for client 104');
    expect(preview).toContain('"client":104');
    const out = await up.confirmed({ library_document_id: 706, file_path: path });
    expect(out).toMatchObject({ uploaded: true });
    expect(out.documentTitle).toBeUndefined();
    expect(out.portalNotes).toBeUndefined();
  });

  it('sends a .docx with its Office MIME type (vetted as a zip)', async () => {
    const path = file('letter.docx', DOCX);
    const { up, transport } = rig();
    await up.confirmed({ library_document_id: 701, patient_id: 101, file_path: path });
    expect(JSON.parse(transport.calls.find((c) => c.via === 'send')!.fields.request!).UploadedResponse.MimeType).toBe(
      UPLOAD_MIME_BY_EXT.docx,
    );
  });

  it('a 5xx on the library submit points at therapyportal_list_forms', async () => {
    const path = file('id2.png', PNG);
    const { up } = rig({ 'document/submitalwaysavailablelibrarydocumentupload': { status: 500, body: '' } });
    const out = await up.confirmed({ library_document_id: 701, patient_id: 101, file_path: path });
    expect(String(out.warning)).toMatch(/therapyportal_list_forms/);
  });

  it('refuses ambiguity, signatures, non-upload forms, a missing version and an unknown form', async () => {
    const { up } = rig();
    const p = join(dir, 'n.pdf');
    await expect(up.raw({ library_document_id: 701, file_path: p })).rejects.toMatchObject({ hint: expect.stringMatching(/101, 102/) });
    await expect(up.raw({ library_document_id: 702, file_path: p })).rejects.toThrow(/needs a signature/);
    await expect(up.raw({ library_document_id: 703, file_path: p })).rejects.toThrow(/does not ask for an upload/);
    await expect(up.raw({ library_document_id: 705, file_path: p })).rejects.toThrow(/does not ask for an upload/);
    await expect(up.raw({ library_document_id: 704, file_path: p })).rejects.toThrow(/no version id/);
    await expect(up.raw({ library_document_id: 799, file_path: p })).rejects.toThrow(/not one of your always-available forms\./);
    await expect(up.raw({ library_document_id: 701, patient_id: 103, file_path: p })).rejects.toThrow(/for client 103/);
  });
});

describe('therapyportal_upload_document — arguments and file vetting', () => {
  it('needs exactly one target', async () => {
    const { up } = rig();
    await expect(up.raw({ file_path: '/x.pdf' })).rejects.toThrow(/exactly one/);
    await expect(up.raw({ portal_document_id: 601, library_document_id: 701, file_path: '/x.pdf' })).rejects.toThrow(/exactly one/);
  });

  it('refuses a .doc, an unlisted type, a path outside the roots, an oversize or an empty file', async () => {
    const { up } = rig({}, { maxBytes: 1000 });
    await expect(up.raw({ portal_document_id: 601, file_path: join(dir, 'old.DOC') })).rejects.toThrow(/Legacy \.doc/);
    await expect(up.raw({ portal_document_id: 601, file_path: file('notes.txt', Buffer.from('hello')) })).rejects.toThrow();
    const outside = rig({}, { roots: [join(dir, 'nested-root')] });
    await expect(outside.up.raw({ portal_document_id: 601, file_path: file('o.png', PNG) })).rejects.toThrow();
    await expect(up.raw({ portal_document_id: 601, file_path: file('big.pdf', PDF) })).rejects.toThrow();
    await expect(up.raw({ portal_document_id: 601, file_path: file('empty.pdf', Buffer.alloc(0)) })).rejects.toThrow();
    await expect(up.raw({ portal_document_id: 601, file_path: file('fake.png', Buffer.from('not a png at all')) })).rejects.toThrow();
  });
});
