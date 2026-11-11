// Secure messages. The thread and message SHAPES have not been observed live
// (the account this was built against had no conversations), so these two
// tools hand back the portal's payload as-is — wrapped as untrusted text,
// since the practice writes it — rather than project fields that might not
// exist. Neither calls markthreadasread, so reading changes no read state.
// The one field known from the portal's JS is a message's `MessageBody`, the
// HTML its editor wrote (MessageViewV2 renders it), so that alone can be read
// as Markdown or text on request.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { UNTRUSTED_DESCRIPTION_SUFFIX } from '@chrischall/mcp-utils';
import { htmlToMarkdown, htmlToText } from '@chrischall/mcp-utils/rich';
import type { TherapyPortalClient } from '../client.js';
import { READ } from './_shared.js';
import { untrustedViewResponse } from '../view.js';
import { healthMeta } from './hints.js';

const WHO_WROTE = 'Message subjects and bodies are written by the practice and its staff.';
const PASS_THROUGH = ['full'] as const;

export type ReadFormat = 'html' | 'markdown' | 'text';

/**
 * The payload with every `MessageBody` string read in `format`, wherever it
 * sits (the messages shape is unverified, so it is searched for, not assumed).
 * Everything else is returned as sent.
 */
export function readBodies(data: unknown, format: ReadFormat): unknown {
  if (format === 'html') return data;
  const read = format === 'markdown' ? htmlToMarkdown : (html: string) => htmlToText(html, { paragraphs: true });
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === 'MessageBody' && typeof x === 'string' ? read(x) : walk(x)]),
    );
  };
  return walk(data);
}

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
      _meta: healthMeta('whats-new', { aliases: ['therapist messages', 'messages from the therapist', 'inbox'] }),
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
      _meta: healthMeta('lookup'),
      inputSchema: z.object({
        thread_id: z.number().int().positive().describe('The thread id.'),
        format: z
          .enum(['html', 'markdown', 'text'])
          .optional()
          .describe(
            'How each MessageBody comes back: "html" (default, as the portal stores it), "markdown" (keeps ' +
              'lists, emphasis and links in fewer tokens) or "text". Hidden text is dropped from both.',
          ),
      }),
    },
    async ({ thread_id, format }) => {
      const raw = await client.messages(thread_id);
      return untrustedViewResponse({
        view: 'full',
        views: PASS_THROUGH,
        data: raw === null || raw === undefined ? { messages: [] } : readBodies(raw, format ?? 'html'),
        whoWrote: WHO_WROTE,
        context: 'therapyportal_get_thread_messages',
      });
    },
  );
}
