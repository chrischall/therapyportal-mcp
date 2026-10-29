// The delivery boundary for the file-download tools. A download fetches bytes
// through the portal (see InsyncClient); where those bytes GO depends on where
// the server runs, and that is the one thing this module decides:
//
//   * stdio / desktop install  → the server's filesystem IS the user's, so the
//     bytes are written to a file (NodeDownloadIO, `persistsFiles: true`) under
//     a confined output directory, and the tool returns the path.
//   * hosted runner            → the user can't reach the runner's disk, so the
//     bytes come back inline as base64 (InlineDownloadIO, `persistsFiles:
//     false`), capped so one result can't blow the host's size limit.
//
// Injected into the tools so a test can pass a fake IO and assert what was
// delivered without touching the filesystem.

import { delimiter, join } from 'node:path';
import {
  extensionForMime,
  isSafeExtension,
  parseBoolEnv,
  readEnvVar,
  resolveOutputDir,
  writeBinaryOutput,
  type EnvSource,
} from '@chrischall/mcp-utils';

/** What a download delivered, for the tool to render. */
export interface DownloadOutcome {
  /** The display file name (with extension). */
  fileName: string;
  /** MIME type, when the portal stated one. */
  mimeType?: string;
  /** Size of the downloaded bytes. */
  size: number;
  /** Absolute path written, when the IO persists files. */
  savedTo?: string;
  /** The bytes inline, base64, when the IO does not persist and they fit the cap. */
  base64?: string;
  /** Set when the bytes exceeded the inline cap and were NOT returned. */
  tooLarge?: boolean;
}

/** One file's bytes plus the naming hints a delivery needs. */
export interface DeliverArgs {
  bytes: Uint8Array;
  /** The portal's file name (with extension when it has one). */
  fileName: string;
  mimeType?: string;
  /** The source URL, a fallback for the file extension. */
  url?: string;
  /** Per-call output directory (disk IO only); confined to the IO's roots. */
  dest?: string;
}

/** Where a download's bytes go. */
export interface DownloadIO {
  /** True when bytes are written to disk; false when they come back inline. */
  readonly persistsFiles: boolean;
  deliver(args: DeliverArgs): DownloadOutcome;
}

/** The file extension to write with: the name's own, if safe, else one from the MIME type/URL. */
function resolveExtension(fileName: string, mimeType?: string, url?: string): string {
  const dot = fileName.lastIndexOf('.');
  const named = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (named !== '' && isSafeExtension(named)) return named;
  return extensionForMime(mimeType, { url });
}

/** The filename stem (no extension) to write with. */
function baseStem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return stem === '' ? 'download' : stem;
}

/**
 * Disk-backed delivery: write the bytes to a non-overwriting file under the
 * resolved output directory and report the path. The per-call `dest` is
 * confined to {@link allowedRoots}; `THERAPYPORTAL_OUTPUT_DIR` and the
 * `~/Downloads/therapyportal-mcp` fallback are operator config and are not.
 */
export class NodeDownloadIO implements DownloadIO {
  readonly persistsFiles = true;

  constructor(private readonly allowedRoots: readonly string[]) {}

  deliver(args: DeliverArgs): DownloadOutcome {
    const dir = resolveOutputDir(args.dest, 'THERAPYPORTAL_OUTPUT_DIR', {
      name: 'therapyportal-mcp',
      allowedRoots: this.allowedRoots,
    });
    const savedTo = writeBinaryOutput({
      dir,
      baseName: baseStem(args.fileName),
      base64: Buffer.from(args.bytes).toString('base64'),
      extension: resolveExtension(args.fileName, args.mimeType, args.url),
      mode: 0o600,
    });
    return { fileName: args.fileName, mimeType: args.mimeType, size: args.bytes.length, savedTo };
  }
}

/**
 * Cap on bytes returned inline in one tool result. mcp-host caps a single child
 * result near 14 MiB of serialized JSON-RPC; 8 MiB raw is ~10.7 MiB base64,
 * which with the envelope stays under that, so an over-cap file is reported as
 * too large (with guidance) rather than killing the result.
 */
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/**
 * Filesystem-free delivery for a hosted runner: return the bytes inline as
 * base64, or — when they exceed {@link MAX_INLINE_BYTES} — report `tooLarge`
 * so the tool can tell the caller to download it locally instead. Writes
 * nothing, so `dest` is ignored. `maxInlineBytes` is injectable for tests.
 */
export class InlineDownloadIO implements DownloadIO {
  readonly persistsFiles = false;

  constructor(private readonly maxInlineBytes: number = MAX_INLINE_BYTES) {}

  deliver(args: DeliverArgs): DownloadOutcome {
    const base = { fileName: args.fileName, mimeType: args.mimeType, size: args.bytes.length };
    if (args.bytes.length > this.maxInlineBytes) return { ...base, tooLarge: true };
    return { ...base, base64: Buffer.from(args.bytes).toString('base64') };
  }
}

/** Default roots a per-call `dest` may resolve inside when THERAPYPORTAL_OUTPUT_DIR is unset. */
export const DEFAULT_DOWNLOAD_ROOTS: readonly string[] = ['~/Downloads', '~/Documents'];

/**
 * The folders a per-call download `dest` is confined to:
 *   - `THERAPYPORTAL_OUTPUT_DIR` set → exactly those (a path-delimiter list; `~` expands);
 *   - unset, hosted (`MCP_DATA_DIR`) → `$MCP_DATA_DIR/downloads` only;
 *   - unset, local → `~/Downloads` and `~/Documents`.
 * A blank or delimiter-only value counts as unset, so it can never disable it.
 */
export function downloadRoots(env: EnvSource = process.env): readonly string[] {
  const configured = (readEnvVar('THERAPYPORTAL_OUTPUT_DIR', { env }) ?? '')
    .split(delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  const dataDir = readEnvVar('MCP_DATA_DIR', { env });
  if (dataDir !== undefined && dataDir.trim() !== '') return [join(dataDir.trim(), 'downloads')];
  return DEFAULT_DOWNLOAD_ROOTS;
}

/**
 * Pick the download IO from the environment, the sibling of the transport
 * selector: disk-backed by default (a local stdio install), inline when
 * `THERAPYPORTAL_INLINE_DOWNLOADS` is truthy (a hosted runner whose disk the user
 * cannot reach).
 */
export function makeDownloadIO(env: EnvSource = process.env): DownloadIO {
  return parseBoolEnv('THERAPYPORTAL_INLINE_DOWNLOADS', { env })
    ? new InlineDownloadIO()
    : new NodeDownloadIO(downloadRoots(env));
}
