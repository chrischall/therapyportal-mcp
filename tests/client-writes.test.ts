import { describe, expect, it } from 'vitest';
import { McpToolError, WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { NotSignedInError, SEGMENT_RETRIES, SEGMENT_SIZE, TherapyPortalClient } from '../src/client.js';
import { FakeTransport, okJson, type FakeCall } from './_tools.js';
import type { FetchResult } from '../src/transport.js';

// Synthetic answers only — no real ids, names or values.

function client(responder: (c: FakeCall) => FetchResult) {
  const transport = new FakeTransport(responder);
  return { transport, c: new TherapyPortalClient({ transport }) };
}

const HINT = 'refused-hint';

describe('submit (the write path)', () => {
  it('posts via send (never the retrying read path) and parses JSON', async () => {
    const { c, transport } = client(() => okJson({ Id: 9 }));
    expect(await c.submit('messages/createnewthread', { ThreadRequest: '{}' }, HINT)).toEqual({ Id: 9 });
    expect(transport.calls).toEqual([{ path: 'messages/createnewthread', fields: { ThreadRequest: '{}' }, via: 'send' }]);
  });

  it('treats an empty 200 as null', async () => {
    expect(await client(() => ({ status: 200, body: '' })).c.submit('x', {}, HINT)).toBeNull();
  });

  it('a thrown transport failure is an unknown outcome; a tool error passes through', async () => {
    const dropped = new TherapyPortalClient({
      transport: Object.assign(new FakeTransport(() => okJson(1)), {
        send: async () => {
          throw new Error('socket hang up');
        },
      }),
    });
    await expect(dropped.submit('x', {}, HINT)).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
    const tool = new TherapyPortalClient({
      transport: Object.assign(new FakeTransport(() => okJson(1)), {
        send: async () => {
          throw new McpToolError('bridge down', { hint: 'h' });
        },
      }),
    });
    await expect(tool.submit('x', {}, HINT)).rejects.toThrow('bridge down');
  });

  it('signed out → NotSignedInError (nothing sent)', async () => {
    await expect(client(() => ({ status: 401, body: '' })).c.submit('x', {}, HINT)).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('5xx → unknown outcome, not a retry-safe error', async () => {
    const err = await client(() => ({ status: 502, body: 'bad gateway' })).c.submit('x', {}, HINT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect((err as McpToolError).hint).toMatch(/do not resend blindly/);
  });

  it('4xx, an HTML page or non-JSON → refused with the caller’s hint', async () => {
    await expect(client(() => ({ status: 403, body: '' })).c.submit('x', {}, HINT)).rejects.toMatchObject({ hint: HINT });
    await expect(client(() => ({ status: 200, body: '<html></html>' })).c.submit('x', {}, HINT)).rejects.toThrow(/refused x \(HTTP 200\)/);
    await expect(client(() => ({ status: 200, body: '{nope' })).c.submit('x', {}, HINT)).rejects.toThrow(/not JSON/);
  });
});

describe('judgeFormAdvice', () => {
  const { c } = client(() => okJson(null));
  it('returns non-error advice and accepts an answer with no FormAdvice key', () => {
    expect(c.judgeFormAdvice({ FormAdvice: [{ Type: 0, Message: 'ok' }, null] }, 'upload', HINT)).toEqual([{ Type: 0, Message: 'ok' }]);
    expect(c.judgeFormAdvice({}, 'upload', HINT)).toEqual([]);
  });
  it('any Type 3 is a rejection quoting its messages', () => {
    expect(() => c.judgeFormAdvice({ FormAdvice: [{ Type: 3, Message: ' Too big. ' }, { Type: 3, Message: 'Bad type.' }] }, 'upload', HINT)).toThrow(
      'TherapyPortal rejected the upload: Too big. Bad type.',
    );
    expect(() => c.judgeFormAdvice({ FormAdvice: [{ Type: 3 }] }, 'upload', HINT)).toThrow('TherapyPortal rejected the upload.');
  });
  it('a non-object answer, or a FormAdvice that is not a list, is unexpected', () => {
    expect(() => c.judgeFormAdvice(null, 'upload', HINT)).toThrow(/as expected/);
    expect(() => c.judgeFormAdvice(true, 'upload', HINT)).toThrow(/as expected/);
    expect(() => c.judgeFormAdvice({ FormAdvice: 'x' }, 'upload', HINT)).toThrow(/as expected/);
  });
});

describe('stageUpload', () => {
  const file = (n: number) => ({ bytes: new Uint8Array(n).fill(65), name: 'scan "1".pdf', mime: 'application/pdf' });

  it('splits into 102400-byte segments, in order, with the X-Upload headers', async () => {
    const { c, transport } = client(() => ({ status: 200, body: '' }));
    await c.stageUpload(file(SEGMENT_SIZE * 2 + 5), 'guid-1');
    const segs = transport.calls;
    expect(segs.map((s) => s.via)).toEqual(['segment', 'segment', 'segment']);
    expect(segs.map((s) => s.headers!['X-Upload-Segment'])).toEqual(['0', '1', '2']);
    expect(segs.map((s) => s.headers!['X-Upload-Segment-Is-Final'])).toEqual(['false', 'false', 'true']);
    expect(segs[0]!.headers).toEqual({
      'X-Upload-Guid': 'guid-1',
      'X-Upload-Segment': '0',
      'X-Upload-Segment-Size': '102400',
      'X-Upload-Segment-Is-Final': 'false',
      'X-Upload-File-Name': encodeURIComponent('scan "1".pdf'),
      'X-Upload-File-Size': String(SEGMENT_SIZE * 2 + 5),
      'X-Upload-File-Mime-Type': 'application/pdf',
    });
    expect(Buffer.from(segs[0]!.body!, 'base64').length).toBe(SEGMENT_SIZE);
    expect(Buffer.from(segs[2]!.body!, 'base64').length).toBe(5);
  });

  it('a small file is one final segment', async () => {
    const { c, transport } = client(() => ({ status: 200, body: '' }));
    await c.stageUpload(file(3), 'g');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.headers!['X-Upload-Segment-Is-Final']).toBe('true');
  });

  it('retries a non-200 segment up to 3 times, then gives up', async () => {
    let n = 0;
    const flaky = client(() => (++n < 3 ? { status: 503, body: '' } : { status: 200, body: '' }));
    await flaky.c.stageUpload(file(3), 'g');
    expect(flaky.transport.calls).toHaveLength(3);
    const dead = client(() => ({ status: 500, body: '' }));
    await expect(dead.c.stageUpload(file(3), 'g')).rejects.toThrow(/refused segment 1 of 1 .*HTTP 500/);
    expect(dead.transport.calls).toHaveLength(1 + SEGMENT_RETRIES);
  });

  it('never retries an Error body, and quotes it', async () => {
    const { c, transport } = client(() => ({ status: 200, body: '{"Error":"File type not allowed"}' }));
    await expect(c.stageUpload(file(3), 'g')).rejects.toThrow('TherapyPortal refused the file: File type not allowed');
    expect(transport.calls).toHaveLength(1);
    await expect(client(() => ({ status: 200, body: 'Error!' })).c.stageUpload(file(3), 'g')).rejects.toThrow(
      'TherapyPortal refused the file.',
    );
    await expect(client(() => ({ status: 200, body: '{"Error":5}' })).c.stageUpload(file(3), 'g')).rejects.toThrow(
      'TherapyPortal refused the file.',
    );
  });

  it('signed out stops at once; a dropped connection reports that nothing was submitted', async () => {
    await expect(client(() => ({ status: 401, body: '' })).c.stageUpload(file(3), 'g')).rejects.toBeInstanceOf(NotSignedInError);
    const broke = new TherapyPortalClient({
      transport: Object.assign(new FakeTransport(() => okJson(1)), {
        uploadSegment: async () => {
          throw new Error('reset');
        },
      }),
    });
    await expect(broke.stageUpload(file(3), 'g')).rejects.toMatchObject({ hint: expect.stringMatching(/Nothing was submitted/) });
    const tool = new TherapyPortalClient({
      transport: Object.assign(new FakeTransport(() => okJson(1)), {
        uploadSegment: async () => {
          throw new McpToolError('bridge down', { hint: 'h' });
        },
      }),
    });
    await expect(tool.stageUpload(file(3), 'g')).rejects.toThrow('bridge down');
  });
});

describe('write lookups and validation', () => {
  it('reads settings, topics and the assigned-clinician flag with the portal’s fields', async () => {
    const { c, transport } = client((call) =>
      call.path === 'messages/checkifpatienthasassignedclinician' ? { status: 200, body: 'true' } : okJson([]),
    );
    await c.messageSettings();
    await c.messageTopics(101);
    expect(await c.hasAssignedClinician(101)).toBe(true);
    expect(transport.calls).toEqual([
      { path: 'messages/getsettings', fields: { forceFromService: 'false' } },
      { path: 'messages/gettopicsforaudiences', fields: { audiences: '0,1,2', patientId: '101', ignoreUserPermissions: '' } },
      { path: 'messages/checkifpatienthasassignedclinician', fields: { patientid: '101' } },
    ]);
    expect(await client(() => ({ status: 200, body: 'false' })).c.hasAssignedClinician(1)).toBe(false);
  });

  it('validateStagedUpload sends the request JSON and judges FormAdvice', async () => {
    const ok = client(() => okJson({ FormAdvice: [] }));
    expect(await ok.c.validateStagedUpload({ FileUploadGuid: 'g' })).toEqual([]);
    expect(ok.transport.calls[0]).toEqual({ path: 'document/stageduploadvalidation', fields: { request: '{"FileUploadGuid":"g"}' } });
    await expect(client(() => okJson({ FormAdvice: [{ Type: 3, Message: 'No.' }] })).c.validateStagedUpload({})).rejects.toThrow(
      'rejected the uploaded file: No.',
    );
  });
});
