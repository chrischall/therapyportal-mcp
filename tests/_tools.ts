// Shared test rig: a FakeTransport that answers data calls by path, and a
// `capture` that registers a tool module on a stub server and hands back the
// handlers plus the transport (to assert which calls were made).
//
// Every fixture here is SYNTHETIC — invented names and ids, never a real
// account's data.
import { TherapyPortalClient } from '../src/client.js';
import type { DownloadIO } from '../src/download-io.js';
import type { DownloadedFile, FetchResult, TherapyPortalTransport } from '../src/transport.js';
import { registerAppointmentTools } from '../src/tools/appointments.js';
import { registerBillingTools } from '../src/tools/billing.js';
import { registerClientTools } from '../src/tools/clients.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { registerMessageTools } from '../src/tools/messages.js';

export interface FakeCall {
  path: string;
  fields: Record<string, string>;
}

export class FakeTransport implements TherapyPortalTransport {
  calls: FakeCall[] = [];
  downloads: string[] = [];
  constructor(
    private readonly responder: (call: FakeCall) => FetchResult,
    private readonly downloader: (path: string) => DownloadedFile = () => {
      throw new Error('no downloader');
    },
  ) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  status(): unknown {
    return {};
  }
  async call(path: string, fields: Record<string, string> = {}): Promise<FetchResult> {
    const call = { path, fields };
    this.calls.push(call);
    return this.responder(call);
  }
  async download(path: string): Promise<DownloadedFile> {
    this.downloads.push(path);
    return this.downloader(path);
  }
}

export const okJson = (value: unknown): FetchResult => ({ status: 200, body: JSON.stringify(value) });

export type ToolResult = { content: { text: string }[]; isError?: boolean };
export type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<ToolResult>;

export interface Captured {
  handlers: Map<string, Handler>;
  transport: FakeTransport;
  client: TherapyPortalClient;
}

/** Register a tool module and return its handlers keyed by tool name. */
export function capture(
  register: (server: never, client: TherapyPortalClient) => void,
  responder: (call: FakeCall) => FetchResult,
  downloader?: (path: string) => DownloadedFile,
): Captured {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _def: unknown, fn: Handler) => handlers.set(name, fn) };
  const transport = new FakeTransport(responder, downloader);
  const client = new TherapyPortalClient({ transport, sleep: async () => {}, pollIntervalMs: 0 });
  register(server as never, client);
  return { handlers, transport, client };
}

/** The text of a tool result's first content block. */
export function textOf(res: ToolResult): string {
  return res.content[0]!.text;
}

/** Parse a tool result as JSON. */
export function jsonOf(res: ToolResult): unknown {
  return JSON.parse(textOf(res)) as unknown;
}

/** A no-op transport for registration-only tests (no call reaches the network). */
export const stubTransport: TherapyPortalTransport = {
  start: async () => {},
  close: async () => {},
  status: () => ({}),
  call: async () => ({ status: 200, body: 'null' }),
  download: async () => ({ kind: 'bytes', bytes: new Uint8Array() }),
};

/** A disk-persisting DownloadIO stub. */
export const stubDownloadIO: DownloadIO = {
  persistsFiles: true,
  deliver: (args) => ({ fileName: args.fileName, mimeType: args.mimeType, size: args.bytes.length, savedTo: `/out/${args.fileName}` }),
};

/** Every non-healthcheck registrar, for roster tests. */
export function registerAll(server: never, client: TherapyPortalClient, io: DownloadIO = stubDownloadIO): void {
  registerClientTools(server, client);
  registerAppointmentTools(server, client);
  registerDocumentTools(server, client);
  registerBillingTools(server, client);
  registerMessageTools(server, client);
  registerDownloadTools(server, client, io);
}

/** The names every non-healthcheck module registers. */
export function readToolRoster(): string[] {
  const names: string[] = [];
  const server = { registerTool: (name: string) => names.push(name) };
  registerAll(server as never, new TherapyPortalClient({ transport: stubTransport }));
  return names;
}

// ---- synthetic portal pages ------------------------------------------------

/** A signed-in practice page carrying the three data-call tokens. */
export function signedInPage(opts: { tnrac?: string; tnv?: string; practiceId?: number } = {}): string {
  return (
    '<html><head><title>Client Portal for Example Practice | TherapyPortal</title></head><body>' +
    `<input type="hidden" name="TNRAC" id="TNRAC" value="${opts.tnrac ?? 'tok-abc'}" />` +
    `<script>siteVersion = "${opts.tnv ?? '2026.1.1.1'}";\n` +
    `userInfo = {"Email":"parent@example.com","Status":1,"ID":424242,"PracticeID":${opts.practiceId ?? 777},"PracticeCode":"Example777"},\n</script>` +
    '</body></html>'
  );
}

/** The anonymous public page: no TNRAC input, no user id. */
export function anonymousPage(): string {
  return (
    '<html><head><title>Client Portal for Example Practice | TherapyPortal</title></head><body>' +
    '<script>siteVersion = "2026.1.1.1";\nuserInfo = {"Email":"","Status":0,"PracticeID":777,"PracticeCode":"Example777"},\n</script>' +
    '</body></html>'
  );
}

/** The practice's sign-in page. */
export function loginPage(): string {
  return (
    '<html><head><title>Log In | Example Practice | TherapyPortal</title></head><body>' +
    '<script>siteVersion = "2026.1.1.1";\nuserInfo = {"Email":"","PracticeID":777,"PracticeCode":"Example777"},\n</script>' +
    '</body></html>'
  );
}
