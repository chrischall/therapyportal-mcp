import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import { NotSignedInError, TherapyPortalClient } from '../src/client.js';
import { SecretScrubber } from '../src/secrets.js';
import { FakeTransport, okJson, type FakeCall } from './_tools.js';

function client(responder: (c: FakeCall) => { status: number; body: string }, extra: Partial<ConstructorParameters<typeof TherapyPortalClient>[0]> = {}) {
  const transport = new FakeTransport(responder, (path) => ({ kind: 'bytes', bytes: new Uint8Array([1]), fileName: path }));
  return { transport, c: new TherapyPortalClient({ transport, sleep: async () => {}, pollIntervalMs: 0, ...extra }) };
}

describe('TherapyPortalClient response judging', () => {
  it('parses JSON and treats an empty body as null', async () => {
    expect(await client(() => okJson([1])).c.balances()).toEqual([1]);
    expect(await client(() => ({ status: 200, body: ' ' })).c.balances()).toBeNull();
    expect(await client(() => ({ status: 200, body: 'null' })).c.threads(1, 5)).toBeNull();
  });

  it('turns a 401 into NotSignedInError with transport-specific copy', async () => {
    const server = client(() => ({ status: 401, body: '' })).c;
    await expect(server.balances()).rejects.toBeInstanceOf(NotSignedInError);
    await expect(server.balances()).rejects.toMatchObject({ hint: expect.stringContaining('THERAPYPORTAL_EMAIL') });
    const bridge = client(() => ({ status: 401, body: '' }), { mode: 'fetchproxy' }).c;
    await expect(bridge.balances()).rejects.toMatchObject({ hint: expect.stringContaining('Chrome') });
  });

  it('names the HTML page title when the portal answers with a page', async () => {
    const { c } = client(() => ({ status: 404, body: '<html><title>Page Not Found</title></html>' }));
    await expect(c.receipts()).rejects.toThrow(/getreceiptsforportaluser failed \(HTTP 404: "Page Not Found"\)/);
    const untitled = client(() => ({ status: 200, body: '<html></html>' })).c;
    await expect(untitled.receipts()).rejects.toThrow(/failed \(HTTP 200\)/);
  });

  it('rejects unparsable JSON', async () => {
    await expect(client(() => ({ status: 200, body: '{nope' })).c.balances()).rejects.toThrow(/not JSON/);
  });

  it('scrubs registered secrets from errors', async () => {
    const scrubber = new SecretScrubber();
    scrubber.add('sekrit-token');
    const { c } = client(() => ({ status: 500, body: '<title>boom sekrit-token</title>' }), { scrubber });
    await expect(c.balances()).rejects.toThrow(/boom \[REDACTED\]/);
  });
});

describe('TherapyPortalClient requests', () => {
  it('sends each read’s endpoint and fields', async () => {
    const { transport, c } = client(() => okJson([]));
    await c.listClients();
    await c.appointments();
    await c.documentRequests('pending');
    await c.documentRequests('completed');
    await c.documentRequests('all');
    await c.alwaysAvailableDocuments();
    await c.documentCounts();
    await c.balances();
    await c.receipts();
    await c.threads(42, 10);
    await c.messages(7);
    const by = (p: string) => transport.calls.filter((x) => x.path === p).map((x) => x.fields);
    expect(transport.calls.map((x) => x.path)).toContain('document/getpatientsforportaluser');
    expect(JSON.parse(by('appointments/appointmentinformation')[0]!.json!)).toMatchObject({ searchAllAppointmentsForTheDay: false });
    expect(by('documents/api/getportaluserdocumentrequestsbystatus').map((f) => f.Request)).toEqual(['[1,4]', '[5]', '[1,4,5]']);
    expect(by('messages/getthreads')[0]).toMatchObject({ patientid: '42', recordstoretrieve: '10', readstatus: '2', audiences: '0,1,2' });
    expect(by('messages/getmessages')[0]).toEqual({ threadid: '7' });
  });
});

describe('downloads', () => {
  it('links a practice-uploaded file (type 0) directly', async () => {
    const { transport, c } = client(() => okJson({}));
    await c.downloadDocument(55, 9, 0);
    expect(transport.downloads).toEqual(['documents/files/download/55/']);
    expect(transport.calls).toHaveLength(0);
  });

  it('runs a form download job to completion', async () => {
    let polls = 0;
    const { transport, c } = client((call) => {
      if (call.path === 'document/createportalformdownloadrequest') return okJson({ JobId: 31 });
      polls++;
      return okJson(polls < 3 ? { ProgressPercentage: 40, EncryptedJobID: 'E/1' } : { ProgressPercentage: 100, EncryptedJobID: 'E/1' });
    });
    const f = await c.downloadDocument(55, 9, 3);
    expect(f.kind).toBe('bytes');
    expect(JSON.parse(transport.calls[0]!.fields.request!)).toEqual({ PortalFormId: 55, PatientId: 9, PatientDocumentType: 3 });
    expect(JSON.parse(transport.calls[1]!.fields.request!)).toEqual({ Id: 31 });
    expect(transport.downloads).toEqual(['document/download/E%2F1/']);
  });

  it('runs a receipt job', async () => {
    const { transport, c } = client((call) =>
      call.path.includes('create') ? okJson({ JobId: 2 }) : okJson({ ProgressPercentage: 100, EncryptedJobID: 'R' }),
    );
    await c.downloadReceipt(88);
    expect(transport.calls[0]).toEqual({ path: 'billing/payments/createreceiptdownloadrequest', fields: { PaymentId: '88' } });
    expect(transport.downloads).toEqual(['document/download/R/']);
  });

  it('fails when no job starts, or it never finishes', async () => {
    await expect(client(() => okJson({})).c.downloadReceipt(1)).rejects.toThrow(/did not start the download/);
    await expect(client(() => okJson(null)).c.downloadReceipt(1)).rejects.toThrow(/did not start/);
    const stuck = client((call) => (call.path.includes('create') ? okJson({ JobId: 2 }) : okJson({ ProgressPercentage: 100, EncryptedJobID: '' })), { maxPolls: 3 });
    await expect(stuck.c.downloadReceipt(1)).rejects.toBeInstanceOf(McpToolError);
    expect(stuck.transport.calls).toHaveLength(4);
    const nullStatus = client((call) => (call.path.includes('create') ? okJson({ JobId: 2 }) : okJson(null)), { maxPolls: 1 });
    await expect(nullStatus.c.downloadReceipt(1)).rejects.toThrow(/in time/);
  });

  it('defaults to server mode', async () => {
    const { c } = client(() => okJson([]));
    expect(c.mode).toBe('server');
  });
});
