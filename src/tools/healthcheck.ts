import type { McpServer } from '@modelcontextprotocol/server';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { NotSignedInError, type TherapyPortalClient } from '../client.js';
import { parsePageTokens } from '../transport.js';
import type { FetchproxyTransport } from '../transport-fetchproxy.js';

export interface HealthcheckArms {
  /** Present only when relaying through the browser bridge. */
  bridge: FetchproxyTransport | undefined;
  /** Whether server-side credentials are configured (drives the credential arm). */
  credentialsConfigured: boolean;
}

/**
 * ONE `therapyportal_healthcheck`, answering from whichever transport carries
 * requests. The credential arm signs in (if needed) and reads the client list;
 * the bridge arm round-trips the signed-in practice page through the user's
 * tab. The probe is skipped when no credential resolves.
 */
export function registerHealthcheckTool(
  server: McpServer,
  client: TherapyPortalClient,
  hostLabel: string,
  arms: HealthcheckArms,
): void {
  const { bridge, credentialsConfigured } = arms;
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'therapyportal',
    hostLabel,
    usingBridge: () => bridge !== undefined,
    bridge: {
      probePath: 'practice page',
      transport: () => bridge as FetchproxyTransport,
      probeFn: async () => {
        const page = await (bridge as FetchproxyTransport).page();
        if (parsePageTokens(page.body) === undefined) throw new NotSignedInError('fetchproxy');
        return page.body;
      },
    },
    credential: {
      probePath: 'document/getpatientsforportaluser',
      resolveCredential: async () =>
        credentialsConfigured ? { source: 'env', detail: { transport: 'server' } } : { source: null },
      probeFn: async () => {
        await client.listClients();
      },
      hints: {
        session_expired:
          `${hostLabel} has no live session yet. A read tool signs in with ` +
          'THERAPYPORTAL_EMAIL / THERAPYPORTAL_PASSWORD on first use; run one and retry.',
        credential_rejected:
          `${hostLabel} refused the sign-in. Check THERAPYPORTAL_EMAIL, THERAPYPORTAL_PASSWORD ` +
          'and (if asked) THERAPYPORTAL_DOB — nothing retries automatically.',
      },
    },
  });
}
