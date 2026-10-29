// File downloads. Both are read-only: a download retrieves a rendered PDF or a
// practice-uploaded file and changes no portal state. (The practice's activity
// log records it, as it records the same click in the portal.)
//
// The model names a document by its portal_document_id only; the owning client
// and the document's kind are looked up here from the live list, so a call
// cannot pair an id with the wrong client or route it down the wrong path.

import { z } from 'zod';
import { McpToolError, minifiedResult } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import type { DownloadIO } from '../download-io.js';
import type { DownloadedFile } from '../transport.js';
import { READ, asRecordArray, tidy } from './_shared.js';

const DEST = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Folder to save into (server transport, local install only). Must be inside ' +
      'THERAPYPORTAL_OUTPUT_DIR, or ~/Downloads / ~/Documents when that is unset.',
  );

/** Render a finished download for the model. */
export function renderDownload(file: DownloadedFile, io: DownloadIO, dest: string | undefined, fallbackName: string): CallToolResult {
  if (file.kind === 'saved') {
    return minifiedResult(
      tidy({
        saved_to: file.path,
        size_bytes: file.size,
        mime_type: file.mimeType,
        note: 'Saved by your browser to its download folder (browser-bridge transport).',
      }),
    );
  }
  const outcome = io.deliver({
    bytes: file.bytes,
    fileName: file.fileName ?? fallbackName,
    mimeType: file.contentType,
    dest,
  });
  const meta = { file_name: outcome.fileName, mime_type: outcome.mimeType, size_bytes: outcome.size };
  if (outcome.savedTo !== undefined) return minifiedResult(tidy({ saved_to: outcome.savedTo, ...meta }));
  if (outcome.tooLarge === true) {
    return minifiedResult(
      tidy({
        ...meta,
        note:
          'This file is too large to return inline. Download it on a local install, where it is ' +
          'written to THERAPYPORTAL_OUTPUT_DIR (or ~/Downloads).',
      }),
    );
  }
  return minifiedResult(tidy({ ...meta, base64: outcome.base64 }));
}

export function registerDownloadTools(server: McpServer, client: TherapyPortalClient, io: DownloadIO): void {
  server.registerTool(
    'therapyportal_download_document',
    {
      description:
        'Download a TherapyPortal document as a file, by portal_document_id from ' +
        'therapyportal_list_documents: a form the client completed (rendered to PDF by the portal) ' +
        'or a file the practice uploaded for review. ' +
        'Saves to disk and returns the path on a local install, or returns the bytes inline ' +
        '(base64) on a hosted runner.',
      annotations: READ,
      inputSchema: z.object({
        portal_document_id: z.number().int().positive().describe('portalDocumentId from therapyportal_list_documents.'),
        dest: DEST,
      }),
    },
    async ({ portal_document_id, dest }) => {
      const reqs = (await client.documentRequests('all')) as { PortalDocumentRequests?: unknown } | null;
      const doc = asRecordArray(reqs?.PortalDocumentRequests)
        .flatMap((r) => asRecordArray(r.PortalDocuments))
        .find((d) => d.PortalDocumentId === portal_document_id);
      if (doc === undefined) {
        throw new McpToolError(`No TherapyPortal document ${portal_document_id} on this account.`, {
          hint: 'Use a portalDocumentId from therapyportal_list_documents.',
        });
      }
      const file = await client.downloadDocument(
        portal_document_id,
        Number(doc.PatientId),
        Number(doc.PatientDocumentType),
      );
      return renderDownload(file, io, dest, `document-${portal_document_id}.pdf`);
    },
  );

  server.registerTool(
    'therapyportal_download_receipt',
    {
      description:
        'Download a therapy payment receipt as a PDF, by payment_id from ' +
        'therapyportal_list_receipts — e.g. to submit to insurance or an HSA/FSA. ' +
        'Saves to disk and returns the path on a local install, or returns the bytes inline ' +
        '(base64) on a hosted runner.',
      annotations: READ,
      inputSchema: z.object({
        payment_id: z.number().int().positive().describe('paymentId from therapyportal_list_receipts.'),
        dest: DEST,
      }),
    },
    async ({ payment_id, dest }) => {
      const file = await client.downloadReceipt(payment_id);
      return renderDownload(file, io, dest, `receipt-${payment_id}.pdf`);
    },
  );
}
