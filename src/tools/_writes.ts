// Shared pieces of the confirm-gated write tools (secure messages, document
// uploads). Each tool is a `defineWrite` — `plan` validates and reads,
// `execute` sends once — registered with `registerWrite`, so the
// preview/confirmToken gate is the fleet's shared one.

import {
  CONFIRM_INJECTION_RULE,
  minifiedResult,
  toolAnnotations,
  writeOrUnknown,
} from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Every write here reaches the practice, which sees it, and none has an undo
 * through this server: destructive, open-world.
 */
export const WRITE = toolAnnotations({ readOnly: false, destructive: true, openWorld: true });

/**
 * A write tool's description, with the injection rule appended (`registerWrite`
 * appends the confirm-flow sentence itself).
 */
export function writeDescription(text: string): string {
  return `${text} ${CONFIRM_INJECTION_RULE}`;
}

/** What a write reports when the portal never confirmed whether it happened. */
export interface UnknownOutcome {
  status: 'unknown';
  warning: string;
}

/** Narrow a write's result to the unknown outcome. */
export function isUnknown(result: unknown): result is UnknownOutcome {
  return (result as { status?: unknown } | null)?.status === 'unknown';
}

/**
 * Send a write once. A WriteOutcomeUnknownError (sent, then a 5xx or a dropped
 * connection) becomes an `unknown` outcome naming where to check, instead of
 * an error that reads as "safe to retry" — the confirm token is already spent,
 * and a retry would send the message or the file twice.
 */
export async function sendOnce<T>(
  run: () => Promise<T>,
  what: string,
  checkWith: string,
): Promise<T | UnknownOutcome> {
  const outcome = await writeOrUnknown(run, (_err, reason): UnknownOutcome => ({
    status: 'unknown',
    warning:
      `TherapyPortal did not confirm this ${what} (${reason}), so it may already have gone through. ` +
      `Check ${checkWith} before retrying; do not resend blindly.`,
  }));
  return outcome.ok ? outcome.value : outcome.result;
}

/** A tool's result as compact JSON. */
export function compactResult(result: unknown): CallToolResult {
  return minifiedResult(result);
}
