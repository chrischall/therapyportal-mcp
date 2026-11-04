// The clients (patients) linked to this login, as the LABELS a person names
// them by — the subject of the two canonical reads (mcp-host context-groups
// spec D5: a subject is an enum of labels, built at start, label-or-id
// accepted). For a parent, each child in therapy.

import { McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { TherapyPortalClient } from '../client.js';
import { knownClients, type KnownClient } from './_lookups.js';

export interface ClientDirectory {
  /** One label per client, in the portal's order; never empty. */
  labels: string[];
  /**
   * A label (any case, trimmed) → that client. A numeric patientId passes
   * through (named when known), so a client linked after start is still
   * reachable. Anything else answers undefined.
   */
  resolve(value: string): KnownClient | undefined;
}

/** Bound on the start-time listing: a host must not wait on it to list tools. */
export const CLIENT_LIST_TIMEOUT_MS = 5_000;

const PATIENT_ID = /^\d+$/;

export function buildClientDirectory(clients: readonly KnownClient[]): ClientDirectory | null {
  const valid = clients.filter((c) => Number.isFinite(c.patientId));
  if (valid.length === 0) return null;
  const base = (c: KnownClient): string => c.name ?? `client ${c.patientId}`;
  const counts = new Map<string, number>();
  for (const c of valid) counts.set(base(c).toLowerCase(), (counts.get(base(c).toLowerCase()) ?? 0) + 1);
  // Two clients sharing a display name each carry their id, so a label never
  // picks the wrong child.
  const labelled = valid.map((c) => ({
    client: c,
    label: counts.get(base(c).toLowerCase())! > 1 ? `${base(c)} (${c.patientId})` : base(c),
  }));
  const byLabel = new Map(labelled.map((l) => [l.label.toLowerCase(), l.client]));
  const byId = new Map(valid.map((c) => [c.patientId, c]));
  return {
    labels: labelled.map((l) => l.label),
    resolve(value: string): KnownClient | undefined {
      const ref = value.trim();
      const hit = byLabel.get(ref.toLowerCase());
      if (hit !== undefined) return hit;
      if (PATIENT_ID.test(ref)) return byId.get(Number(ref)) ?? { patientId: Number(ref) };
      return undefined;
    },
  };
}

/**
 * List the clients ONCE, at server start. Answers null — so the property is
 * published with no `enum` keyword, never an empty one — when the login has no
 * clients, when the listing fails (no browser on the bridge, a rejected
 * sign-in), or when it has not answered within `timeoutMs`. Never throws.
 */
export async function loadClientDirectory(
  client: TherapyPortalClient,
  timeoutMs: number = CLIENT_LIST_TIMEOUT_MS,
): Promise<ClientDirectory | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const listing = knownClients(client)
    .then(buildClientDirectory)
    .catch(() => null);
  try {
    return await Promise.race([listing, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const CLIENT_DESCRIPTION =
  'Only this client (patient): their name as listed, or their patientId from therapyportal_list_clients. ' +
  'Omit for every client on this login.';

/**
 * The `client` argument. Publishes the labels as a JSON Schema `enum` via
 * `.meta()` when the clients were listed at start — the runtime schema stays
 * any string, so a raw patientId still passes. With no listing it is plain.
 */
export function clientArg(directory: ClientDirectory | null | undefined) {
  const base = z.string();
  return (directory ? base.meta({ enum: directory.labels }) : base).optional().describe(CLIENT_DESCRIPTION);
}

/**
 * Resolve a `client` argument to the client it names. Without a start-time
 * directory the clients are listed now, once.
 */
export async function resolveClient(
  client: TherapyPortalClient,
  directory: ClientDirectory | null | undefined,
  value: string,
): Promise<KnownClient> {
  const dir = directory ?? buildClientDirectory(await knownClients(client));
  const found = dir?.resolve(value) ?? (PATIENT_ID.test(value.trim()) ? { patientId: Number(value.trim()) } : undefined);
  if (found !== undefined) return found;
  throw new McpToolError(`No client named "${value}" on this TherapyPortal login.`, {
    hint: `Known clients: ${dir?.labels.join(', ') || 'none'}. See therapyportal_list_clients.`,
  });
}

/** A brief line, shortened in its title to at most 120 characters. */
export function briefLine(title: string, date: string, status: string): string {
  const tail = ` — ${date} — ${status}`;
  const room = 120 - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}
