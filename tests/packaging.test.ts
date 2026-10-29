import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8'));
const pkg = read('package.json') as {
  name: string;
  files: string[];
  repository?: { url?: string };
  publishConfig?: { access?: string };
};

describe('packaging', () => {
  // `npm publish --provenance` validates the sigstore bundle against
  // repository.url and rejects the whole publish with E422 when it is missing.
  // That fires AFTER release-please has tagged and cut the GitHub Release, so
  // the release looks green while npm never moves — and re-running cannot fix
  // it, because the tag's tree still lacks the field.
  it('declares repository.url for provenance', () => {
    expect(pkg.repository?.url).toBe(
      'git+https://github.com/chrischall/therapyportal-mcp.git',
    );
  });

  it('publishes the scoped name publicly', () => {
    expect(pkg.name).toBe('@chrischall/therapyportal-mcp');
    expect(pkg.publishConfig?.access).toBe('public');
  });

  // An npm-sourced mcp-host registration reads the published TARBALL, so a
  // mint.yaml outside `files` is simply absent and the register wizard comes up
  // empty with no error. Same silent-omission class for `skills`.
  it.each(['dist', 'skills', 'mint.yaml', 'server.json', '.claude-plugin'])(
    'ships %s',
    (entry) => {
      expect(pkg.files).toContain(entry);
    },
  );

  it('server.json description fits the MCP registry limit', () => {
    expect((read('server.json') as { description: string }).description.length).toBeLessThanOrEqual(100);
  });

  it('points the plugin at the skills directory', () => {
    expect((read('.claude-plugin/plugin.json') as { skills?: string }).skills).toBe('./skills/');
  });

  // Claude Code reads the plugin's MCP config from `mcpServers`; an `mcp` key is
  // an unknown field it ignores. It only looked fine here because ./.mcp.json
  // is the default — copies that pointed `mcp` at another path broke installs.
  it('declares the plugin MCP config under mcpServers', () => {
    const plugin = read('.claude-plugin/plugin.json') as Record<string, unknown>;
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(
      existsSync(fileURLToPath(new URL(`../${plugin.mcpServers as string}`, import.meta.url))),
    ).toBe(true);
  });
});
