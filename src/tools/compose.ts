// Secure-message writes: start a new conversation with the practice, or reply
// in one. Both are confirm-gated (`defineWrite` + `registerWrite`): the practice
// receives the message and there is no unsend. Plus the read that feeds them,
// `therapyportal_list_message_topics`.
//
// Shapes are derived from the portal's own JS (SecureMessagingDataService,
// CreateMessageViewV2, ThreadViewV2; see docs/THERAPYPORTAL-API.md). The
// lookups (settings, topics, assigned clinician) were verified live,
// read-only; the two SENDS are UNVERIFIED on the wire — no automated run sends
// one, because each reaches the practice.

import { z } from 'zod';
import {
  McpToolError,
  NonEmptyString,
  UNTRUSTED_CONTENT_RULE,
  UNTRUSTED_DESCRIPTION_SUFFIX,
  defineWrite,
  registerWrite,
  untrustedEnvelope,
} from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import { ASSEMBLED_VIEWS, assembledViewArg, untrustedViewResponse } from '../view.js';
import { READ, asRecordArray, tidy } from './_shared.js';
import { requireClient, requireMessaging, messagingSettings } from './_lookups.js';
import { WRITE, compactResult, isUnknown, sendOnce, writeDescription } from './_writes.js';

/** AudienceType: who at the practice a topic reaches. */
export const AUDIENCE: Readonly<Record<number, string>> = { 0: 'administrative', 1: 'billing', 2: 'clinical' };
const CLINICAL = 2;

/** The portal's own body limit (CreateMessageViewV2). */
export const MAX_BODY_CHARS = 5000;
/** How much plain text the portal stores as the message preview. */
export const PREVIEW_CHARS = 500;

const TOPICS_WROTE = 'Topic names and messaging notices are written by the practice.';
const MESSAGES_WROTE = 'Message subjects and bodies are written by the practice and its staff.';
const NOT_URGENT =
  'Secure messages are not for emergencies: the practice may not read this promptly. In a crisis call ' +
  '988 or 911.';
const CHECK_SENT = 'therapyportal_list_message_threads for this client';

/** Escape text for an HTML text node. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The message body as the portal's rich-text editor emits it: one `<p>` per
 * line, HTML-escaped, an empty line as `<p><br></p>`.
 */
export function bodyHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`))
    .join('');
}

/** The three body fields both sends carry, from plain text (CRLF normalised to LF). */
export function messageParts(text: string): {
  MessagePreview: string;
  MessageBody: string;
  MessageBodyCount: number;
} {
  const plain = text.replace(/\r\n?/g, '\n');
  return { MessagePreview: plain.slice(0, PREVIEW_CHARS), MessageBody: bodyHtml(plain), MessageBodyCount: plain.length };
}

/** A message topic, projected. */
export interface Topic {
  topicId: number;
  audience: string;
  audienceType: number;
  description: string;
  sortOrder: number;
}

/** Project `messages/gettopicsforaudiences` records, sorted as the portal sorts them. */
export function projectTopics(raw: Record<string, unknown>[]): Topic[] {
  return raw
    .map((t) => ({
      topicId: Number(t.Id),
      audienceType: Number(t.Audience),
      audience: AUDIENCE[Number(t.Audience)] ?? String(t.Audience),
      description: typeof t.Description === 'string' ? t.Description.trim() : '',
      sortOrder: typeof t.SortOrder === 'number' ? t.SortOrder : 0,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

const BODY = z
  .string()
  .min(1)
  .max(MAX_BODY_CHARS)
  .refine((s) => s.trim() !== '', 'The message is blank.')
  .describe(`Message text, plain text (1-${MAX_BODY_CHARS} characters). Line breaks become paragraphs.`);

/** Render a send's result: practice-returned JSON goes out in the untrusted envelope. */
function renderSent(result: unknown, context: string): CallToolResult {
  if (isUnknown(result)) return compactResult(result);
  return untrustedViewResponse({ view: 'full', views: ['full'], data: result, whoWrote: MESSAGES_WROTE, context });
}

/** A send answered with something other than the created thread/message. */
function notSent(what: string, hint: string): McpToolError {
  return new McpToolError(`TherapyPortal did not confirm the ${what}.`, { hint });
}

const THROTTLE_HINT =
  'Nothing was sent. The portal may be limiting messages: it refuses new ones when you have sent ' +
  'several since the practice last answered. Wait for a reply, or contact the practice another way.';
const REPLY_HINT =
  'Nothing was sent. An archived conversation cannot be replied to — start a new one with ' +
  'therapyportal_send_message. The portal may also be limiting messages until the practice answers.';

export function registerComposeTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_message_topics',
    {
      description:
        'List the secure-message topics one client can write to in TherapyPortal (the topic_id ' +
        'therapyportal_send_message takes, and whether it reaches the clinical, billing or ' +
        'administrative staff), whether the practice has secure messaging turned on, and whether the ' +
        'client has an assigned clinician (without one, a clinical message may not reach a ' +
        'clinician). Changes nothing. ' +
        UNTRUSTED_DESCRIPTION_SUFFIX,
      annotations: READ,
      inputSchema: z.object({
        patient_id: z.number().int().positive().describe('The client’s patientId, from therapyportal_list_clients.'),
        view: assembledViewArg(),
      }),
    },
    async ({ patient_id, view }) => {
      await requireClient(client, patient_id);
      const settings = await messagingSettings(client);
      const raw = asRecordArray(await client.messageTopics(patient_id));
      const topics = projectTopics(raw);
      const hasAssignedClinician = await client.hasAssignedClinician(patient_id);
      return untrustedViewResponse({
        view,
        views: ASSEMBLED_VIEWS,
        data: { secureMessagingEnabled: settings.enabled, hasAssignedClinician, notices: settings.notices, topics: raw },
        whoWrote: TOPICS_WROTE,
        context: 'therapyportal_list_message_topics',
        project: () =>
          tidy({
            secureMessagingEnabled: settings.enabled,
            hasAssignedClinician,
            topics: topics.map((t) => tidy({ topicId: t.topicId, audience: t.audience, description: t.description })),
          }),
      });
    },
  );

  registerWrite(
    server,
    defineWrite({
      name: 'therapyportal_send_message',
      description: writeDescription(
        'Start a NEW secure-message conversation with the therapy practice in TherapyPortal, for one ' +
          'client, under a topic (topic_id from therapyportal_list_message_topics). The practice ' +
          'receives it and it cannot be unsent. Not for emergencies. Use therapyportal_reply_message ' +
          'to answer an existing conversation.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        patient_id: z.number().int().positive().describe('The client’s patientId, from therapyportal_list_clients.'),
        topic_id: z.number().int().min(0).describe('Topic id, from therapyportal_list_message_topics.'),
        subject: NonEmptyString.max(255).optional().describe('Subject. Default: the topic’s name, as the portal pre-fills it.'),
        body: BODY,
      }),
      async plan({ patient_id, topic_id, subject, body }) {
        const who = await requireClient(client, patient_id);
        await requireMessaging(client);
        const topics = projectTopics(asRecordArray(await client.messageTopics(patient_id)));
        const topic = topics.find((t) => t.topicId === topic_id);
        if (topic === undefined) {
          throw new McpToolError(`Topic ${topic_id} is not one this client can write to.`, {
            hint:
              `Valid topic ids: ${topics.map((t) => `${t.topicId} (${t.audience})`).join(', ') || 'none'}. ` +
              'See therapyportal_list_message_topics. Nothing was sent.',
          });
        }
        const finalSubject = subject ?? topic.description;
        if (finalSubject === '') {
          throw new McpToolError('This topic has no name to use as the subject.', {
            hint: 'Pass a subject. Nothing was sent.',
          });
        }
        const clinicianWarning =
          topic.audienceType === CLINICAL && !(await client.hasAssignedClinician(patient_id))
            ? 'This client has no assigned clinician, so a clinical message may not reach a clinician.'
            : undefined;
        const threadRequest = {
          InternalAddressees: [],
          ...messageParts(body),
          AddresseeType: 0,
          TopicId: topic.topicId,
          Audience: topic.audienceType,
          PatientId: patient_id,
          Subject: finalSubject,
        };
        return {
          gate: {
            action: 'therapyportal.send_message',
            summary: `Send a new secure message to the practice (${topic.audience} staff) about ${who.name ?? `client ${patient_id}`}`,
            account: undefined,
            target: `${patient_id}/${topic.topicId}`,
            request: { method: 'POST', path: 'messages/createnewthread', body: { ThreadRequest: threadRequest } },
            willSend: { client: who.name ?? patient_id, to: `${topic.audience} staff`, subject: finalSubject, body },
            preview: tidy({
              note: NOT_URGENT,
              warning: clinicianWarning,
              practiceText: untrustedEnvelope(
                { topic: topic.description },
                { note: `${TOPICS_WROTE} ${UNTRUSTED_CONTENT_RULE}` },
              ),
            }),
          },
          state: { fields: { ThreadRequest: JSON.stringify(threadRequest) }, subject: finalSubject },
        };
      },
      async execute({ fields, subject }) {
        return sendOnce(
          async () => {
            const thread = await client.submit('messages/createnewthread', fields, THROTTLE_HINT);
            if (thread === null || typeof thread !== 'object') throw notSent('new message', THROTTLE_HINT);
            return { sent: true, subject, thread };
          },
          'message',
          CHECK_SENT,
        );
      },
      render: (result) => renderSent(result, 'therapyportal_send_message'),
    }),
  );

  registerWrite(
    server,
    defineWrite({
      name: 'therapyportal_reply_message',
      description: writeDescription(
        'Reply in an existing TherapyPortal secure-message conversation (thread_id from ' +
          'therapyportal_list_message_threads). The practice receives it and it cannot be unsent. ' +
          'Leaves the conversation’s read state alone unless mark_thread_read is true (the practice ' +
          'can see read state). Archived conversations cannot be replied to. Not for emergencies.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        patient_id: z.number().int().positive().describe('The client’s patientId, from therapyportal_list_clients.'),
        thread_id: z.number().int().positive().describe('The conversation’s thread id, from therapyportal_list_message_threads.'),
        body: BODY,
        mark_thread_read: z
          .boolean()
          .default(false)
          .describe('Also mark the conversation read. Default false; set true only when the user asks.'),
      }),
      async plan({ patient_id, thread_id, body, mark_thread_read }) {
        const who = await requireClient(client, patient_id);
        await requireMessaging(client);
        // Strictly true: anything else (the default) leaves the read state alone.
        const markRead = mark_thread_read === true;
        const messageRequest = { ...messageParts(body), MessageType: 0, MarkThreadRead: markRead };
        const fields = {
          MessageRequest: JSON.stringify(messageRequest),
          ThreadId: String(thread_id),
          PatientId: String(patient_id),
        };
        return {
          gate: {
            action: 'therapyportal.reply_message',
            summary: `Reply in secure-message conversation ${thread_id} (${who.name ?? `client ${patient_id}`})`,
            account: undefined,
            target: thread_id,
            request: {
              method: 'POST',
              path: 'messages/respondtothread',
              body: { MessageRequest: messageRequest, ThreadId: thread_id, PatientId: patient_id },
            },
            willSend: { client: who.name ?? patient_id, threadId: thread_id, body, markThreadRead: markRead },
            preview: { note: NOT_URGENT },
          },
          state: { fields, threadId: thread_id },
        };
      },
      async execute({ fields, threadId }) {
        return sendOnce(
          async () => {
            const message = await client.submit('messages/respondtothread', fields, REPLY_HINT);
            if (message === null || typeof message !== 'object') throw notSent('reply', REPLY_HINT);
            return { sent: true, threadId, message };
          },
          'reply',
          `therapyportal_get_thread_messages for thread ${threadId}`,
        );
      },
      render: (result) => renderSent(result, 'therapyportal_reply_message'),
    }),
  );
}
