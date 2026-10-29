// TherapyPortal (TherapyNotes client portal) client.
//
// Every read is one form POST through the transport, which injects the page
// tokens. Responses are JSON, or the literal `null` for an empty list (messages
// with no threads). A call without a live session is answered 401; a call the
// portal cannot route — an unknown endpoint, or a missing `portalpractice` — is
// answered with an HTML "Page Not Found" page. Both are judged here by content,
// never trusted as data.
//
// Downloads are jobs: create one, poll its status to 100 %, then fetch the file
// under /p/<code>/document/download/<EncryptedJobID>/. A file the PRACTICE
// uploaded (PatientDocumentType 0) skips the job and is linked directly.
//
// Writes (confirm-gated at the tool layer) go through `submit`, which posts
// ONCE via the transport's no-replay `send` and judges the answer: a 5xx or a
// dropped connection is an UNKNOWN outcome (it may have gone through), never an
// error that reads as "safe to retry". File bytes are staged first through the
// segment receiver (`stageUpload`). All write shapes are derived from the
// portal's JS and UNVERIFIED on the wire — see docs/THERAPYPORTAL-API.md.

import { McpToolError, WriteOutcomeUnknownError, throwIfCancelled } from '@chrischall/mcp-utils';
import { SecretScrubber } from './secrets.js';
import { isSignedOut, type DownloadedFile, type FetchResult, type TherapyPortalTransport } from './transport.js';

/** Bytes per segment the portal's uploader sends (`xhrfileuploader.js`). */
export const SEGMENT_SIZE = 102_400;
/** Extra attempts for a segment answered non-200, as the portal's uploader does. */
export const SEGMENT_RETRIES = 3;

/** FormAdviceType 3: the portal rejected the request. */
const FORM_ADVICE_ERROR = 3;

/** One FormAdvice entry a document write answers with. */
export interface FormAdvice {
  Id?: unknown;
  Type?: unknown;
  Message?: unknown;
}

/** A file staged for upload: its bytes, the name and MIME it is sent as. */
export interface StagedFile {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

/** Which transport is carrying requests, for sign-in remediation copy. */
export type TransportMode = 'server' | 'fetchproxy';

/** Document-request statuses (the portal's PortalDocRequestStatus enum). */
export const REQUEST_STATUS = { pending: 1, in_progress: 4, completed: 5 } as const;
export type DocumentFilter = 'pending' | 'completed' | 'all';
const FILTER_STATUSES: Record<DocumentFilter, number[]> = {
  pending: [REQUEST_STATUS.pending, REQUEST_STATUS.in_progress],
  completed: [REQUEST_STATUS.completed],
  all: [REQUEST_STATUS.pending, REQUEST_STATUS.in_progress, REQUEST_STATUS.completed],
};

/** PatientDocumentType of a file the practice uploaded for the client (linked directly). */
export const PRACTICE_FILE_TYPE = 0;

/** Not signed in to the portal. `kind: 'session_expired'` drives the healthcheck. */
export class NotSignedInError extends McpToolError {
  constructor(mode: TransportMode) {
    const hint =
      mode === 'fetchproxy'
        ? 'Open your practice’s TherapyPortal page (www.therapyportal.com/p/<code>/) in Chrome and ' +
          'sign in — the bridge sends requests from inside that tab — then retry.'
        : 'Set THERAPYPORTAL_EMAIL and THERAPYPORTAL_PASSWORD so the server can sign in, then retry.';
    super('Not signed in to TherapyPortal — the portal refused the request (HTTP 401).', {
      hint,
      kind: 'session_expired',
      status: 401,
    });
    this.name = 'NotSignedInError';
  }
}

export interface TherapyPortalClientOptions {
  transport: TherapyPortalTransport;
  scrubber?: SecretScrubber;
  mode?: TransportMode;
  /** Injectable for tests: wait between download-status polls. */
  sleep?: (ms: number) => Promise<void>;
  /** How often and how many times to poll a download job. */
  pollIntervalMs?: number;
  maxPolls?: number;
}

const API_HINT = 'The portal may have changed; see docs/THERAPYPORTAL-API.md.';

/** The usual "right now" the portal's own appointment call sends. */
function nowUtc(): string {
  return new Date().toISOString();
}

export class TherapyPortalClient {
  private readonly transport: TherapyPortalTransport;
  private readonly scrubber: SecretScrubber;
  readonly mode: TransportMode;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(opts: TherapyPortalClientOptions) {
    this.transport = opts.transport;
    this.scrubber = opts.scrubber ?? new SecretScrubber();
    this.mode = opts.mode ?? 'server';
    /* v8 ignore next */
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.maxPolls = opts.maxPolls ?? 60;
  }

  private fail(message: string, hint: string): McpToolError {
    return new McpToolError(this.scrubber.scrub(message), { hint: this.scrubber.scrub(hint) });
  }

  /** Parse one data call's JSON, turning a sign-in refusal or an HTML page into an error. */
  private parse(res: FetchResult, endpoint: string): unknown {
    if (isSignedOut(res)) throw new NotSignedInError(this.mode);
    const body = res.body.trim();
    if (res.status !== 200 || body.startsWith('<')) {
      const title = /<title>([^<]*)<\/title>/i.exec(res.body)?.[1]?.trim();
      throw this.fail(
        `TherapyPortal ${endpoint} failed (HTTP ${res.status}${title ? `: "${title}"` : ''}).`,
        API_HINT,
      );
    }
    if (body === '') return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw this.fail(`TherapyPortal ${endpoint} returned a response that is not JSON.`, API_HINT);
    }
  }

  private async read(path: string, fields: Record<string, string> = {}): Promise<unknown> {
    return this.parse(await this.transport.call(path, fields), path);
  }

  // --- writes -----------------------------------------------------------------

  /**
   * POST one write data call exactly once and parse its JSON answer.
   *
   *   - a thrown transport failure (timeout, dropped connection) happened after
   *     the request may have reached the portal → {@link WriteOutcomeUnknownError};
   *   - signed out (401 / Log In page) → the portal refused it before acting →
   *     {@link NotSignedInError} (nothing sent);
   *   - 5xx → no proof either way → {@link WriteOutcomeUnknownError};
   *   - any other non-200, or an HTML page → refused (`refusedHint`);
   *   - 200 JSON → returned (an empty body is `null`).
   */
  async submit(path: string, fields: Record<string, string>, refusedHint: string): Promise<unknown> {
    let res: FetchResult;
    try {
      res = await this.transport.send(path, fields);
    } catch (err) {
      if (err instanceof McpToolError) throw err;
      throw new WriteOutcomeUnknownError('TherapyPortal', 'POST', { cause: err });
    }
    if (isSignedOut(res)) throw new NotSignedInError(this.mode);
    if (res.status >= 500) {
      throw new WriteOutcomeUnknownError('TherapyPortal', 'POST', {
        hint:
          `TherapyPortal answered ${path} with HTTP ${res.status}, so it may or may not have ` +
          'gone through. Re-read the matching list before retrying; do not resend blindly.',
      });
    }
    const body = res.body.trim();
    if (res.status !== 200 || body.startsWith('<')) {
      throw this.fail(`TherapyPortal refused ${path} (HTTP ${res.status}).`, refusedHint);
    }
    if (body === '') return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw this.fail(`TherapyPortal answered ${path} with something that is not JSON.`, refusedHint);
    }
  }

  /**
   * Judge a document call's `{ FormAdvice: [...] }` answer. Any Type 3 (Error)
   * entry is a rejection: its messages are surfaced. Otherwise the non-error
   * advice (information, warnings) is returned for the tool to show.
   */
  judgeFormAdvice(data: unknown, what: string, hint: string): FormAdvice[] {
    const advice = (data as { FormAdvice?: unknown } | null)?.FormAdvice;
    if (data === null || typeof data !== 'object' || (advice !== undefined && !Array.isArray(advice))) {
      throw this.fail(`TherapyPortal did not answer the ${what} as expected.`, hint);
    }
    const list = (Array.isArray(advice) ? advice : []).filter(
      (a): a is FormAdvice => a !== null && typeof a === 'object',
    );
    const errors = list.filter((a) => Number(a.Type) === FORM_ADVICE_ERROR);
    if (errors.length > 0) {
      const said = errors
        .map((a) => (typeof a.Message === 'string' ? a.Message.trim() : ''))
        .filter(Boolean)
        .join(' ');
      throw this.fail(`TherapyPortal rejected the ${what}${said ? `: ${said}` : '.'}`, hint);
    }
    return list;
  }

  /**
   * Stage a file on the portal's segment receiver under `guid`: 102 400-byte
   * segments, sent in order, each base64 text with the `X-Upload-*` headers.
   * A segment answered non-200 is resent up to {@link SEGMENT_RETRIES} times
   * (idempotent by guid + index, as the portal's uploader assumes); an answer
   * whose body contains `Error` is never retried. Staging alone submits
   * nothing to the practice — an aborted upload leaves an orphaned temp file.
   */
  async stageUpload(file: StagedFile, guid: string): Promise<void> {
    const total = file.bytes.length;
    const count = Math.max(1, Math.ceil(total / SEGMENT_SIZE));
    const notSubmitted = 'Nothing was submitted to the practice. Retry the upload.';
    for (let i = 0; i < count; i++) {
      throwIfCancelled();
      const headers = {
        'X-Upload-Guid': guid,
        'X-Upload-Segment': String(i),
        'X-Upload-Segment-Size': String(SEGMENT_SIZE),
        'X-Upload-Segment-Is-Final': String(i === count - 1),
        'X-Upload-File-Name': encodeURIComponent(file.name),
        'X-Upload-File-Size': String(total),
        'X-Upload-File-Mime-Type': file.mime,
      };
      const body = Buffer.from(file.bytes.subarray(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE)).toString('base64');
      let res: FetchResult | undefined;
      for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
        try {
          res = await this.transport.uploadSegment(headers, body);
        } catch (err) {
          if (err instanceof McpToolError) throw err;
          throw this.fail(`The file upload to TherapyPortal broke off at segment ${i + 1} of ${count}.`, notSubmitted);
        }
        if (isSignedOut(res)) throw new NotSignedInError(this.mode);
        if (res.status === 200) break;
      }
      const answered = res as FetchResult;
      if (answered.status !== 200) {
        throw this.fail(
          `TherapyPortal refused segment ${i + 1} of ${count} of the file (HTTP ${answered.status}).`,
          notSubmitted,
        );
      }
      if (answered.body.includes('Error')) {
        let said = '';
        try {
          const e = (JSON.parse(answered.body) as { Error?: unknown }).Error;
          if (typeof e === 'string') said = e.trim();
        } catch {
          // not JSON: report without the portal's sentence
        }
        throw this.fail(`TherapyPortal refused the file${said ? `: ${said}` : '.'}`, notSubmitted);
      }
    }
  }

  /** `document/stageduploadvalidation`: does the portal accept the staged file for this document? */
  async validateStagedUpload(request: Record<string, unknown>): Promise<FormAdvice[]> {
    const data = await this.read('document/stageduploadvalidation', { request: JSON.stringify(request) });
    return this.judgeFormAdvice(
      data,
      'uploaded file',
      'Nothing was submitted to the practice. Check the file type and size, or upload it in the portal.',
    );
  }

  // --- lookups the write tools read first (all side-effect free) ---------------

  /** Practice messaging settings (`SecureMessagingEnabled`, the portal notices) and topics. */
  messageSettings(): Promise<unknown> {
    return this.read('messages/getsettings', { forceFromService: 'false' });
  }

  /** The message topics one client may write to. */
  messageTopics(patientId: number): Promise<unknown> {
    return this.read('messages/gettopicsforaudiences', {
      audiences: '0,1,2',
      patientId: String(patientId),
      ignoreUserPermissions: '',
    });
  }

  /** Whether the client has an assigned clinician (a bare JSON boolean). */
  async hasAssignedClinician(patientId: number): Promise<boolean> {
    return (await this.read('messages/checkifpatienthasassignedclinician', { patientid: String(patientId) })) === true;
  }

  /** The clients linked to this login. Full demographic records — project before returning. */
  listClients(): Promise<unknown> {
    return this.read('document/getpatientsforportaluser');
  }

  /** Upcoming appointments plus the practice's name and phone. */
  appointments(): Promise<unknown> {
    return this.read('appointments/appointmentinformation', {
      json: JSON.stringify({ searchAllAppointmentsForTheDay: false, usersCurrentTimeInUtc: nowUtc() }),
    });
  }

  /** Document requests the practice sent, by status. */
  documentRequests(filter: DocumentFilter): Promise<unknown> {
    return this.read('documents/api/getportaluserdocumentrequestsbystatus', {
      Request: JSON.stringify(FILTER_STATUSES[filter]),
    });
  }

  /** The practice's always-available forms. */
  alwaysAvailableDocuments(): Promise<unknown> {
    return this.read('documents/api/getalwaysavailabledocumentsforportaluser');
  }

  /** Per-client counts of documents waiting for completion or approval. */
  documentCounts(): Promise<unknown> {
    return this.read('getportaldocumentstatisticsforportaluser');
  }

  balances(): Promise<unknown> {
    return this.read('billing/payments/getbalancesdueforportaluser');
  }

  receipts(): Promise<unknown> {
    return this.read('billing/payments/getreceiptsforportaluser');
  }

  /** Message threads for one client: the exact body the Messages page sends for "All". */
  threads(patientId: number, count: number): Promise<unknown> {
    return this.read('messages/getthreads', {
      patientselection: 'null',
      readstatus: '2',
      audiences: '0,1,2',
      topicid: '-1',
      patientid: String(patientId),
      newestfirst: 'true',
      recordnumber: '0',
      recordstoretrieve: String(count),
      addresseetype: '',
    });
  }

  /** The messages in one thread. Reading never calls markthreadasread. */
  messages(threadId: number): Promise<unknown> {
    return this.read('messages/getmessages', { threadid: String(threadId) });
  }

  /**
   * Download one document. A practice-uploaded file (type 0) is linked directly;
   * anything else is a portal form rendered to PDF by a download job.
   */
  async downloadDocument(
    portalDocumentId: number,
    patientId: number,
    patientDocumentType: number,
  ): Promise<DownloadedFile> {
    if (patientDocumentType === PRACTICE_FILE_TYPE) {
      return this.transport.download(`documents/files/download/${portalDocumentId}/`);
    }
    return this.runJob('document/createportalformdownloadrequest', {
      request: JSON.stringify({
        PortalFormId: portalDocumentId,
        PatientId: patientId,
        PatientDocumentType: patientDocumentType,
      }),
    });
  }

  /** Download a payment receipt (PDF). */
  downloadReceipt(paymentId: number): Promise<DownloadedFile> {
    return this.runJob('billing/payments/createreceiptdownloadrequest', { PaymentId: String(paymentId) });
  }

  private async runJob(createPath: string, fields: Record<string, string>): Promise<DownloadedFile> {
    const job = this.parse(await this.transport.call(createPath, fields), createPath);
    const jobId = (job as { JobId?: unknown } | null)?.JobId;
    if (typeof jobId !== 'number') {
      throw this.fail('TherapyPortal did not start the download.', API_HINT);
    }
    for (let i = 0; i < this.maxPolls; i++) {
      throwIfCancelled();
      const st = this.parse(
        await this.transport.call('document/getdocumentdownloadstatus', {
          request: JSON.stringify({ Id: jobId }),
        }),
        'document/getdocumentdownloadstatus',
      ) as { ProgressPercentage?: unknown; EncryptedJobID?: unknown } | null;
      if (st?.ProgressPercentage === 100 && typeof st.EncryptedJobID === 'string' && st.EncryptedJobID !== '') {
        return this.transport.download(`document/download/${encodeURIComponent(st.EncryptedJobID)}/`);
      }
      await this.sleep(this.pollIntervalMs);
    }
    throw this.fail(
      'TherapyPortal did not finish preparing the download in time.',
      'The portal renders the PDF on demand; retry in a minute.',
    );
  }
}
