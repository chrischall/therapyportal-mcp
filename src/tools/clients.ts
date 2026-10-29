import { z } from 'zod';
import { resolveView, viewResult } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import { READ, asRecordArray, displayName, tidy } from './_shared.js';
import { ASSEMBLED_VIEWS, assembledViewArg } from '../view.js';

// The upstream record is the client's FULL demographic file — address, phones,
// email, an SSN field, billing notes, free-text comments. It is never passed
// through: both rungs are an allowlist built here, which is also why this tool
// has no `raw` rung.

export function registerClientTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_clients',
    {
      description:
        'List the clients (patients) linked to this TherapyPortal login — for a parent, each ' +
        'child in therapy — with the PatientId the message and document tools take. Returns names ' +
        'and date of birth only, never contact details or identifiers.',
      annotations: READ,
      inputSchema: z.object({ view: assembledViewArg() }),
    },
    async ({ view }) => {
      const rows = asRecordArray(await client.listClients());
      const full = view !== undefined && resolveView(view, ASSEMBLED_VIEWS) === 'full';
      const out = rows.map((p) =>
        full
          ? tidy({
              patientId: p.Id ?? p.PatientId,
              firstName: p.FirstName,
              middleName: p.MiddleName,
              lastName: p.LastName,
              nickname: p.Nickname,
              pronouns: p.PreferredPronouns,
              dateOfBirth: typeof p.DateOfBirth === 'string' ? p.DateOfBirth.slice(0, 10) : undefined,
            })
          : tidy({
              patientId: p.Id ?? p.PatientId,
              name: displayName(p.Nickname, p.FirstName),
              lastName: p.LastName,
            }),
      );
      return viewResult(full ? 'full' : 'compact', out);
    },
  );
}
