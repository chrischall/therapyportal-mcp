// The live reads the write tools validate against before they show a preview.
// All side-effect free. Kept apart from the tools so both the messaging and the
// upload tools check "is this one of my clients?" the same way.

import { McpToolError } from '@chrischall/mcp-utils';
import type { TherapyPortalClient } from '../client.js';
import { asRecord, asRecordArray, displayName } from './_shared.js';

/** A client linked to this login, as the write tools name it. */
export interface KnownClient {
  patientId: number;
  /** Display name (nickname, else first name); may be absent. */
  name?: string;
}

/** The clients linked to this login (id + display name only). */
export async function knownClients(client: TherapyPortalClient): Promise<KnownClient[]> {
  return asRecordArray(await client.listClients()).map((p) => ({
    patientId: Number(p.Id ?? p.PatientId),
    name: displayName(p.Nickname, p.FirstName),
  }));
}

/** The client `patientId`, or an error naming the valid ids when it is not linked to this login. */
export async function requireClient(client: TherapyPortalClient, patientId: number): Promise<KnownClient> {
  const clients = await knownClients(client);
  const found = clients.find((c) => c.patientId === patientId);
  if (found === undefined) {
    throw new McpToolError(`Client ${patientId} is not linked to this TherapyPortal login.`, {
      hint:
        `Valid patient ids: ${clients.map((c) => c.patientId).join(', ') || 'none'}. ` +
        'See therapyportal_list_clients. Nothing was sent.',
    });
  }
  return found;
}

/** The practice's messaging settings, as the write tools use them. */
export interface MessagingSettings {
  enabled: boolean;
  /** The practice-written notices the portal shows on the Messages page (untrusted). */
  notices: Record<string, string>;
}

/** Read `messages/getsettings`. */
export async function messagingSettings(client: TherapyPortalClient): Promise<MessagingSettings> {
  const ps = asRecord(asRecord(await client.messageSettings()).PracticeSettings);
  const notices: Record<string, string> = {};
  const add = (key: string, value: unknown, show = true): void => {
    if (show && typeof value === 'string' && value.trim() !== '') notices[key] = value.trim();
  };
  add('portal', ps.PortalMessage);
  add('administrative', ps.PortalAdminMessageEnglish, ps.ShowPortalAdminMessage === true);
  add('billing', ps.PortalBillingMessageEnglish, ps.ShowPortalBillingMessage === true);
  return { enabled: ps.SecureMessagingEnabled === true, notices };
}

/** Refuse when the practice has secure messaging turned off. */
export async function requireMessaging(client: TherapyPortalClient): Promise<MessagingSettings> {
  const settings = await messagingSettings(client);
  if (!settings.enabled) {
    throw new McpToolError('This practice has secure messaging turned off in TherapyPortal.', {
      hint: 'Contact the practice another way (see therapyportal_list_appointments for its phone). Nothing was sent.',
    });
  }
  return settings;
}
