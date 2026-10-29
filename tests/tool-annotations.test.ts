import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { TherapyPortalClient } from '../src/client.js';
import { registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { registerAll, stubTransport } from './_tools.js';

// The whole served surface, through a real MCP client — so this sees exactly
// what a host sees, including tools a registrar adds that a name scan would miss.
async function servedTools() {
  const client = new TherapyPortalClient({ transport: stubTransport });
  const h = await createTestHarness((server) => {
    registerAll(server as never, client);
    registerHealthcheckTool(server, client, 'www.therapyportal.com/p/example777', {
      bridge: undefined,
      credentialsConfigured: true,
    });
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8'),
) as { tools: { name: string; description: string }[] };

describe('tool annotations', () => {
  it('serves exactly the manifest.json roster, in both directions', async () => {
    const served = (await servedTools()).map((t) => t.name).sort();
    expect(served).toEqual(manifest.tools.map((t) => t.name).sort());
    for (const t of manifest.tools) expect(t.description.trim(), t.name).not.toBe('');
  });

  it('marks every tool read-only, non-destructive and open-world', async () => {
    // This server is read-only by design: there is no inverse to reason about
    // because nothing writes. A future write must change this test on purpose.
    for (const t of await servedTools()) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      // therapyportal_healthcheck is the fleet-standard tool from
      // @chrischall/mcp-utils, which sets readOnly but not destructiveHint.
      if (t.name !== 'therapyportal_healthcheck') expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
    }
  });

  it('describes every tool and takes no boolean confirm input', async () => {
    for (const t of await servedTools()) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain('confirm');
    }
  });
});
