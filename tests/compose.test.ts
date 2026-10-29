import { describe, expect, it } from 'vitest';
import { bodyHtml, escapeHtml, messageParts, projectTopics, registerComposeTools } from '../src/tools/compose.js';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TherapyPortalClient } from '../src/client.js';
import { FakeTransport, capture, gated, jsonOf, okJson, textOf, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Synthetic portal answers in the spec's shapes — invented names and ids only.
const CLIENTS = [
  { Id: 101, FirstName: 'Robin', LastName: 'Example', Nickname: '' },
  { PatientId: 102, FirstName: 'Sam', Nickname: 'Sammy' },
  { Id: 104 },
];
const SETTINGS = {
  PracticeSettings: {
    SecureMessagingEnabled: true,
    PortalMessage: 'Allow two business days.',
    ShowPortalAdminMessage: true,
    PortalAdminMessageEnglish: 'Front desk notice',
    ShowPortalBillingMessage: false,
    PortalBillingMessageEnglish: 'hidden billing notice',
  },
  Topics: [],
};
const TOPICS = [
  { Id: 12, PracticeId: 7, Audience: 2, Description: 'Clinical question ', Status: 1, SortOrder: 2 },
  { Id: 10, PracticeId: 7, Audience: 0, Description: 'Scheduling', Status: 1, SortOrder: 0 },
  { Id: 11, PracticeId: 7, Audience: 1, Description: '', Status: 1 },
];

function portal(over: Record<string, FetchResult> = {}) {
  return (call: FakeCall): FetchResult => {
    if (over[call.path] !== undefined) return over[call.path]!;
    switch (call.path) {
      case 'document/getpatientsforportaluser':
        return okJson(CLIENTS);
      case 'messages/getsettings':
        return okJson(SETTINGS);
      case 'messages/gettopicsforaudiences':
        return okJson(TOPICS);
      case 'messages/checkifpatienthasassignedclinician':
        return { status: 200, body: 'true' };
      case 'messages/createnewthread':
        return okJson({ ThreadId: 555, Subject: 'echo' });
      case 'messages/respondtothread':
        return okJson({ MessageId: 777 });
      default:
        throw new Error(`unexpected ${call.path}`);
    }
  };
}

function rig(over: Record<string, FetchResult> = {}) {
  const { handlers, transport } = capture(registerComposeTools, portal(over));
  return {
    transport,
    topics: handlers.get('therapyportal_list_message_topics')!,
    send: gated(handlers.get('therapyportal_send_message')!, transport),
    reply: gated(handlers.get('therapyportal_reply_message')!, transport),
  };
}

const sends = (calls: FakeCall[]) => calls.filter((c) => c.via === 'send');

describe('message body helpers', () => {
  it('escapes HTML and builds one <p> per line, empty lines as <p><br></p>', () => {
    expect(escapeHtml(`<b>"a" & b</b>`)).toBe('&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;');
    expect(bodyHtml('Hi <there>\n\nBye')).toBe('<p>Hi &lt;there&gt;</p><p><br></p><p>Bye</p>');
  });
  it('previews the first 500 chars and counts the plain text (CRLF normalised)', () => {
    const long = 'x'.repeat(600);
    expect(messageParts(long)).toMatchObject({ MessagePreview: 'x'.repeat(500), MessageBodyCount: 600 });
    expect(messageParts('a\r\nb')).toEqual({ MessagePreview: 'a\nb', MessageBody: '<p>a</p><p>b</p>', MessageBodyCount: 3 });
  });
  it('projects topics sorted by SortOrder, naming the audience', () => {
    expect(projectTopics([{ Id: 1, Audience: 9, Description: 5 }]).at(0)).toEqual({
      topicId: 1, audienceType: 9, audience: '9', description: '', sortOrder: 0,
    });
    expect(projectTopics(TOPICS).map((t) => t.topicId)).toEqual([10, 11, 12]);
  });
});

describe('therapyportal_list_message_topics', () => {
  it('compact: flags plus topics, inside the untrusted envelope; changes nothing', async () => {
    const { topics, transport } = rig();
    const out = jsonOf(await topics({ patient_id: 101 })) as Record<string, unknown>;
    expect(out.untrusted_content).toBe(true);
    expect(out).toMatchObject({
      secureMessagingEnabled: true,
      hasAssignedClinician: true,
      topics: [
        { topicId: 10, audience: 'administrative', description: 'Scheduling' },
        { topicId: 11, audience: 'billing' },
        { topicId: 12, audience: 'clinical', description: 'Clinical question' },
      ],
    });
    expect(sends(transport.calls)).toEqual([]);
  });

  it('full: the raw topic records and the shown notices only', async () => {
    const { topics } = rig();
    const text = textOf(await topics({ patient_id: 101, view: 'full' }));
    const out = JSON.parse(text) as Record<string, unknown>;
    expect(out.notices).toEqual({ portal: 'Allow two business days.', administrative: 'Front desk notice' });
    expect(text).not.toContain('hidden billing notice');
    expect((out.topics as unknown[])[0]).toMatchObject({ Id: 12, PracticeId: 7 });
  });

  it('refuses a patient not linked to this login', async () => {
    await expect(rig().topics({ patient_id: 999 })).rejects.toMatchObject({
      message: expect.stringMatching(/Client 999 is not linked/),
      hint: expect.stringMatching(/101, 102/),
    });
  });

  it('reports messaging off without failing', async () => {
    const off = rig({ 'messages/getsettings': okJson({ PracticeSettings: { SecureMessagingEnabled: false } }) });
    expect(jsonOf(await off.topics({ patient_id: 101 }))).toMatchObject({ secureMessagingEnabled: false });
  });
});

describe('therapyportal_send_message', () => {
  const args = { patient_id: 101, topic_id: 12, body: 'Hello <team>\nLine two' };

  it('phase 1 previews, sends nothing, and fences the topic name as untrusted', async () => {
    const { send, transport } = rig();
    const preview = await send.preview(args);
    expect(typeof preview.confirmToken).toBe('string');
    expect(sends(transport.calls)).toEqual([]);
    const text = JSON.stringify(preview);
    expect(text).toContain('clinical staff');
    expect(text).toContain('untrusted_content');
    expect(text).toContain('Clinical question');
  });

  it('confirmed: posts createnewthread ONCE via the write path with the portal’s ThreadRequest', async () => {
    const { send, transport } = rig();
    const out = await send.confirmed(args);
    const posted = sends(transport.calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe('messages/createnewthread');
    expect(JSON.parse(posted[0]!.fields.ThreadRequest!)).toEqual({
      InternalAddressees: [],
      MessagePreview: 'Hello <team>\nLine two',
      MessageBody: '<p>Hello &lt;team&gt;</p><p>Line two</p>',
      MessageBodyCount: 21,
      AddresseeType: 0,
      TopicId: 12,
      Audience: 2,
      PatientId: 101,
      Subject: 'Clinical question',
    });
    expect(out).toMatchObject({ untrusted_content: true, sent: true, subject: 'Clinical question', thread: { ThreadId: 555 } });
  });

  it('names a client with no name by id', async () => {
    const { send, reply } = rig();
    const s1 = JSON.stringify(await send.preview({ ...args, patient_id: 104 }));
    expect(s1).toContain('about client 104');
    expect(s1).toContain('"client":104');
    const s2 = JSON.stringify(await reply.preview({ patient_id: 104, thread_id: 1, body: 'x' }));
    expect(s2).toContain('(client 104)');
    expect(s2).toContain('"client":104');
  });

  it('says "none" when no client is linked', async () => {
    const empty = rig({ 'document/getpatientsforportaluser': okJson(null) });
    await expect(empty.send.raw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/Valid patient ids: none/) });
  });

  it('uses an explicit subject', async () => {
    const { send, transport } = rig();
    await send.confirmed({ ...args, subject: 'Custom' });
    expect(JSON.parse(sends(transport.calls)[0]!.fields.ThreadRequest!).Subject).toBe('Custom');
  });

  it('warns when a clinical message has no assigned clinician to reach', async () => {
    const r = rig({ 'messages/checkifpatienthasassignedclinician': { status: 200, body: 'false' } });
    expect(JSON.stringify(await r.send.preview(args))).toContain('no assigned clinician');
    const admin = await r.send.preview({ ...args, topic_id: 10 });
    expect(JSON.stringify(admin)).not.toContain('no assigned clinician');
  });

  it('refuses an unknown topic, messaging off, an unlinked client and a nameless default subject', async () => {
    const r = rig();
    await expect(r.send.raw({ ...args, topic_id: 99 })).rejects.toMatchObject({
      message: expect.stringMatching(/Topic 99 is not one/),
      hint: expect.stringMatching(/10 \(administrative\)/),
    });
    const noTopics = rig({ 'messages/gettopicsforaudiences': okJson(null) });
    await expect(noTopics.send.raw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/Valid topic ids: none/) });
    const off = rig({ 'messages/getsettings': okJson({}) });
    await expect(off.send.raw(args)).rejects.toThrow(/secure messaging turned off/);
    await expect(r.send.raw({ ...args, patient_id: 5 })).rejects.toThrow(/not linked/);
    await expect(r.send.raw({ ...args, topic_id: 11 })).rejects.toThrow(/no name to use as the subject/);
    expect(sends(r.transport.calls)).toEqual([]);
  });

  it('refuses a blank or over-long body at the schema, before any read', async () => {
    const transport = new FakeTransport(portal());
    const h = await createTestHarness((server) => registerComposeTools(server, new TherapyPortalClient({ transport })));
    for (const body of ['   ', 'x'.repeat(5001)]) {
      const res = await h.client.callTool({ name: 'therapyportal_send_message', arguments: { ...args, body } });
      expect(res.isError, body.slice(0, 5)).toBe(true);
    }
    await h.close();
    expect(transport.calls).toEqual([]);
  });

  it('a non-object answer is an error hinting at the practice’s throttle', async () => {
    const r = rig({ 'messages/createnewthread': okJson(false) });
    await expect(r.send.confirmedRaw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/limiting messages/) });
  });

  it('a 5xx after sending is status "unknown", not an error', async () => {
    const r = rig({ 'messages/createnewthread': { status: 502, body: '' } });
    const out = await r.send.confirmed(args);
    expect(out.status).toBe('unknown');
    expect(String(out.warning)).toMatch(/therapyportal_list_message_threads/);
  });
});

describe('therapyportal_reply_message', () => {
  const args = { patient_id: 102, thread_id: 44, body: 'Thanks!' };

  it('confirmed: respondtothread once, MarkThreadRead false by default', async () => {
    const { reply, transport } = rig();
    const out = await reply.confirmed(args);
    const posted = sends(transport.calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe('messages/respondtothread');
    expect(posted[0]!.fields.ThreadId).toBe('44');
    expect(posted[0]!.fields.PatientId).toBe('102');
    expect(JSON.parse(posted[0]!.fields.MessageRequest!)).toEqual({
      MessagePreview: 'Thanks!',
      MessageBody: '<p>Thanks!</p>',
      MessageBodyCount: 7,
      MessageType: 0,
      MarkThreadRead: false,
    });
    expect(out).toMatchObject({ untrusted_content: true, sent: true, threadId: 44, message: { MessageId: 777 } });
  });

  it('passes mark_thread_read through when asked, and previews it', async () => {
    const { reply, transport } = rig();
    expect(JSON.stringify(await reply.preview({ ...args, mark_thread_read: true }))).toContain('"markThreadRead":true');
    await reply.confirmed({ ...args, mark_thread_read: true });
    expect(JSON.parse(sends(transport.calls)[0]!.fields.MessageRequest!).MarkThreadRead).toBe(true);
  });

  it('a refused reply says nothing was sent and points at archived threads', async () => {
    const r = rig({ 'messages/respondtothread': { status: 200, body: 'null' } });
    await expect(r.reply.confirmedRaw(args)).rejects.toMatchObject({ hint: expect.stringMatching(/archived/) });
  });

  it('a dropped connection after sending is status "unknown"', async () => {
    const r = rig();
    r.transport.send = async () => {
      throw new Error('socket hang up');
    };
    const out = await r.reply.confirmed(args);
    expect(out.status).toBe('unknown');
    expect(String(out.warning)).toMatch(/thread 44/);
  });

  it('refuses when messaging is off', async () => {
    const off = rig({ 'messages/getsettings': okJson({ PracticeSettings: { SecureMessagingEnabled: false } }) });
    await expect(off.reply.raw(args)).rejects.toThrow(/turned off/);
  });
});
