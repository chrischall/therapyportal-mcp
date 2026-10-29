#!/usr/bin/env node
// therapyportal-mcp — a TherapyNotes client portal (TherapyPortal).
//
// Two transports, chosen by what is configured:
//
//   * email + password set → bridge-less. Signs in server-side with a cookie
//     jar. No browser, no extension, and therefore hostable.
//   * otherwise            → the fetchproxy bridge, relaying through the user's
//     signed-in portal tab. Holds no credentials at all.
//
// NOT read-only: alongside the reads and downloads it sends secure messages
// (new conversations and replies) and uploads a file in answer to a document
// that asks for one — each confirm-gated. It signs no form, fills in no form
// and makes no payment.

import { loadDotenvSafely, readEnvVar, readPortEnv, requireEnvVar, runMcp } from '@chrischall/mcp-utils';
import { TherapyPortalClient, type TransportMode } from './client.js';
import { makeDownloadIO } from './download-io.js';
import { SecretScrubber } from './secrets.js';
import { registerAppointmentTools } from './tools/appointments.js';
import { registerBillingTools } from './tools/billing.js';
import { registerClientTools } from './tools/clients.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerHealthcheckTool } from './tools/healthcheck.js';
import { registerMessageTools } from './tools/messages.js';
import { registerComposeTools } from './tools/compose.js';
import { registerUploadTools, uploadRoots } from './tools/uploads.js';
import { DEFAULT_PORT, FetchproxyTransport } from './transport-fetchproxy.js';
import { ServerTransport } from './transport-server.js';
import { parsePracticeCode, type TherapyPortalTransport } from './transport.js';
import { VERSION } from './version.js';

await loadDotenvSafely({});

const practice = parsePracticeCode(
  requireEnvVar('THERAPYPORTAL_PRACTICE', {
    hint: 'Set THERAPYPORTAL_PRACTICE to the code after /p/ in your portal URL (www.therapyportal.com/p/<code>/).',
  }),
);
const email = readEnvVar('THERAPYPORTAL_EMAIL');
// Secrets keep their exact bytes: a password may begin or end with a space.
const password = readEnvVar('THERAPYPORTAL_PASSWORD', { trim: false });
const dob = readEnvVar('THERAPYPORTAL_DOB');
const credentialsConfigured = email !== undefined && password !== undefined;

const forced = readEnvVar('THERAPYPORTAL_TRANSPORT');
const mode: TransportMode =
  forced === 'server' || forced === 'fetchproxy' ? forced : credentialsConfigured ? 'server' : 'fetchproxy';

const scrubber = new SecretScrubber();
const port = readPortEnv('THERAPYPORTAL_WS_PORT', DEFAULT_PORT);
const hostLabel = `www.therapyportal.com/p/${practice}`;

let transport: TherapyPortalTransport;
let bridge: FetchproxyTransport | undefined;
if (mode === 'server') {
  transport = new ServerTransport({ practice, email, password, dob, scrubber });
} else {
  bridge = new FetchproxyTransport({ practice, version: VERSION, port });
  transport = bridge;
  await bridge.start();
}

const client = new TherapyPortalClient({ transport, scrubber, mode });
const downloadIO = makeDownloadIO();

await runMcp({
  name: 'therapyportal-mcp',
  version: VERSION,
  banner:
    mode === 'server'
      ? `[therapyportal-mcp] v${VERSION} — bridge-less sign-in to ${hostLabel} as the configured account. ` +
        'No browser required. This project was developed and is maintained by AI. Use at your own discretion.'
      : `[therapyportal-mcp] v${VERSION} — TherapyPortal via @fetchproxy/server on 127.0.0.1:${port}. ` +
        `Requests relay through your signed-in ${hostLabel} tab; the session cookie is never read. ` +
        'This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [
    (server) => registerClientTools(server, client),
    (server) => registerAppointmentTools(server, client),
    (server) => registerDocumentTools(server, client),
    (server) => registerBillingTools(server, client),
    (server) => registerMessageTools(server, client),
    (server) => registerDownloadTools(server, client, downloadIO),
    (server) => registerComposeTools(server, client),
    (server) => registerUploadTools(server, client, { allowedRoots: uploadRoots() }),
    (server) => registerHealthcheckTool(server, client, hostLabel, { bridge, credentialsConfigured }),
  ],
});
