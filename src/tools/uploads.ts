// The one upload tool: a local file sent in answer to a document that asks for
// one — a pending document request from the practice, or an always-available
// library form marked "upload required". It is NOT read-only: the practice
// receives the file and there is no delete or undo through this server, so it
// is annotated destructive and confirm-gated (`defineWrite` + `registerWrite`).
//
// Flow, from the portal's own JS (DocumentViewController /
// AlwaysAvailableDocumentViewController / xhrfileuploader; see
// docs/THERAPYPORTAL-API.md):
//   1. stage the bytes on the segment receiver under a fresh upload guid;
//   2. `document/stageduploadvalidation` — any FormAdvice Error stops here,
//      before anything is submitted (the staged temp file is orphaned; fine);
//   3. submit: `document/uploadportalresponse` (a pending request) or
//      `document/submitalwaysavailablelibrarydocumentupload` (a library form).
// Only step 3 reaches the practice, so only it goes through `sendOnce`: a 5xx
// or a dropped connection there is reported as `status: "unknown"`.
//
// Safety before a byte leaves the machine:
//   * `plan` checks against live reads that the target exists, is the user's,
//     actually asks for an upload, is not completed, and needs NO signature —
//     anything with PatientSignatureRequired is refused (signatures are out of
//     scope; use the portal);
//   * vetUploadFile confines the path to the allowed roots, refuses symlinks,
//     non-allowlisted types and oversize files, checks magic bytes, and reads
//     the bytes from the one vetted descriptor;
//   * the gate binds the file's SHA-256 (plus name, type and size), so a file
//     that changed between the preview and the confirmed call is refused as
//     DRAFT_CHANGED. The base64 never enters the preview.
// The upload guid and DocumentDate change per send, so they are minted in
// `execute`, never bound into the token.
//
// Three sources, exactly one per call — all converge on the same vetting:
//   * `file_path` — a file on THIS server's disk (local installs). Refused when
//     hosted: the caller's path names a file on its own machine, which a
//     remote runner cannot see, so it gets a "this server is remote" error
//     pointing at the other two instead of an ENOENT.
//   * `inline` — the bytes as base64 inside the call (strictly decoded). Works
//     anywhere; mcp-host caps one request at ~9.9 MiB, so small files only.
//   * `blob_key` — hosted: `therapyportal_upload_slot` mints a signed PUT URL
//     on mcp-host's blob store, the caller curls the file to it, then passes
//     the key here. The preview READS the object (store.get) and binds its
//     SHA-256; the confirmed call re-reads it (a changed object is refused as
//     DRAFT_CHANGED) and deletes it only after the portal accepted the file. A
//     failed or unconfirmed upload keeps it; a failed delete is reported.
// The slot is a separate read-only tool, not a mode of this one, because
// `defineWrite` puts every call to this tool through the confirm gate, and
// minting a URL sends nothing to the practice.
//
// UNVERIFIED on the wire: no automated run performs a real upload.

import { createHash, randomUUID } from 'node:crypto';
import { basename, delimiter, extname, join } from 'node:path';
import { z } from 'zod';
import {
  McpToolError,
  UNTRUSTED_CONTENT_RULE,
  bytesMatchMime,
  defineWrite,
  minifiedResult,
  readEnvVar,
  registerWrite,
  untrustedEnvelope,
  vetUploadFile,
  type EnvSource,
} from '@chrischall/mcp-utils';
import {
  checkUploadSize,
  decodeBase64Strict,
  mintUploadSlot,
  resolveUploadMime,
  sanitizeUploadFilename,
  uploadFileNameFromKey,
  type BlobStore,
} from '@chrischall/mcp-utils/export';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StagedFile, TherapyPortalClient } from '../client.js';
import { untrustedViewResponse } from '../view.js';
import { READ, asRecord, asRecordArray, tidy } from './_shared.js';
import { requireClient } from './_lookups.js';
import { WRITE, compactResult, isUnknown, sendOnce, writeDescription } from './_writes.js';
import { healthMeta, withToolMeta } from './hints.js';

/** The MIME each allowed extension is SENT to the portal as. */
export const UPLOAD_MIME_BY_EXT: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * The MIME each extension is VETTED as (its magic bytes are checked against
 * this). A .docx is a zip container, so its signature is the zip one. Legacy
 * .doc (OLE2) is absent: mcp-utils' magic-byte check cannot verify it, and the
 * vetting fails closed, so a .doc is refused with a "save as PDF/.docx" hint.
 */
const VET_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ...UPLOAD_MIME_BY_EXT,
  docx: 'application/zip',
};

/** Largest file accepted, in bytes. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Folders a file may be uploaded from when nothing is configured. */
export const DEFAULT_UPLOAD_ROOTS: readonly string[] = ['~/Downloads', '~/Documents', '~/Desktop'];

/**
 * The folders an upload's `file_path` is confined to:
 *   - `THERAPYPORTAL_UPLOAD_DIR` set → exactly those (a path-delimiter list; `~` expands);
 *   - unset, hosted (`MCP_DATA_DIR`) → `$MCP_DATA_DIR/uploads` only. A hosted
 *     server refuses `file_path` outright (see {@link hostedPathRefusal}), so
 *     this is only a backstop: a confinement nobody else can write into;
 *   - unset, local → `~/Downloads`, `~/Documents` and `~/Desktop`.
 * A blank or delimiter-only value counts as unset, so it can never unconfine it.
 */
export function uploadRoots(env: EnvSource = process.env): readonly string[] {
  const configured = (readEnvVar('THERAPYPORTAL_UPLOAD_DIR', { env }) ?? '')
    .split(delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const dataDir = readEnvVar('MCP_DATA_DIR', { env });
  if (dataDir !== undefined && dataDir.trim() !== '') return [join(dataDir.trim(), 'uploads')];
  return DEFAULT_UPLOAD_ROOTS;
}

/** The file name as the portal's uploader sends it: `|<>"` stripped. */
export function portalFileName(path: string): string {
  return basename(path).replace(/[|<>"]/g, '');
}

/**
 * True on mcp-host: it lends a hosted child a data dir and/or a blob store.
 * Read through `readEnvVar`, so an unexpanded `${VAR}` placeholder is unset.
 */
export function isHostedDeployment(env: EnvSource = process.env): boolean {
  return readEnvVar('MCP_DATA_DIR', { env }) !== undefined || readEnvVar('MCP_BLOB_BASE_URL', { env }) !== undefined;
}

const NOTHING_SENT = 'Nothing was sent.';

/** Run `fn`, turning a plain Error (mcp-utils' upload helpers throw those) into a tool error. */
function refusing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new McpToolError((e as Error).message, { hint: NOTHING_SENT });
  }
}

/**
 * Check a caller-supplied file NAME (inline or upload slot) the way
 * `vetUploadFile` checks a path's: a bare name, an allowlisted extension, no
 * legacy .doc, and — when a MIME type is given — the one that extension is
 * sent as. Returns the trimmed name and its extension.
 */
export function vetUploadName(raw: string, mimeType?: string): { name: string; ext: string } {
  const name = refusing(() => sanitizeUploadFilename(raw));
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === 'doc') throw legacyDocRefusal();
  const sent = Object.hasOwn(UPLOAD_MIME_BY_EXT, ext) ? UPLOAD_MIME_BY_EXT[ext] : undefined;
  if (sent === undefined) {
    throw new McpToolError(
      `${ext ? `.${ext}` : 'A file with no extension'} is not an allowed type (allowed: ${Object.keys(UPLOAD_MIME_BY_EXT).join(', ')}).`,
      { hint: NOTHING_SENT },
    );
  }
  if (mimeType !== undefined) {
    const given = refusing(() => resolveUploadMime(name, mimeType));
    if (given !== sent) {
      throw new McpToolError(`mime_type ${given} does not match .${ext}, which is sent as ${sent}.`, {
        hint: `Omit mime_type, or rename the file to its real extension. ${NOTHING_SENT}`,
      });
    }
  }
  return { name, ext };
}

/**
 * Check in-memory bytes the way `vetUploadFile` checks a file on disk: not
 * empty, within `maxBytes`, and starting with the signature its extension
 * claims (a .docx as a zip).
 */
export function vetUploadBytes(name: string, ext: string, bytes: Uint8Array, maxBytes: number): void {
  refusing(() => checkUploadSize(name, bytes.length, maxBytes));
  if (!bytesMatchMime(bytes.subarray(0, 16), VET_MIME_BY_EXT[ext] as string)) {
    throw new McpToolError(`${name} does not look like a .${ext} (${UPLOAD_MIME_BY_EXT[ext]}).`, { hint: NOTHING_SENT });
  }
}

function legacyDocRefusal(): McpToolError {
  return new McpToolError('Legacy .doc files cannot be checked before upload, so they are refused.', {
    hint: 'Save it as PDF or .docx and upload that. Nothing was sent.',
  });
}

/** The refusal for `file_path` on a hosted deployment — not an ENOENT. */
export function hostedPathRefusal(hasBlobStore: boolean): McpToolError {
  return new McpToolError(
    "This server is remote and can't read files on your machine, so file_path cannot work here.",
    {
      hint: hasBlobStore
        ? 'Call therapyportal_upload_slot with the filename, PUT the file to the uploadUrl it returns (its curl does ' +
          'exactly that), then call this tool again with blob_key. For a small file you can pass inline ' +
          `{filename, content_base64} instead. ${NOTHING_SENT}`
        : `Pass the bytes with inline {filename, content_base64} instead. ${NOTHING_SENT}`,
    },
  );
}

function noBlobStore(what: string): McpToolError {
  return new McpToolError(`${what} needs the blob store a hosted (mcp-host) deployment provides, and this server has no blob store.`, {
    hint: `On a local install pass file_path; anywhere, pass the bytes with inline {filename, content_base64}. ${NOTHING_SENT}`,
  });
}

/** PatientFileReferenceType values the upload uses. */
const REF_PORTAL_DOCUMENT = 1;
const REF_LIBRARY_DOCUMENT = 4;
/** PatientDocumentType of an always-available library document. */
const LIBRARY_DOCUMENT_TYPE = 2;
/** PortalDocumentStatus Completed. */
const DOC_COMPLETED = 3;

/** Which document the file answers, resolved from the live lists. */
export type UploadTarget =
  | { kind: 'request'; portalDocumentId: number; patientId: number; title: string }
  | { kind: 'library'; libraryDocumentId: number; versionId: number; patientId: number; title: string };

/** The validation request for a staged file (`document/stageduploadvalidation`). */
export function validationRequest(target: UploadTarget, guid: string): Record<string, unknown> {
  return target.kind === 'request'
    ? { FileUploadGuid: guid, ReferenceId: target.portalDocumentId, ReferenceType: REF_PORTAL_DOCUMENT }
    : {
        FileUploadGuid: guid,
        ReferenceId: target.libraryDocumentId,
        ReferenceVersionId: target.versionId,
        ReferenceType: REF_LIBRARY_DOCUMENT,
      };
}

/** The file part of a SavePatientFileRequest. */
interface FileFacts {
  name: string;
  mime: string;
  size: number;
}

/**
 * The submit call: its path and its `request` JSON. `guid` and `documentDate`
 * are null in the bound preview copy and real at send time. (The library
 * form's UploadedResponse uses ReferenceType 1 while its validation used 4 —
 * copied from the portal's code.)
 */
export function submitRequest(
  target: UploadTarget,
  file: FileFacts,
  guid: string | null,
  documentDate: string | null,
): { path: string; request: Record<string, unknown> } {
  const save = (referenceId: number | null) => ({
    ReferenceId: referenceId,
    ReferenceVersionId: null,
    ReferenceType: REF_PORTAL_DOCUMENT,
    PatientId: target.patientId,
    FileSize: file.size,
    FileName: file.name,
    MimeType: file.mime,
    DocumentDate: documentDate,
    Guid: guid,
  });
  return target.kind === 'request'
    ? { path: 'document/uploadportalresponse', request: save(target.portalDocumentId) }
    : {
        path: 'document/submitalwaysavailablelibrarydocumentupload',
        request: {
          PatientId: target.patientId,
          LibraryDocumentId: target.libraryDocumentId,
          LibraryDocumentVersionId: target.versionId,
          UploadedResponse: save(null),
        },
      };
}

const SIGNATURE_HINT =
  'This document needs your signature, which this server does not do. Sign and upload it in the ' +
  'TherapyPortal website instead. Nothing was sent.';
const PRACTICE_WROTE = 'Document titles and portal notes are written by the practice.';
const SUBMIT_HINT =
  'Nothing was submitted. The portal rejected the file for this document; check its type and size, ' +
  'or upload it in the TherapyPortal website.';

/** A pending document request's document, resolved and checked. */
async function resolveRequestDocument(
  client: TherapyPortalClient,
  portalDocumentId: number,
  patientId: number | undefined,
): Promise<UploadTarget> {
  const reqs = asRecordArray(asRecord(await client.documentRequests('pending')).PortalDocumentRequests);
  for (const r of reqs) {
    for (const d of asRecordArray(r.PortalDocuments)) {
      if (Number(d.PortalDocumentId) !== portalDocumentId) continue;
      const owner = Number(d.PatientId ?? r.PatientId);
      if (patientId !== undefined && patientId !== owner) {
        throw new McpToolError(`Document ${portalDocumentId} belongs to a different client.`, {
          hint: `It is client ${owner}'s; omit patient_id or pass that one. Nothing was sent.`,
        });
      }
      if (Number(d.PortalDocumentStatus) === DOC_COMPLETED) {
        throw new McpToolError(`Document ${portalDocumentId} is already completed.`, {
          hint: 'Only a pending document can be answered. Nothing was sent.',
        });
      }
      if (d.PatientSignatureRequired === true) {
        throw new McpToolError(`Document ${portalDocumentId} needs a signature.`, { hint: SIGNATURE_HINT });
      }
      if (d.IsUploadRequired !== true) {
        throw new McpToolError(`Document ${portalDocumentId} does not ask for an upload.`, {
          hint: 'Only a document that asks you to upload a file can be answered here (it may be a form to fill in, in the portal). Nothing was sent.',
        });
      }
      return { kind: 'request', portalDocumentId, patientId: owner, title: String(d.Title ?? '') };
    }
  }
  throw new McpToolError(`Document ${portalDocumentId} is not in your pending document requests.`, {
    hint: 'See therapyportal_list_documents status=pending for the portalDocumentId. Nothing was sent.',
  });
}

/** An always-available library form, resolved and checked. */
async function resolveLibraryDocument(
  client: TherapyPortalClient,
  libraryDocumentId: number,
  patientId: number | undefined,
): Promise<UploadTarget> {
  const all = asRecordArray(await client.alwaysAvailableDocuments()).filter(
    (f) => Number(f.PatientDocumentKey) === libraryDocumentId,
  );
  const mine = patientId === undefined ? all : all.filter((f) => Number(f.PatientId) === patientId);
  if (mine.length === 0) {
    throw new McpToolError(`Form ${libraryDocumentId} is not one of your always-available forms${patientId === undefined ? '' : ` for client ${patientId}`}.`, {
      hint: 'See therapyportal_list_forms for the libraryDocumentId and patientId. Nothing was sent.',
    });
  }
  if (mine.length > 1) {
    throw new McpToolError(`Form ${libraryDocumentId} is offered to more than one client.`, {
      hint: `Pass patient_id (one of ${mine.map((f) => String(f.PatientId)).join(', ')}). Nothing was sent.`,
    });
  }
  const f = mine[0]!;
  if (f.PatientSignatureRequired === true) {
    throw new McpToolError(`Form ${libraryDocumentId} needs a signature.`, { hint: SIGNATURE_HINT });
  }
  if (Number(f.PatientDocumentType) !== LIBRARY_DOCUMENT_TYPE || f.IsUploadRequired !== true) {
    throw new McpToolError(`Form ${libraryDocumentId} does not ask for an upload.`, {
      hint: 'Only a form marked upload-required can be answered here; fill other forms in the portal. Nothing was sent.',
    });
  }
  const versionId = Number(f.RevisionId);
  if (!Number.isInteger(versionId)) {
    throw new McpToolError(`Form ${libraryDocumentId} has no version id.`, {
      hint: 'The portal’s form list changed shape; see docs/THERAPYPORTAL-API.md. Nothing was sent.',
    });
  }
  return { kind: 'library', libraryDocumentId, versionId, patientId: Number(f.PatientId), title: String(f.Title ?? '') };
}

/** Options for {@link registerUploadTools}; `allowedRoots` is resolved at boot from the env. */
export interface UploadToolOptions {
  allowedRoots: readonly string[] | 'unconfined';
  /** Largest file accepted. Default {@link MAX_UPLOAD_BYTES}. */
  maxBytes?: number;
  /**
   * Running on mcp-host ({@link isHostedDeployment}): `file_path` is refused,
   * since no path the caller can name exists on this machine. Default false.
   */
  hosted?: boolean;
  /**
   * The blob store for upload slots, resolved per call (`blobStoreFromEnv`
   * in production, so a malformed env fails the call that needs it, not boot).
   * Default: none.
   */
  blobStore?: () => BlobStore | undefined;
}

/** One inline file. snake_case, like every other argument here. */
const inlineFileSchema = z.object({
  filename: z
    .string()
    .describe('The name the practice will see — a bare name, no path, not starting with a dot. Its extension must be pdf, jpg, jpeg, png, heic or docx.'),
  content_base64: z
    .string()
    .describe('The file’s bytes, standard base64 (line breaks and a "data:<type>;base64," prefix are tolerated).'),
  mime_type: z.string().optional().describe('Optional; must agree with the extension. Default: from the extension.'),
});

/** Where an upload's bytes come from, checked but not yet read. */
type UploadSource =
  | { kind: 'file_path'; path: string }
  | { kind: 'inline'; name: string; ext: string; contentBase64: string }
  | { kind: 'upload_slot'; name: string; ext: string; key: string; store: BlobStore };

/** Bytes ready to send, after the same vetting whatever the source. */
interface LoadedFile {
  bytes: Uint8Array;
  name: string;
  ext: string;
}

export function registerUploadTools(server: McpServer, client: TherapyPortalClient, opts: UploadToolOptions): void {
  const { allowedRoots } = opts;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const hosted = opts.hosted ?? false;
  const blobStore = opts.blobStore ?? (() => undefined);

  /** Pick the one source and check what can be checked without reading it. */
  const pickSource = (args: { file_path?: string; inline?: z.infer<typeof inlineFileSchema>; blob_key?: string }): UploadSource => {
    const given = [args.file_path, args.inline, args.blob_key].filter((v) => v !== undefined).length;
    if (given !== 1) {
      throw new McpToolError('Give exactly one of file_path, inline or blob_key.', {
        hint: hosted
          ? 'This server is hosted: use therapyportal_upload_slot then blob_key, or inline for a small file.'
          : 'file_path for a file in the upload folders; inline for base64 bytes; blob_key after therapyportal_upload_slot (hosted only).',
      });
    }
    if (args.file_path !== undefined) {
      if (hosted) throw hostedPathRefusal(blobStore() !== undefined);
      if (/\.doc$/i.test(args.file_path)) throw legacyDocRefusal();
      return { kind: 'file_path', path: args.file_path };
    }
    if (args.inline !== undefined) {
      const { name, ext } = vetUploadName(args.inline.filename, args.inline.mime_type);
      return { kind: 'inline', name, ext, contentBase64: args.inline.content_base64 };
    }
    const store = blobStore();
    if (store === undefined) throw noBlobStore('blob_key');
    const key = args.blob_key as string;
    const fileName = refusing(() => {
      try {
        return uploadFileNameFromKey(key);
      } catch (e) {
        // The shared message is tool-agnostic; name the tool that mints keys here.
        if (!(e as Error).message.includes('is not an upload key')) throw e;
        throw new Error(`blob_key ${JSON.stringify(key)} is not an upload key. Pass the blobKey exactly as therapyportal_upload_slot returned it.`);
      }
    });
    const { name, ext } = vetUploadName(fileName);
    return { kind: 'upload_slot', name, ext, key, store };
  };

  /** Read the source's bytes (the blob with `get`, never deleting) and vet them. */
  const loadSource = async (source: UploadSource): Promise<LoadedFile> => {
    if (source.kind === 'file_path') {
      const vetted = await vetUploadFile(source.path, { mimeByExt: VET_MIME_BY_EXT, maxBytes, allowedRoots, readAll: true });
      return { bytes: vetted.bytes as Uint8Array, name: basename(vetted.requested), ext: vetted.ext };
    }
    const bytes =
      source.kind === 'inline'
        ? refusing(() => decodeBase64Strict(source.contentBase64, { fileName: source.name, maxBytes }))
        : (await source.store.get(source.key, { maxBytes })).bytes;
    vetUploadBytes(source.name, source.ext, bytes, maxBytes);
    return { bytes, name: source.name, ext: source.ext };
  };

  withToolMeta(server, healthMeta('send', { aliases: ['upload a form', 'send a document', 'send paperwork'] }), () =>
    registerWrite(
      server,
      defineWrite({
        name: 'therapyportal_upload_document',
        description: writeDescription(
          'Upload a file (PDF, JPG, JPEG, PNG, HEIC or DOCX, up to 25 MB) to TherapyPortal in ' +
            'answer to a document that asks for one: a PENDING document request (portal_document_id from ' +
            'therapyportal_list_documents) or an always-available form marked upload-required ' +
            '(library_document_id from therapyportal_list_forms). Give EXACTLY ONE source: file_path (a ' +
            'file on this server’s disk — local installs only), inline (the bytes as base64; small files), ' +
            'or blob_key. On a hosted server, file_path cannot work: call therapyportal_upload_slot, PUT ' +
            'the file to its URL, then pass its blob_key here (the uploaded copy is deleted once the ' +
            'practice has the file). The practice receives the file and ' +
            'there is no delete or undo through this server. Refuses anything that needs a signature, ' +
            'and does not fill in forms.',
        ),
        annotations: WRITE,
        inputSchema: z.object({
          portal_document_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('A pending request’s document, from therapyportal_list_documents. Give this OR library_document_id.'),
          library_document_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('An always-available form’s libraryDocumentId, from therapyportal_list_forms.'),
          patient_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('The client the file is for. Required when a form is offered to more than one client.'),
          file_path: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Local installs only: path to the file. Must be inside THERAPYPORTAL_UPLOAD_DIR (default ' +
                '~/Downloads, ~/Documents or ~/Desktop). Refused on a hosted server, which cannot see your files.',
            ),
          inline: inlineFileSchema
            .optional()
            .describe('The file as base64 bytes. Works anywhere, but every byte rides in this one call; keep it to small files.'),
          blob_key: z
            .string()
            .optional()
            .describe('Hosted: the blobKey from therapyportal_upload_slot, after the file was PUT to its uploadUrl.'),
        }),
        async plan({ portal_document_id, library_document_id, patient_id, ...src }) {
          if ((portal_document_id === undefined) === (library_document_id === undefined)) {
            throw new McpToolError('Give exactly one of portal_document_id or library_document_id.', {
              hint: 'portal_document_id for a pending document request; library_document_id for an always-available form.',
            });
          }
          const source = pickSource(src);
          const target =
            portal_document_id !== undefined
              ? await resolveRequestDocument(client, portal_document_id, patient_id)
              : await resolveLibraryDocument(client, library_document_id as number, patient_id);
          const who = await requireClient(client, target.patientId);

          // Read and vet the bytes only once the target checks out.
          const loaded = await loadSource(source);
          const bytes = loaded.bytes;
          const file: FileFacts = {
            name: portalFileName(loaded.name),
            mime: UPLOAD_MIME_BY_EXT[loaded.ext] as string,
            size: bytes.length,
          };
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const preview = submitRequest(target, file, null, null);
          const targetId =
            target.kind === 'request' ? `request:${target.portalDocumentId}` : `library:${target.libraryDocumentId}`;
          return {
            gate: {
              action: 'therapyportal.upload_document',
              summary: `Upload ${file.name} to the practice for ${who.name ?? `client ${target.patientId}`}`,
              account: undefined,
              target: targetId,
              // The bytes are bound by their hash; the guid and DocumentDate are
              // minted at send time and so are null here.
              request: { method: 'POST', path: preview.path, body: { request: preview.request, contentSha256: sha256 } },
              willSend: {
                client: who.name ?? target.patientId,
                document: targetId,
                source: source.kind,
                file: { name: file.name, type: file.mime, size: file.size, sha256 },
              },
              preview: {
                warning: 'The practice receives this file; this server cannot remove it.',
                practiceText: untrustedEnvelope(
                  { documentTitle: target.title },
                  { note: `${PRACTICE_WROTE} ${UNTRUSTED_CONTENT_RULE}` },
                ),
              },
            },
            state: {
              target,
              file: { bytes, name: file.name, mime: file.mime } satisfies StagedFile,
              facts: file,
              blob: source.kind === 'upload_slot' ? { key: source.key, store: source.store } : undefined,
            },
          };
        },
        async execute({ target, file, facts, blob }) {
          const guid = randomUUID();
          await client.stageUpload(file, guid);
          const checked = await client.validateStagedUpload(validationRequest(target, guid));
          const { path, request } = submitRequest(target, facts, guid, new Date().toISOString());
          const result = await sendOnce(
            async () => {
              const data = await client.submit(path, { request: JSON.stringify(request) }, SUBMIT_HINT);
              const advice = client.judgeFormAdvice(data, 'upload', SUBMIT_HINT);
              const notes = [...checked, ...advice]
                .map((a) => (typeof a.Message === 'string' ? a.Message.trim() : ''))
                .filter(Boolean);
              return tidy({
                uploaded: true,
                documentTitle: target.title,
                file: { name: facts.name, type: facts.mime, size: facts.size },
                portalNotes: notes.length > 0 ? notes : undefined,
                notice: 'The practice now has this file; this server cannot remove it.',
              });
            },
            'upload',
            target.kind === 'request' ? 'therapyportal_list_documents' : 'therapyportal_list_forms',
          );
          if (blob === undefined) return result;
          // A failed stage/validation/submit threw above, so the blob is kept for
          // a retry. An unconfirmed submit keeps it too: it may not have landed.
          if (isUnknown(result)) {
            return {
              ...result,
              blobDeleted: false,
              blobKept: 'The uploaded copy was kept in the upload store (it expires on its own); check before reusing its blob_key.',
            };
          }
          try {
            await blob.store.delete(blob.key);
            return { ...result, blobDeleted: true };
          } catch (e) {
            return { ...result, blobDeleted: false, blobDeleteError: (e as Error).message };
          }
        },
        render: (result) =>
          isUnknown(result)
            ? compactResult(result)
            : untrustedViewResponse({
                view: 'full',
                views: ['full'],
                data: result,
                whoWrote: PRACTICE_WROTE,
                context: 'therapyportal_upload_document',
              }),
      }),
    ),
  );

  server.registerTool(
    'therapyportal_upload_slot',
    {
      description:
        'Hosted servers: get a signed upload URL for ONE file you then upload with therapyportal_upload_document. ' +
        'Sends nothing to the practice. PUT the file’s bytes to uploadUrl with the returned Content-Type (the ' +
        'returned curl does exactly that; replace its <path to …> placeholder), then call ' +
        'therapyportal_upload_document with blob_key. The URL expires at expiresAt. Same file rules as the ' +
        'upload: PDF, JPG, JPEG, PNG, HEIC or DOCX, up to 25 MB, a bare filename; .doc is refused.',
      annotations: READ,
      _meta: healthMeta('other'),
      inputSchema: z.object({
        filename: z.string().describe('The name the practice will see — a bare name with its extension, e.g. "scan.pdf".'),
        mime_type: z.string().optional().describe('Optional; must agree with the extension. Default: from the extension.'),
      }),
    },
    async ({ filename, mime_type }) => {
      const { name, ext } = vetUploadName(filename, mime_type);
      const store = blobStore();
      if (store === undefined) throw noBlobStore('therapyportal_upload_slot');
      const { expiresAtMs: _expires, ...slot } = mintUploadSlot(store, {
        filename: name,
        mimeType: UPLOAD_MIME_BY_EXT[ext] as string,
      });
      return minifiedResult({
        next:
          'Nothing has been sent to the practice. PUT the file to uploadUrl with this Content-Type (run the curl ' +
          'with the real path), then call therapyportal_upload_document with blob_key and the document id.',
        ...slot,
      });
    },
  );
}
