import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX } from '@chrischall/mcp-utils';
import type { TherapyPortalClient } from '../client.js';
import { READ, asRecordArray, displayName, tidy } from './_shared.js';
import { PASSTHROUGH_VIEWS, untrustedViewResponse, viewArg, viewResponse } from '../view.js';

const REQUEST_STATUS: Record<string, string> = { '1': 'pending', '4': 'in_progress', '5': 'completed' };
const DOCUMENT_STATUS: Record<string, string> = { '1': 'pending', '2': 'in_progress', '3': 'completed' };
/** PatientDocumentType values seen on portal documents. */
const DOCUMENT_KIND: Record<string, string> = { '0': 'practice_file', '3': 'portal_form' };

const PRACTICE_WROTE = 'Document titles and instructions are written by the practice.';

export function registerDocumentTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_documents',
    {
      description:
        'List paperwork the practice sent through TherapyPortal — intake and consent forms, ' +
        'questionnaires, files sent for review — with each request’s status, date and ' +
        'instructions, and each document’s portal_document_id for therapyportal_download_document ' +
        '(or, when it asks for a file, therapyportal_upload_document). ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      inputSchema: z.object({
        status: z
          .enum(['pending', 'completed', 'all'])
          .default('all')
          .describe('pending = still to fill in; completed = done. Default all.'),
        view: viewArg(),
      }),
    },
    async ({ status, view }) => {
      const raw = await client.documentRequests(status);
      return untrustedViewResponse({
        view,
        views: PASSTHROUGH_VIEWS,
        data: raw,
        whoWrote: PRACTICE_WROTE,
        context: 'therapyportal_list_documents',
        project: (data) => {
          const reqs = (data as { PortalDocumentRequests?: unknown } | null)?.PortalDocumentRequests;
          if (!Array.isArray(reqs)) return undefined;
          return asRecordArray(reqs).map((r) =>
            tidy({
              requestId: r.RequestId,
              status: REQUEST_STATUS[String(r.RequestStatus)] ?? r.RequestStatus,
              client: displayName(r.PatientNickName, r.PatientFirstName),
              patientId: r.PatientId,
              sent: r.RequestDateCreated,
              instructions: r.VersionInstructions,
              documents: asRecordArray(r.PortalDocuments).map((d) =>
                tidy({
                  portalDocumentId: d.PortalDocumentId,
                  title: d.Title,
                  kind: DOCUMENT_KIND[String(d.PatientDocumentType)] ?? d.PatientDocumentType,
                  status: DOCUMENT_STATUS[String(d.PortalDocumentStatus)] ?? d.PortalDocumentStatus,
                  completed: d.PortalDocumentDateCompleted,
                  uploadRequired: d.IsUploadRequired,
                  signatureRequired: d.PatientSignatureRequired,
                }),
              ),
            }),
          );
        },
      });
    },
  );

  server.registerTool(
    'therapyportal_list_forms',
    {
      description:
        'List the practice’s always-available forms and documents in TherapyPortal — standing ' +
        'paperwork such as a disclosure statement to sign or a document to upload — and whether ' +
        'each needs a signature or an upload, with the libraryDocumentId therapyportal_upload_document ' +
        'takes. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.alwaysAvailableDocuments();
      return untrustedViewResponse({
        view,
        views: PASSTHROUGH_VIEWS,
        data: raw,
        whoWrote: PRACTICE_WROTE,
        context: 'therapyportal_list_forms',
        project: (data) => {
          if (!Array.isArray(data)) return undefined;
          return asRecordArray(data).map((f) =>
            tidy({
              libraryDocumentId: f.PatientDocumentKey,
              title: f.Title,
              description: f.DocumentDescription,
              patientId: f.PatientId,
              signatureRequired: f.PatientSignatureRequired,
              uploadRequired: f.IsUploadRequired,
              fileName: f.OriginalFileName,
            }),
          );
        },
      });
    },
  );

  server.registerTool(
    'therapyportal_get_document_counts',
    {
      description:
        'Per client: how many TherapyPortal documents are still waiting to be completed, or ' +
        'completed and awaiting the practice’s approval, split into clinical, administrative and ' +
        'billing paperwork. A quick “do I owe the therapist any forms?” check.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.documentCounts();
      return viewResponse(view, raw, (data) => {
        if (!Array.isArray(data)) return undefined;
        return asRecordArray(data).map((c) =>
          tidy({
            patientId: c.PatientId,
            toComplete: {
              clinical: c.ClinicalPortalDocumentsPendingCompletion,
              administrative: c.AdministrativePortalDocumentsPendingCompletion,
              billing: c.BillingPortalDocumentsPendingCompletion,
            },
            awaitingApproval: {
              clinical: c.ClinicalPortalDocumentsPendingApproval,
              administrative: c.AdministrativePortalDocumentsPendingApproval,
              billing: c.BillingPortalDocumentsPendingApproval,
            },
          }),
        );
      });
    },
  );
}
