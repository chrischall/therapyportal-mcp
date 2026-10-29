import { describe, expect, it } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { FetchproxyTransport as InnerTransport } from '@chrischall/mcp-utils/fetchproxy';
import { NotSignedInError, TherapyPortalClient } from '../src/client.js';
import { FetchproxyTransport } from '../src/transport-fetchproxy.js';
import { PermanentTransportError } from '../src/transport.js';
import { registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { loginPage, signedInPage } from './_tools.js';

const HOST = 'www.therapyportal.com/p/example777';

interface Result {
  ok: boolean;
  credential?: { source: string | null; resolved: boolean };
  bridge?: unknown;
  probe: { url?: string; elapsed_ms: number; status?: number };
  error?: { kind: string; message: string };
  hint: string;
}

async function run(
  client: TherapyPortalClient,
  arms: { bridge?: FetchproxyTransport; credentialsConfigured: boolean },
): Promise<Result> {
  const h = await createTestHarness((server) =>
    registerHealthcheckTool(server, client, HOST, {
      bridge: arms.bridge,
      credentialsConfigured: arms.credentialsConfigured,
    }),
  );
  const res = await h.callTool('therapyportal_healthcheck');
  await h.close();
  return parseToolResult<Result>(res as never);
}

function clientWith(listClients: () => Promise<unknown>): TherapyPortalClient {
  return { listClients } as unknown as TherapyPortalClient;
}

describe('therapyportal_healthcheck, credential arm', () => {
  it('reports ok when the client list resolves', async () => {
    const r = await run(clientWith(async () => ({ Dashboard: [{}] })), { credentialsConfigured: true });
    expect(r.ok).toBe(true);
    expect(r.credential).toMatchObject({ source: 'env', resolved: true });
  });

  it('names the session when the portal is signed out', async () => {
    const r = await run(
      clientWith(async () => {
        throw new NotSignedInError('server');
      }),
      { credentialsConfigured: true },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('session_expired');
    expect(r.hint).toContain('read tool');
  });

  it('names the credentials when the portal refused them', async () => {
    const r = await run(
      clientWith(async () => {
        throw new PermanentTransportError('refused', { hint: 'x', kind: 'credential_rejected' });
      }),
      { credentialsConfigured: true },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('credential_rejected');
    expect(r.hint).toContain('THERAPYPORTAL_PASSWORD');
  });

  it('skips the probe when no credential is configured', async () => {
    const r = await run(clientWith(async () => ({})), { credentialsConfigured: false });
    expect(r.ok).toBe(false);
    expect(r.credential).toMatchObject({ source: null });
    expect(r.error?.kind).toBe('no_credential');
  });
});

describe('therapyportal_healthcheck, bridge arm', () => {
  function bridge(page: string = signedInPage()): { transport: FetchproxyTransport } {
    const inner = {
      start: async () => {},
      close: async () => {},
      status: () => ({ lastExtensionMessageAt: null }),
      runProbe: async (fetchFn: (p: string) => Promise<unknown>, path: string) => {
        const body = (await fetchFn(path)) as string;
        return {
          ok: true,
          elapsed_ms: 3,
          bridge: { role: 'host', last_failure_reason: null, body_len: body.length },
        };
      },
      fetch: async () => ({ status: 200, body: page, url: undefined }),
    } as unknown as InnerTransport;
    const transport = new FetchproxyTransport({
      practice: 'example777',
      version: '0.0.0',
      createInner: (() => inner) as never,
    });
    return { transport };
  }

  it('fails the probe with the sign-in remedy when the tab is signed out', async () => {
    const { transport } = bridge(loginPage());
    const client = new TherapyPortalClient({ transport, mode: 'fetchproxy' });
    const h = await createTestHarness((server) =>
      registerHealthcheckTool(server, client, HOST, { bridge: transport, credentialsConfigured: false }),
    );
    const res = (await h.callTool('therapyportal_healthcheck')) as { isError?: boolean; content: { text: string }[] };
    await h.close();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Not signed in to TherapyPortal[\s\S]*Chrome/);
  });

  it('round-trips the practice page through the bridge', async () => {
    const { transport } = bridge();
    const client = new TherapyPortalClient({ transport, mode: 'fetchproxy' });
    const r = await run(client, { bridge: transport, credentialsConfigured: false });
    expect(r.ok).toBe(true);
    expect(r.bridge).toBeDefined();
  });
});
