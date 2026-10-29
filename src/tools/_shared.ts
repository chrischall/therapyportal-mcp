// Small shared helpers for the read tools: safe coercions for the loosely typed
// portal payloads. Anything a single tool needs lives beside that tool.

import { toolAnnotations } from '@chrischall/mcp-utils';

/**
 * The annotation every tool in this server shares: it reads the live portal
 * and changes nothing. `destructive: false` is passed explicitly so the hint is
 * a BOOLEAN rather than omitted — `destructiveHint` defaults to true for any
 * non-read tool, and a client cannot tell a considered read from one that
 * forgot to say.
 */
export const READ = toolAnnotations({ readOnly: true, destructive: false, openWorld: true });

/** A value as a plain object, or `{}` — never an array, never null. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A value as an array of plain objects, dropping anything that is not one. */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
  );
}

/**
 * Drop null, undefined and empty-string values so a compact record stays
 * compact. `false` and `0` are kept — they are answers, not absences.
 */
export function tidy(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * The first of `values` that is a non-blank string. The portal sends a blank
 * nickname as `""`, so `a ?? b` would keep the blank.
 */
export function firstText(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

/** A client's display name: nickname, else first name. */
export function displayName(nickname: unknown, firstName: unknown): string | undefined {
  return firstText(nickname, firstName);
}
