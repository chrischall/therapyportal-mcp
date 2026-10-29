// Secure messages. The thread and message SHAPES have not been observed live
// (the account this was built against had no conversations), so these two
// tools hand back the portal's payload as-is — wrapped as untrusted text,
// since the practice writes it — rather than project fields that might not
// exist. Neither calls markthreadasread, so reading changes no read state.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX } from '@chrischall/mcp-utils';
import type { TherapyPortalClient } from '../client.js';
import { READ } from './_shared.js';
import { untrustedViewResponse } from '../view.js';

const WHO_WROTE = 'Message subjects and bodies are written by the practice and its staff.';
const PASS_THROUGH = ['full'] as const;

export function registerMessageTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_message_threads',
    {
      description:
        'List one client’s secure-message conversations with the therapy practice in ' +
        'TherapyPortal, newest first (patient_id from therapyportal_list_clients). Listing does not ' +
        'mark anything read. Returned as the portal sends them; an empty inbox is `threads: []`. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      inputSchema: z.object({
        patient_id: z.number().int().positive().describe('The client’s patientId.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Most threads to return. Default 50.'),
      }),
    },
    async ({ patient_id, limit }) => {
      const raw = await client.threads(patient_id, limit);
      return untrustedViewResponse({
        view: 'full',
        views: PASS_THROUGH,
        data: raw ?? { threads: [] },
        whoWrote: WHO_WROTE,
        context: 'therapyportal_list_message_threads',
      });
    },
  );

  server.registerTool(
    'therapyportal_get_thread_messages',
    {
      description:
        'Read the messages in one TherapyPortal secure-message conversation, by its thread id from ' +
        'therapyportal_list_message_threads. Does not mark the conversation read. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      inputSchema: z.object({
        thread_id: z.number().int().positive().describe('The thread id.'),
      }),
    },
    async ({ thread_id }) => {
      const raw = await client.messages(thread_id);
      return untrustedViewResponse({
        view: 'full',
        views: PASS_THROUGH,
        data: raw ?? { messages: [] },
        whoWrote: WHO_WROTE,
        context: 'therapyportal_get_thread_messages',
      });
    },
  );
}
