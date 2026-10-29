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
// UNVERIFIED on the wire: no automated run performs a real upload.

import { createHash, randomUUID } from 'node:crypto';
import { basename, delimiter, join } from 'node:path';
import { z } from 'zod';
import {
  McpToolError,
  UNTRUSTED_CONTENT_RULE,
  defineWrite,
  readEnvVar,
  registerWrite,
  untrustedEnvelope,
  vetUploadFile,
  type EnvSource,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { StagedFile, TherapyPortalClient } from '../client.js';
import { untrustedViewResponse } from '../view.js';
import { asRecord, asRecordArray, tidy } from './_shared.js';
import { requireClient } from './_lookups.js';
import { WRITE, compactResult, isUnknown, sendOnce, writeDescription } from './_writes.js';

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
 *   - unset, hosted (`MCP_DATA_DIR`) → `$MCP_DATA_DIR/uploads` only (the one
 *     disk the runner and the user share);
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
}

export function registerUploadTools(server: McpServer, client: TherapyPortalClient, opts: UploadToolOptions): void {
  const { allowedRoots } = opts;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;

  registerWrite(
    server,
    defineWrite({
      name: 'therapyportal_upload_document',
      description: writeDescription(
        'Upload a local file (PDF, JPG, JPEG, PNG, HEIC or DOCX, up to 25 MB) to TherapyPortal in ' +
          'answer to a document that asks for one: a PENDING document request (portal_document_id from ' +
          'therapyportal_list_documents) or an always-available form marked upload-required ' +
          '(library_document_id from therapyportal_list_forms). The practice receives the file and ' +
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
          .describe(
            'Local path to the file. Must be inside THERAPYPORTAL_UPLOAD_DIR (default ~/Downloads, ' +
              '~/Documents or ~/Desktop; $MCP_DATA_DIR/uploads when hosted).',
          ),
      }),
      async plan({ portal_document_id, library_document_id, patient_id, file_path }) {
        if ((portal_document_id === undefined) === (library_document_id === undefined)) {
          throw new McpToolError('Give exactly one of portal_document_id or library_document_id.', {
            hint: 'portal_document_id for a pending document request; library_document_id for an always-available form.',
          });
        }
        if (/\.doc$/i.test(file_path)) {
          throw new McpToolError('Legacy .doc files cannot be checked before upload, so they are refused.', {
            hint: 'Save it as PDF or .docx and upload that. Nothing was sent.',
          });
        }
        const target =
          portal_document_id !== undefined
            ? await resolveRequestDocument(client, portal_document_id, patient_id)
            : await resolveLibraryDocument(client, library_document_id as number, patient_id);
        const who = await requireClient(client, target.patientId);

        // Vet (and read) the file only once the target checks out.
        const vetted = await vetUploadFile(file_path, { mimeByExt: VET_MIME_BY_EXT, maxBytes, allowedRoots, readAll: true });
        const bytes = vetted.bytes as Uint8Array;
        const file: FileFacts = {
          name: portalFileName(vetted.requested),
          mime: UPLOAD_MIME_BY_EXT[vetted.ext] as string,
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
              file: { name: file.name, type: file.mime, size: file.size },
            },
            preview: {
              warning: 'The practice receives this file; this server cannot remove it.',
              practiceText: untrustedEnvelope(
                { documentTitle: target.title },
                { note: `${PRACTICE_WROTE} ${UNTRUSTED_CONTENT_RULE}` },
              ),
            },
          },
          state: { target, file: { bytes, name: file.name, mime: file.mime } satisfies StagedFile, facts: file },
        };
      },
      async execute({ target, file, facts }) {
        const guid = randomUUID();
        await client.stageUpload(file, guid);
        const checked = await client.validateStagedUpload(validationRequest(target, guid));
        const { path, request } = submitRequest(target, facts, guid, new Date().toISOString());
        return sendOnce(
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
  );
}
