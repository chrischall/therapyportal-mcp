import { describe, expect, it } from 'vitest';
import { InlineDownloadIO } from '../src/download-io.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerClientTools } from '../src/tools/clients.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerDownloadTools, renderDownload } from '../src/tools/downloads.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { asRecord, asRecordArray, firstText } from '../src/tools/_shared.js';
import { capture, jsonOf, okJson, stubDownloadIO, textOf, type FakeCall } from './_tools.js';

const CLIENTS = [
  {
    Id: 101, FirstName: 'Robin', MiddleName: '', LastName: 'Example', Nickname: '', PreferredPronouns: 'they/them',
    DateOfBirth: '2012-03-04T00:00:00', Ssn: '000-00-0000', Address: { Address1: '1 Fake St' }, Email: 'robin@example.com',
    Comments: 'free text',
  },
  { PatientId: 102, FirstName: 'Sam', LastName: 'Example', Nickname: 'Sammy', DateOfBirth: null },
];

const APPTS = {
  PracticeName: 'Example Practice',
  PracticePhone: '5550100',
  Appointments: [
    { ApptId: 2, StartDate: '2026-11-05T10:00:00', EndDate: '2026-11-05T10:50:00', TimeZoneAbbreviation: 'EST', CalendarEntryTypeName: 'Therapy Session', ClinicianDisplayName: 'Dr Example', IsTelehealth: false, LocationName: 'Office', Patients: [{ FirstName: 'Sam', Nickname: 'Sammy' }], PendingCancel: false, PendingReschedule: true },
    { ApptId: 1, StartDate: '2026-11-01T10:00:00', IsTelehealth: true, Patients: [{ FirstName: 'Robin', Nickname: '' }], PendingCancel: false, PendingReschedule: false },
  ],
  AppointmentRequests: [],
};

const DOC_REQS = {
  PortalDocumentRequests: [
    {
      RequestId: 9, RequestStatus: 5, PatientId: 101, PatientFirstName: 'Robin', PatientNickName: '', RequestDateCreated: '2026-09-01T00:00:00', VersionInstructions: 'Please review',
      PortalDocuments: [
        { PortalDocumentId: 501, Title: 'Intake', PatientDocumentType: 3, PortalDocumentStatus: 3, PortalDocumentDateCompleted: '2026-09-02', PatientId: 101 },
        { PortalDocumentId: 502, Title: 'Plan.pdf', PatientDocumentType: 0, PortalDocumentStatus: 3, PatientId: 101 },
        { PortalDocumentId: 503, Title: 'Odd', PatientDocumentType: 7, PortalDocumentStatus: 9, PatientId: 101 },
      ],
    },
    { RequestId: 10, RequestStatus: 2, PatientId: 102, PatientFirstName: 'Sam', PortalDocuments: null },
  ],
};

function route(map: Record<string, unknown>) {
  return (call: FakeCall) => {
    if (!(call.path in map)) throw new Error(`unexpected ${call.path}`);
    return okJson(map[call.path]);
  };
}

describe('therapyportal_list_clients', () => {
  const { handlers } = capture(registerClientTools, route({ 'document/getpatientsforportaluser': CLIENTS }));
  const fn = handlers.get('therapyportal_list_clients')!;

  it('compact: id, display name and last name only', async () => {
    expect(jsonOf(await fn({}))).toEqual([
      { patientId: 101, name: 'Robin', lastName: 'Example' },
      { patientId: 102, name: 'Sammy', lastName: 'Example' },
    ]);
  });

  it('full is still an allowlist — no contact details or identifiers', async () => {
    const text = textOf(await fn({ view: 'full' }));
    expect(JSON.parse(text)[0]).toEqual({
      patientId: 101, firstName: 'Robin', lastName: 'Example', pronouns: 'they/them', dateOfBirth: '2012-03-04',
    });
    for (const leak of ['000-00-0000', 'Fake St', 'robin@example.com', 'free text']) expect(text).not.toContain(leak);
  });
});

describe('therapyportal_list_appointments', () => {
  it('sorts soonest first, honours limit, and names clients', async () => {
    const { handlers } = capture(registerAppointmentTools, route({ 'appointments/appointmentinformation': APPTS }));
    const out = jsonOf(await handlers.get('therapyportal_list_appointments')!({ limit: 1 })) as Record<string, unknown>;
    expect(out).toMatchObject({ practice: 'Example Practice', practicePhone: '5550100', total: 2 });
    expect(out.appointments).toEqual([{ apptId: 1, start: '2026-11-01T10:00:00', telehealth: true, clients: ['Robin'] }]);
    expect(out.requests).toBeUndefined();
    const all = jsonOf(await handlers.get('therapyportal_list_appointments')!({})) as { appointments: unknown[] };
    expect(all.appointments[1]).toMatchObject({ clients: ['Sammy'], pendingReschedule: true, clinician: 'Dr Example' });
  });

  it('keeps pending requests, and falls back to raw on an unexpected shape', async () => {
    const withReq = capture(registerAppointmentTools, route({ 'appointments/appointmentinformation': { ...APPTS, AppointmentRequests: [{ Id: 1 }] } }));
    expect(jsonOf(await withReq.handlers.get('therapyportal_list_appointments')!({}))).toMatchObject({ requests: [{ Id: 1 }] });
    const odd = capture(registerAppointmentTools, route({ 'appointments/appointmentinformation': { Something: 1 } }));
    expect(jsonOf(await odd.handlers.get('therapyportal_list_appointments')!({}))).toEqual({ Something: 1 });
  });
});

describe('document tools', () => {
  const { handlers, transport } = capture(
    registerDocumentTools,
    route({
      'documents/api/getportaluserdocumentrequestsbystatus': DOC_REQS,
      'documents/api/getalwaysavailabledocumentsforportaluser': [
        { Title: 'Disclosure', DocumentDescription: 'Read me', PatientId: 101, PatientSignatureRequired: true, IsUploadRequired: false, OriginalFileName: 'd.pdf', EncryptedId: 'secret-ish' },
      ],
      getportaldocumentstatisticsforportaluser: [
        { PatientId: 101, ClinicalPortalDocumentsPendingCompletion: 1, AdministrativePortalDocumentsPendingCompletion: 0, BillingPortalDocumentsPendingCompletion: 0, ClinicalPortalDocumentsPendingApproval: 0, AdministrativePortalDocumentsPendingApproval: 2, BillingPortalDocumentsPendingApproval: 0 },
      ],
    }),
  );

  it('lists requests inside the untrusted envelope, with readable kinds and statuses', async () => {
    const out = jsonOf(await handlers.get('therapyportal_list_documents')!({ status: 'completed' })) as Record<string, unknown>;
    expect(out.untrusted_content).toBe(true);
    const [first, second] = out.data as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ requestId: 9, status: 'completed', client: 'Robin', instructions: 'Please review' });
    expect(first!.documents).toEqual([
      { portalDocumentId: 501, title: 'Intake', kind: 'portal_form', status: 'completed', completed: '2026-09-02' },
      { portalDocumentId: 502, title: 'Plan.pdf', kind: 'practice_file', status: 'completed' },
      { portalDocumentId: 503, title: 'Odd', kind: 7, status: 9 },
    ]);
    expect(second).toMatchObject({ requestId: 10, status: 2, client: 'Sam', documents: [] });
    expect(transport.calls.at(-1)!.fields.Request).toBe('[5]');
  });

  it('raw passes the portal payload through, still fenced', async () => {
    // An object payload is spread beside the markers (arrays nest under `data`).
    const out = jsonOf(await handlers.get('therapyportal_list_documents')!({ status: 'all', view: 'raw' })) as Record<string, unknown>;
    expect(out).toMatchObject({ untrusted_content: true, ...DOC_REQS });
  });

  it('lists always-available forms without encrypted ids', async () => {
    const text = textOf(await handlers.get('therapyportal_list_forms')!({}));
    expect((JSON.parse(text) as { data: unknown }).data).toEqual([
      { title: 'Disclosure', description: 'Read me', patientId: 101, signatureRequired: true, uploadRequired: false, fileName: 'd.pdf' },
    ]);
    expect(text).not.toContain('secret-ish');
  });

  it('counts documents by category', async () => {
    expect(jsonOf(await handlers.get('therapyportal_get_document_counts')!({}))).toEqual([
      { patientId: 101, toComplete: { clinical: 1, administrative: 0, billing: 0 }, awaitingApproval: { clinical: 0, administrative: 2, billing: 0 } },
    ]);
  });

  it('falls back to raw when a payload is not the expected shape', async () => {
    const odd = capture(registerDocumentTools, () => okJson({ odd: true }));
    for (const name of ['therapyportal_list_documents', 'therapyportal_list_forms']) {
      expect(jsonOf(await odd.handlers.get(name)!({}))).toMatchObject({ untrusted_content: true, odd: true });
    }
    expect(jsonOf(await odd.handlers.get('therapyportal_get_document_counts')!({}))).toEqual({ odd: true });
  });
});

describe('billing tools', () => {
  const { handlers } = capture(
    registerBillingTools,
    route({
      'billing/payments/getbalancesdueforportaluser': [{ PatientId: 101, PreferredName: '', FirstName: 'Robin', AmountToPatient: 0, AutoPayEnabled: false, Dob: '2012' }],
      'billing/payments/getreceiptsforportaluser': [
        { PaymentId: 77, PatientId: 101, PatientPreferredName: 'Robin', PaymentDate: '2026-09-28', PaymentAmount: 120, TotalAmountAllocated: 120, CreditCardNumberLast4: '4242', AuthorizationNumber: 'AUTH1', TransactionData: [{ DateOfService: '2026-09-01', AmountPaid: '60', TransactionDescription: 'Session' }] },
      ],
    }),
  );

  it('lists balances, keeping a zero balance', async () => {
    expect(jsonOf(await handlers.get('therapyportal_list_balances')!({}))).toEqual([
      { patientId: 101, client: 'Robin', balanceDue: 0, autoPay: false },
    ]);
  });

  it('lists receipts with their services, without the authorization number', async () => {
    const text = textOf(await handlers.get('therapyportal_list_receipts')!({}));
    expect(JSON.parse(text)).toEqual([
      { paymentId: 77, patientId: 101, client: 'Robin', date: '2026-09-28', amount: 120, allocated: 120, cardLast4: '4242', services: [{ dateOfService: '2026-09-01', paid: '60', description: 'Session' }] },
    ]);
    expect(text).not.toContain('AUTH1');
  });

  it('falls back to raw on an unexpected shape', async () => {
    const odd = capture(registerBillingTools, () => okJson({ odd: 1 }));
    expect(jsonOf(await odd.handlers.get('therapyportal_list_balances')!({}))).toEqual({ odd: 1 });
    expect(jsonOf(await odd.handlers.get('therapyportal_list_receipts')!({}))).toEqual({ odd: 1 });
  });
});

describe('message tools', () => {
  it('fence the portal payload and turn null into an empty list', async () => {
    const empty = capture(registerMessageTools, () => ({ status: 200, body: 'null' }));
    expect(jsonOf(await empty.handlers.get('therapyportal_list_message_threads')!({ patient_id: 101, limit: 5 }))).toMatchObject({
      untrusted_content: true,
      threads: [],
    });
    expect(empty.transport.calls[0]!.fields).toMatchObject({ patientid: '101', recordstoretrieve: '5' });
    expect(jsonOf(await empty.handlers.get('therapyportal_get_thread_messages')!({ thread_id: 3 }))).toMatchObject({ untrusted_content: true, messages: [] });

    const full = capture(registerMessageTools, () => okJson({ Threads: [{ Subject: 'Hi' }] }));
    expect(jsonOf(await full.handlers.get('therapyportal_list_message_threads')!({ patient_id: 1 }))).toMatchObject({ Threads: [{ Subject: 'Hi' }] });
    expect(jsonOf(await full.handlers.get('therapyportal_get_thread_messages')!({ thread_id: 3 }))).toMatchObject({ Threads: [{ Subject: 'Hi' }] });
  });
});

describe('download tools', () => {
  const pdf = () => ({ kind: 'bytes' as const, bytes: new Uint8Array([37, 80, 68, 70]), contentType: 'application/pdf', fileName: 'Intake.pdf' });

  it('looks up the document’s client and kind, then delivers to disk', async () => {
    const { handlers, transport } = capture(
      (s, c) => registerDownloadTools(s, c, stubDownloadIO),
      (call) =>
        call.path === 'documents/api/getportaluserdocumentrequestsbystatus'
          ? okJson(DOC_REQS)
          : call.path.includes('create')
            ? okJson({ JobId: 1 })
            : okJson({ ProgressPercentage: 100, EncryptedJobID: 'E' }),
      pdf,
    );
    expect(jsonOf(await handlers.get('therapyportal_download_document')!({ portal_document_id: 501 }))).toEqual({
      saved_to: '/out/Intake.pdf', file_name: 'Intake.pdf', mime_type: 'application/pdf', size_bytes: 4,
    });
    expect(JSON.parse(transport.calls[1]!.fields.request!)).toEqual({ PortalFormId: 501, PatientId: 101, PatientDocumentType: 3 });
    await handlers.get('therapyportal_download_document')!({ portal_document_id: 502 });
    expect(transport.downloads.at(-1)).toBe('documents/files/download/502/');
  });

  it('refuses an id that is not on the account', async () => {
    const { handlers } = capture((s, c) => registerDownloadTools(s, c, stubDownloadIO), () => okJson(null));
    await expect(handlers.get('therapyportal_download_document')!({ portal_document_id: 9 })).rejects.toThrow(/No TherapyPortal document 9/);
  });

  it('downloads a receipt', async () => {
    const { handlers } = capture(
      (s, c) => registerDownloadTools(s, c, stubDownloadIO),
      (call) => (call.path.includes('create') ? okJson({ JobId: 1 }) : okJson({ ProgressPercentage: 100, EncryptedJobID: 'E' })),
      () => ({ kind: 'bytes', bytes: new Uint8Array([1]) }),
    );
    expect(jsonOf(await handlers.get('therapyportal_download_receipt')!({ payment_id: 77 }))).toMatchObject({ file_name: 'receipt-77.pdf' });
  });

  it('renders a browser-saved file, inline bytes, and a too-large file', () => {
    expect(jsonOf(renderDownload({ kind: 'saved', path: '/d/x.pdf', size: 3, mimeType: 'application/pdf' }, stubDownloadIO, undefined, 'x'))).toMatchObject({
      saved_to: '/d/x.pdf', size_bytes: 3, note: expect.stringContaining('browser'),
    });
    expect(jsonOf(renderDownload(pdf(), new InlineDownloadIO(), undefined, 'x'))).toMatchObject({ base64: 'JVBERg==' });
    expect(jsonOf(renderDownload(pdf(), new InlineDownloadIO(1), undefined, 'x'))).toMatchObject({ note: expect.stringContaining('too large') });
  });
});

describe('firstText', () => {
  it('skips blanks and non-strings', () => {
    expect(firstText('', '  ', 3, ' a ')).toBe('a');
    expect(firstText(undefined, null)).toBeUndefined();
  });
});

describe('asRecord / asRecordArray', () => {
  it('coerce only plain objects', () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1])).toEqual({});
    expect(asRecord('x')).toEqual({});
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecordArray('x')).toEqual([]);
    expect(asRecordArray([{ a: 1 }, null, [2], 'x'])).toEqual([{ a: 1 }]);
  });
});
