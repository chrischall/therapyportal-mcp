import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// End-to-end boot guard. Unit tests mock the transport, so they cannot catch
// the two failures that actually ship broken: an eager top-level import of an
// esbuild-externalized dep (ERR_MODULE_NOT_FOUND the moment a host spawns the
// bundle, before it answers `initialize`), and a `bin` pointing at a path the
// build never emits. This spawns the REAL built artifact and runs the handshake
// an MCP host runs at install time.
//
// package.json `bin` is dist/bundle.js — the build is `tsc --noEmit` plus
// esbuild, so there is no separate tsc-emitted entrypoint to test.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 120_000);

/** Spawn the stdio server, run initialize + tools/list, resolve the tool names. */
function listToolsViaStdio(
  entry: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('node', [entry], {
      cwd,
      env: {
        ...process.env,
        // Credentials pin the bridge-less (server) path, which binds no port and
        // touches no network until a tool is called — so tools/list is clean.
        THERAPYPORTAL_PRACTICE: 'boottest00000',
        THERAPYPORTAL_EMAIL: 'boot-test@example.com',
        THERAPYPORTAL_PASSWORD: 'boot-test-pass',
        // Keep off the shared fleet concentrator port (37149) regardless of mode.
        THERAPYPORTAL_WS_PORT: '39733',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stderr:\n${err}`));
    }, 15_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(t) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result && !settled) {
          settled = true;
          clearTimeout(timer);
          const names = (msg.result.tools ?? []).map((x) => x.name);
          child.kill('SIGKILL');
          resolve(names);
          return;
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // 'close' rather than 'exit' so stdout is fully drained first.
    child.on('close', (code) => {
      if (!out.includes('"id":1')) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before tools/list; stderr:\n${err}`));
      }
    });

    child.stdin.write(
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n',
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

// Lower bound, not an exact count: PR CI runs the branch merged with main, so a
// hardcoded count breaks the moment another PR adds a tool. The roster is pinned
// exactly by index.test.ts; this only guards that the built artifact serves it.
const MIN_TOOLS = 12;

describe('server boot (built artifact)', () => {
  it('boots WITHOUT node_modules and lists its tools', async () => {
    // A fresh dir holding only the bundle — the .mcpb runtime, where an eager
    // import of an externalized dep would fail to resolve. The dir has no .env,
    // so the spawn env is the only configuration the child sees.
    const dir = mkdtempSync(join(tmpdir(), 'therapyportal-mcpb-'));
    try {
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const tools = await listToolsViaStdio(join(dir, 'bundle.js'), dir);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      // A read tool, a download tool and the healthcheck — the three kinds of
      // tool this server registers must all be present.
      expect(tools).toContain('therapyportal_list_appointments');
      expect(tools).toContain('therapyportal_download_document');
      expect(tools).toContain('therapyportal_healthcheck');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
