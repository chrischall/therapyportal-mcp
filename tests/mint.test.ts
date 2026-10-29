import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mint = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');
// The credentials the server actually reads live in index.ts (there is no auth
// flow/module: the password login needs no challenge step). An auth field the
// server never reads would be collected at connect time and then ignored, so it
// is pinned against the entry point's own reads.
const indexSrc = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

/** The env-var names under the top-level `env:` block (before `identity:`). */
function envNames(): string[] {
  const block = mint.split('identity:')[0] as string;
  return [...block.matchAll(/- name: ([A-Z_]+)/g)].map((m) => m[1] as string);
}

/** The auth-field names under `auth.fields:`. */
function fieldNames(): string[] {
  const block = mint.split('fields:')[1] as string;
  return [...block.matchAll(/- name: ([A-Z_]+)/g)].map((m) => m[1] as string);
}

describe('mint.yaml auth fields stay in step with the server', () => {
  it('collects the email, the password and the optional DOB, secrets masked', () => {
    expect(fieldNames()).toEqual(['THERAPYPORTAL_EMAIL', 'THERAPYPORTAL_PASSWORD', 'THERAPYPORTAL_DOB']);
    const fields = mint.split('fields:')[1] as string;
    expect(fields).toMatch(/- name: THERAPYPORTAL_PASSWORD[\s\S]*?type: password/);
    expect(fields).toMatch(/- name: THERAPYPORTAL_DOB[\s\S]*?type: password[\s\S]*?required: false/);
  });

  it('every auth field is a variable the server actually reads', () => {
    // A field the entry point never reads would be a dead prompt at connect time.
    for (const name of fieldNames()) {
      expect(indexSrc, `index.ts reads ${name}`).toMatch(
        new RegExp(`(?:readEnvVar|requireEnvVar)\\(\\s*'${name}'`),
      );
    }
  });

  it('puts no default on a secret', () => {
    // A default on a credential field would ship a shared/blank password into
    // every connection. The schema allows `default`; this server uses none, on
    // any field — assert the whole fields block is default-free.
    const fields = mint.split('fields:')[1] as string;
    expect(fields).not.toMatch(/\bdefault:/);
  });

  it('does not name a host-set variable as an auth field', () => {
    const names = new Set(fieldNames());
    expect(envNames().filter((n) => names.has(n))).toEqual([]);
  });
});

describe('mint.yaml env block', () => {
  it('declares THERAPYPORTAL_PRACTICE as a required host-set variable, and the server reads it', () => {
    const block = mint.split('identity:')[0] as string;
    expect(block).toMatch(/- name: THERAPYPORTAL_PRACTICE\n\s*required: true/);
    expect(indexSrc).toMatch(/requireEnvVar\(\s*'THERAPYPORTAL_PRACTICE'/);
  });

  it('lists every documented non-credential env var', () => {
    // The credentials go through auth.fields; everything else the README/.env
    // document must appear here, or a hosted install cannot set it.
    const declared = new Set(envNames());
    for (const name of [
      'THERAPYPORTAL_PRACTICE',
      'THERAPYPORTAL_TRANSPORT',
      'THERAPYPORTAL_WS_PORT',
      'THERAPYPORTAL_OUTPUT_DIR',
      'THERAPYPORTAL_INLINE_DOWNLOADS',
    ]) {
      expect(declared, `mint.yaml env declares ${name}`).toContain(name);
    }
  });
});

describe('mint.yaml registration shape', () => {
  it('declares per-user children and a data directory', () => {
    expect(mint).toMatch(/perUserChild:\s*true/);
    expect(mint).toMatch(/dataDir:\s*true/);
  });

  it('notes the bridge-hosting extras it cannot express as columns', () => {
    // A bridged registration needs bridge:true + bridgePortEnv, set over the
    // control API; the manifest can only document that it is needed.
    expect(mint).toMatch(/bridge:\s*true/);
    expect(mint).toMatch(/bridgePortEnv:\s*THERAPYPORTAL_WS_PORT/);
  });

  it('allows exactly the one portal host', () => {
    expect(mint).toMatch(/egress:\n(?:\s*#.*\n)*\s*allow:\n\s*- www\.therapyportal\.com\n?$/);
  });

  it('has a one-line summary within the schema limit', () => {
    const m = mint.match(/^summary: >-\n((?: {2}.+\n)+)/m);
    expect(m, 'mint.yaml has no folded `summary: >-` block').not.toBeNull();
    const summary = (m![1] as string).split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(200);
  });
});
