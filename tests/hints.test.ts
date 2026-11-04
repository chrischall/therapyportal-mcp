// Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
// asserted against the SERVED tool list — what a host reads — plus the brief
// view and the client (subject) enum the two canonical reads publish.
//
// Every fixture is synthetic: invented names and ids.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TherapyPortalClient } from '../src/client.js';
import { registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { healthMeta, withToolMeta } from '../src/tools/hints.js';
import {
  CLIENT_LIST_TIMEOUT_MS,
  briefLine,
  buildClientDirectory,
  loadClientDirectory,
  type ClientDirectory,
} from '../src/tools/subjects.js';
import { FakeTransport, okJson, registerAll, stubTransport, type FakeCall } from './_tools.js';

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const WHATS = ['whats-new', 'whats-due', 'whats-on'];

const CLIENTS = [
  { Id: 101, FirstName: 'Robin', LastName: 'Example', Nickname: '' },
  { PatientId: 102, FirstName: 'Sam', LastName: 'Example', Nickname: 'Sammy' },
];

const APPTS = {
  PracticeName: 'Example Practice',
  Appointments: [
    {
      ApptId: 2, StartDate: '2026-11-05T10:00:00', CalendarEntryTypeName: 'Therapy Session', ClinicianDisplayName: 'Dr Example',
      IsTelehealth: false, LocationName: 'Office', Patients: [{ FirstName: 'Sam', Nickname: 'Sammy' }], PendingReschedule: true,
    },
    { ApptId: 1, StartDate: '2026-11-01T10:00:00', IsTelehealth: true, Patients: [{ PatientId: 101, FirstName: 'Robin' }], PendingCancel: true },
    { ApptId: 3, StartDate: '2026-11-08T09:00:00', ClinicianDisplayName: 'Dr Example', Patients: [{ FirstName: 'Robin' }] },
    { ApptId: 4, Patients: null },
  ],
  AppointmentRequests: [],
};

const DOC_REQS = {
  PortalDocumentRequests: [
    {
      RequestId: 9, RequestStatus: 1, PatientId: 101, PatientFirstName: 'Robin', RequestDateCreated: '2026-10-01T00:00:00',
      PortalDocuments: [
        { PortalDocumentId: 501, Title: 'Intake questionnaire', PortalDocumentStatus: 1, PatientId: 101 },
        { PortalDocumentId: 502, Title: 'x'.repeat(200), PortalDocumentStatus: 2, PatientId: 101 },
      ],
    },
    { RequestId: 10, RequestStatus: 4, PatientId: 102, PatientNickName: 'Sammy', PortalDocuments: null },
    { RequestId: 11, RequestStatus: 7, PatientId: 102, PortalDocuments: [{ Title: 'Odd', PortalDocumentStatus: 9 }, { Title: ' ', PortalDocumentStatus: 3 }] },
  ],
};

function responder(call: FakeCall) {
  if (call.path === 'document/getpatientsforportaluser') return okJson(CLIENTS);
  if (call.path === 'appointments/appointmentinformation') return okJson(APPTS);
  if (call.path === 'documents/api/getportaluserdocumentrequestsbystatus') return okJson(DOC_REQS);
  return okJson(null);
}

function newClient(transport = new FakeTransport(responder)) {
  return { transport, client: new TherapyPortalClient({ transport, sleep: async () => {}, pollIntervalMs: 0 }) };
}

async function harness(directory?: ClientDirectory | null, transport?: FakeTransport) {
  const { client } = newClient(transport);
  return createTestHarness((server) => {
    registerAll(server as never, client, undefined, directory);
    registerHealthcheckTool(server, client, 'www.therapyportal.com/p/example777', {
      bridge: undefined,
      credentialsConfigured: true,
    });
  });
}

async function served(directory?: ClientDirectory | null): Promise<Listed[]> {
  const h = await harness(directory);
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const DIRECTORY = buildClientDirectory([
  { patientId: 101, name: 'Robin' },
  { patientId: 102, name: 'Sammy' },
])!;

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  therapyportal_list_clients: 'lookup',
  therapyportal_list_appointments: 'whats-on',
  therapyportal_list_documents: 'whats-due',
  therapyportal_list_forms: 'lookup',
  therapyportal_get_document_counts: 'whats-due',
  therapyportal_list_balances: 'whats-due',
  therapyportal_list_receipts: 'lookup',
  therapyportal_list_message_threads: 'whats-new',
  therapyportal_get_thread_messages: 'lookup',
  therapyportal_list_message_topics: 'lookup',
  therapyportal_download_document: 'other',
  therapyportal_download_receipt: 'other',
  therapyportal_send_message: 'send',
  therapyportal_reply_message: 'send',
  therapyportal_upload_document: 'send',
};

const BRIEF_LINE = /^.+ — (?:[a-z]+ )?(?:\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?|no date) — [a-z][a-z ]*$/;

describe('_meta.mint on tools/list', () => {
  it('every tool except the healthcheck declares domain health and the intent in the table', async () => {
    const tools = await served();
    const hinted = tools.filter((t) => !t.name.endsWith('_healthcheck'));
    expect(hinted.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
    for (const t of hinted) {
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('health');
      expect(INTENTS).toContain(m!.intent);
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
    // therapyportal_healthcheck is registered by mcp-utils and joins no group.
    expect(tools.find((t) => t.name === 'therapyportal_healthcheck')?._meta?.mint).toBeUndefined();
  });

  it('canonical only on read-only whats-* reads, at most one per intent', async () => {
    const tools = await served();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical !== undefined);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(WHATS, t.name).toContain(t._meta!.mint!.intent);
    }
    for (const intent of WHATS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
    expect(canonical.map((t) => [t.name, t._meta!.mint!.intent]).sort()).toEqual([
      ['therapyportal_list_appointments', 'whats-on'],
      ['therapyportal_list_documents', 'whats-due'],
    ]);
  });

  it('aliases are spoken words: at most 8, lowercase, at most 40 chars, never tool names', async () => {
    for (const t of await served()) {
      const aliases = t._meta?.mint?.aliases as string[] | undefined;
      if (!aliases) continue;
      expect(aliases.length, t.name).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a.length, t.name).toBeLessThanOrEqual(40);
        expect(a, t.name).toBe(a.toLowerCase());
        expect(a, t.name).not.toMatch(/therapyportal_|_/);
      }
    }
  });

  it('a declared subject or when names arguments the tool really takes', async () => {
    for (const t of await served(DIRECTORY)) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      if (m.subject !== undefined) expect(props, t.name).toHaveProperty(m.subject as string);
      if (m.when !== undefined) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start!);
        expect(props, t.name).toHaveProperty(when.end!);
      }
    }
  });

  it('the canonical reads take the client as their subject (they take no date range)', async () => {
    const tools = await served();
    for (const name of ['therapyportal_list_appointments', 'therapyportal_list_documents']) {
      const m = tools.find((t) => t.name === name)!._meta!.mint!;
      expect(m.subject, name).toBe('client');
      expect(m.when, name).toBeUndefined();
    }
  });
});

describe('the client enum on the subject argument', () => {
  it('publishes the client labels as an enum when the clients were listed at start', async () => {
    const tools = await served(DIRECTORY);
    for (const name of ['therapyportal_list_appointments', 'therapyportal_list_documents']) {
      const prop = tools.find((t) => t.name === name)!.inputSchema.properties!.client!;
      expect(prop.enum, name).toEqual(['Robin', 'Sammy']);
      expect(prop.type, name).toBe('string');
    }
  });

  it('keeps the property, with no enum, when the listing failed — never an empty enum', async () => {
    for (const directory of [null, undefined]) {
      const tools = await served(directory);
      for (const name of ['therapyportal_list_appointments', 'therapyportal_list_documents']) {
        const prop = tools.find((t) => t.name === name)!.inputSchema.properties!.client!;
        expect(prop, name).not.toHaveProperty('enum');
        expect(prop.type, name).toBe('string');
      }
    }
  });
});

describe('view: brief on the canonical reads', () => {
  /**
   * The brief lines: both reads answer the untrusted envelope (`data`), since
   * document titles, appointment types, clinician and location names are all
   * the practice's text.
   */
  function briefLines(_name: string, text: string): string[] {
    expect(text.startsWith('{"untrusted_content":true,"note":')).toBe(true);
    return (JSON.parse(text) as { data: string[] }).data;
  }

  async function brief(name: string, args: Record<string, unknown>, directory: ClientDirectory | null = DIRECTORY) {
    const transport = new FakeTransport(responder);
    const h = await harness(directory, transport);
    const res = (await h.callTool(name, { view: 'brief', ...args })) as { content: { text: string }[]; isError?: boolean };
    await h.close();
    const text = res.content[0]!.text;
    return { text, lines: res.isError ? [] : briefLines(name, text), isError: res.isError, transport };
  }

  it('appointments: one line per appointment, soonest first, title — ISO date — status', async () => {
    const { text, lines } = await brief('therapyportal_list_appointments', {});
    expect((JSON.parse(text) as { note: string }).note).toContain('written by the practice');
    expect(lines).toEqual([
      'Appointment (telehealth) for Robin — 2026-11-01T10:00:00 — cancellation requested',
      'Therapy Session with Dr Example (Office) for Sammy — 2026-11-05T10:00:00 — reschedule requested',
      'Appointment with Dr Example for Robin — 2026-11-08T09:00:00 — scheduled',
      'Appointment — no date — scheduled',
    ]);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(120);
      expect(l).toMatch(BRIEF_LINE);
    }
  });

  it('appointments: honours limit, and filters to one client by label (any case) or by patientId', async () => {
    // A page cut by limit says so with a note, never silently.
    expect((await brief('therapyportal_list_appointments', { limit: 1 })).lines).toEqual([
      'Appointment (telehealth) for Robin — 2026-11-01T10:00:00 — cancellation requested',
      '-- 1 of 4 shown',
    ]);
    const byLabel = (await brief('therapyportal_list_appointments', { client: 'robin' })).lines;
    expect(byLabel).toEqual([
      'Appointment (telehealth) for Robin — 2026-11-01T10:00:00 — cancellation requested',
      'Appointment with Dr Example for Robin — 2026-11-08T09:00:00 — scheduled',
    ]);
    expect((await brief('therapyportal_list_appointments', { client: '102' })).lines).toEqual([
      'Therapy Session with Dr Example (Office) for Sammy — 2026-11-05T10:00:00 — reschedule requested',
    ]);
  });

  it('the subject filter also applies to the compact rung', async () => {
    const transport = new FakeTransport(responder);
    const h = await harness(DIRECTORY, transport);
    const res = (await h.callTool('therapyportal_list_appointments', { client: 'Sammy' })) as { content: { text: string }[] };
    await h.close();
    const out = JSON.parse(res.content[0]!.text) as { total: number; appointments: { apptId: number }[] };
    expect(out.total).toBe(1);
    expect(out.appointments.map((a) => a.apptId)).toEqual([2]);
  });

  it('documents: one line per document still to do, title — sent date — status, inside the untrusted envelope', async () => {
    const { text, transport } = await brief('therapyportal_list_documents', {});
    // Titles are the practice's text: the lines are the envelope's data array,
    // marker first, as the compact/full/raw rungs of the same tool answer.
    const out = JSON.parse(text) as { untrusted_content: boolean; note: string; data: string[] };
    expect(text.startsWith('{"untrusted_content":true,"note":')).toBe(true);
    expect(out.untrusted_content).toBe(true);
    expect(out.note).toContain('Document titles and instructions are written by the practice.');
    const lines = out.data;
    expect(lines[0]).toBe('Intake questionnaire for Robin — sent 2026-10-01 — pending');
    expect(lines[1]).toMatch(/^x+… — sent 2026-10-01 — in progress$/);
    expect(lines[2]).toBe('Paperwork request for Sammy — no date — in progress');
    expect(lines[3]).toBe('Odd — no date — unknown');
    expect(lines[4]).toBe('Document — no date — completed');
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(120);
      expect(l).toMatch(BRIEF_LINE);
    }
    // brief with no status asks the portal for what is still to do (pending + in progress).
    expect(transport.calls.at(-1)!.fields.Request).toBe('[1,4]');
  });

  it('documents: an explicit status wins, and the client filter narrows the lines', async () => {
    const { text, transport } = await brief('therapyportal_list_documents', { status: 'all', client: 'Sammy' });
    expect((JSON.parse(text) as { data: string[] }).data).toEqual([
      'Paperwork request for Sammy — no date — in progress',
      'Odd — no date — unknown',
      'Document — no date — completed',
    ]);
    expect(transport.calls.at(-1)!.fields.Request).toBe('[1,4,5]');
  });

  it('documents: the compact rung without a status still lists everything', async () => {
    const transport = new FakeTransport(responder);
    const h = await harness(DIRECTORY, transport);
    const res = (await h.callTool('therapyportal_list_documents', { client: 'Robin' })) as { content: { text: string }[] };
    await h.close();
    const out = JSON.parse(res.content[0]!.text) as { data: { requestId: number }[] };
    expect(out.data.map((r) => r.requestId)).toEqual([9]);
    expect(transport.calls.at(-1)!.fields.Request).toBe('[1,4,5]');
  });

  it('an empty answer is the single note line -- none', async () => {
    const empty = new FakeTransport((call) =>
      call.path === 'appointments/appointmentinformation' ? okJson({ Appointments: [] }) : okJson({ PortalDocumentRequests: [] }),
    );
    for (const name of ['therapyportal_list_appointments', 'therapyportal_list_documents']) {
      const h = await harness(DIRECTORY, empty);
      const res = (await h.callTool(name, { view: 'brief' })) as { content: { text: string }[] };
      await h.close();
      expect(briefLines(name, res.content[0]!.text), name).toEqual(['-- none']);
    }
  });

  it('an unexpected payload shape is an -- error note, not a crash or an empty answer', async () => {
    const odd = new FakeTransport(() => okJson({ Something: 1 }));
    for (const name of ['therapyportal_list_appointments', 'therapyportal_list_documents']) {
      const h = await harness(DIRECTORY, odd);
      const res = (await h.callTool(name, { view: 'brief' })) as { content: { text: string }[]; isError?: boolean };
      await h.close();
      expect(res.isError, name).toBeFalsy();
      const lines = briefLines(name, res.content[0]!.text);
      expect(lines, name).toHaveLength(1);
      expect(lines[0], name).toMatch(/^-- error: .+/);
    }
  });

  it('refuses an unknown client label and names the clients it knows', async () => {
    const { text, isError } = await brief('therapyportal_list_appointments', { client: 'Alex' });
    expect(isError).toBe(true);
    expect(text).toMatch(/No client named "Alex"/);
    expect(text).toMatch(/Robin, Sammy/);
  });

  it('with no start-time listing, a label is resolved by listing the clients at call time', async () => {
    const { lines, transport } = await brief('therapyportal_list_appointments', { client: 'Sammy' }, null);
    expect(lines).toEqual(['Therapy Session with Dr Example (Office) for Sammy — 2026-11-05T10:00:00 — reschedule requested']);
    expect(transport.calls.map((c) => c.path)).toContain('document/getpatientsforportaluser');
    const none = new FakeTransport((call) =>
      call.path === 'document/getpatientsforportaluser' ? okJson([]) : responder(call),
    );
    const h = await harness(null, none);
    const res = (await h.callTool('therapyportal_list_appointments', { client: 'Sammy' })) as { content: { text: string }[]; isError?: boolean };
    await h.close();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No client named "Sammy"/);
    expect(res.content[0]!.text).toMatch(/Known clients: none/);
    // A raw patientId still passes through when nobody could be listed.
    const h2 = await harness(null, none);
    const byId = (await h2.callTool('therapyportal_list_appointments', { client: '101', view: 'brief' })) as { content: { text: string }[] };
    await h2.close();
    expect(briefLines('therapyportal_list_appointments', byId.content[0]!.text)).toEqual([
      'Appointment (telehealth) for Robin — 2026-11-01T10:00:00 — cancellation requested',
    ]);
  });

  it('a practice title that starts with "-- " or "\\" is escaped with one backslash, so it never reads as a note', async () => {
    const tricky = new FakeTransport((call) =>
      call.path === 'appointments/appointmentinformation'
        ? okJson({ Appointments: [{ StartDate: '2026-11-02T09:00:00', CalendarEntryTypeName: '-- none' }] })
        : okJson({
            PortalDocumentRequests: [
              { PatientId: 101, RequestStatus: 1, PortalDocuments: [{ Title: '\\share\\form', PortalDocumentStatus: 1 }] },
            ],
          }),
    );
    const h = await harness(DIRECTORY, tricky);
    const appts = (await h.callTool('therapyportal_list_appointments', { view: 'brief' })) as { content: { text: string }[] };
    const docs = (await h.callTool('therapyportal_list_documents', { view: 'brief' })) as { content: { text: string }[] };
    await h.close();
    expect(briefLines('therapyportal_list_appointments', appts.content[0]!.text)).toEqual([
      '\\-- none — 2026-11-02T09:00:00 — scheduled',
    ]);
    expect(briefLines('therapyportal_list_documents', docs.content[0]!.text)).toEqual([
      '\\\\share\\form — no date — pending',
    ]);
  });
});

describe('briefLine', () => {
  it('cuts the WHOLE line to 120 chars, title first, even when the date and status alone overflow', () => {
    const long = 'x'.repeat(200);
    const fits = briefLine(long, '2026-11-01', 'pending');
    expect(fits.length).toBeLessThanOrEqual(120);
    expect(fits).toMatch(/^x+… — 2026-11-01 — pending$/);
    const overflow = briefLine(long, 'd'.repeat(80), 's'.repeat(80));
    expect(overflow.length).toBeLessThanOrEqual(120);
    expect(overflow.startsWith('x')).toBe(true);
    const shortTitle = briefLine('Intake', 'd'.repeat(150), 'pending');
    expect(shortTitle.length).toBeLessThanOrEqual(120);
  });

  it('escapes a title starting with "-- " or "\\" and leaves others alone', () => {
    expect(briefLine('-- 3 of 9 shown', 'no date', 'pending')).toBe('\\-- 3 of 9 shown — no date — pending');
    expect(briefLine('\\x', 'no date', 'pending')).toBe('\\\\x — no date — pending');
    expect(briefLine('--dash', 'no date', 'pending')).toBe('--dash — no date — pending');
  });
});

describe('the client directory', () => {
  afterEach(() => vi.useRealTimers());

  it('labels by display name, falls back to the id, and disambiguates a shared name with the id', () => {
    const dir = buildClientDirectory([
      { patientId: 1, name: 'Alex' },
      { patientId: 2, name: 'alex' },
      { patientId: 3 },
      { patientId: Number.NaN, name: 'Broken' },
    ])!;
    expect(dir.labels).toEqual(['Alex (1)', 'alex (2)', 'client 3']);
    expect(dir.resolve('ALEX (2)')).toEqual({ patientId: 2, name: 'alex' });
    expect(dir.resolve(' client 3 ')).toEqual({ patientId: 3 });
    expect(dir.resolve('1')).toEqual({ patientId: 1, name: 'Alex' });
    // A raw id this login was not known to have at start passes through.
    expect(dir.resolve('999')).toEqual({ patientId: 999 });
    expect(dir.resolve('nobody')).toBeUndefined();
  });

  it('is null — so no enum is published — when there is nobody to name', () => {
    expect(buildClientDirectory([])).toBeNull();
    expect(buildClientDirectory([{ patientId: Number.NaN }])).toBeNull();
  });

  it('loads from the portal once, and answers null on a failure', async () => {
    const { client } = newClient();
    expect((await loadClientDirectory(client))!.labels).toEqual(['Robin', 'Sammy']);
    const failing = new TherapyPortalClient({
      transport: new FakeTransport(() => ({ status: 500, body: 'boom' })),
      sleep: async () => {},
      pollIntervalMs: 0,
    });
    expect(await loadClientDirectory(failing)).toBeNull();
    expect(await loadClientDirectory(new TherapyPortalClient({ transport: stubTransport }))).toBeNull();
  });

  it('gives up after the bound rather than hold up tools/list', async () => {
    expect(CLIENT_LIST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    vi.useFakeTimers();
    const hanging = new TherapyPortalClient({
      transport: { ...stubTransport, call: () => new Promise(() => {}) },
    });
    const pending = loadClientDirectory(hanging, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeNull();
  });
});

describe('hint helpers', () => {
  it('healthMeta fixes the domain and carries the extras', () => {
    expect(healthMeta('lookup')).toEqual({ mint: { domain: 'health', intent: 'lookup' } });
    expect(healthMeta('send', { aliases: ['message'] })).toEqual({ mint: { domain: 'health', intent: 'send', aliases: ['message'] } });
  });

  it('withToolMeta adds _meta to what a helper registers, then restores registerTool', () => {
    const seen: unknown[] = [];
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        seen.push([name, config]);
      },
    };
    const original = server.registerTool;
    withToolMeta(server as never, healthMeta('send'), () => {
      (server as { registerTool: (n: string, c: Record<string, unknown>) => void }).registerTool('x', { description: 'd' });
    });
    expect(seen).toEqual([['x', { description: 'd', _meta: { mint: { domain: 'health', intent: 'send' } } }]]);
    expect(server.registerTool).toBe(original);
    expect(() =>
      withToolMeta(server as never, healthMeta('send'), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(server.registerTool).toBe(original);
  });

  it('withToolMeta leaves an inherited registerTool inherited', () => {
    const seen: unknown[] = [];
    class Server {
      registerTool(name: string, config: Record<string, unknown>) {
        seen.push([name, config]);
      }
    }
    const server = new Server();
    withToolMeta(server as never, healthMeta('other'), () => server.registerTool('y', {}));
    expect(seen).toEqual([['y', { _meta: { mint: { domain: 'health', intent: 'other' } } }]]);
    expect(Object.prototype.hasOwnProperty.call(server, 'registerTool')).toBe(false);
  });
});
