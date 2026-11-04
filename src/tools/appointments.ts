import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import { READ, asRecord, asRecordArray, displayName, tidy } from './_shared.js';
import type { KnownClient } from './_lookups.js';
import { healthMeta } from './hints.js';
import { briefLine, clientArg, resolveClient, type ClientDirectory } from './subjects.js';
import { PASSTHROUGH_VIEWS, viewResponse } from '../view.js';

const VIEWS = [...PASSTHROUGH_VIEWS, 'brief'] as const;

/** Whether an appointment is for `who`: by patient id when the row carries one, else by display name. */
function isFor(appt: Record<string, unknown>, who: KnownClient): boolean {
  return asRecordArray(appt.Patients).some((p) => {
    const id = p.PatientId ?? p.Id;
    if (id !== undefined && id !== null) return Number(id) === who.patientId;
    const name = displayName(p.Nickname, p.FirstName);
    return who.name !== undefined && name !== undefined && name.toLowerCase() === who.name.toLowerCase();
  });
}

/**
 * One appointment as `<type> with <clinician> (<telehealth | location>) for
 * <clients> — <start, ISO local> — <status>`, at most 120 characters.
 */
export function appointmentBrief(a: Record<string, unknown>): string {
  const type = typeof a.CalendarEntryTypeName === 'string' && a.CalendarEntryTypeName !== '' ? a.CalendarEntryTypeName : 'Appointment';
  const parts = [type];
  if (typeof a.ClinicianDisplayName === 'string' && a.ClinicianDisplayName !== '') parts.push(`with ${a.ClinicianDisplayName}`);
  const where = a.IsTelehealth === true ? 'telehealth' : typeof a.LocationName === 'string' && a.LocationName !== '' ? a.LocationName : undefined;
  if (where !== undefined) parts.push(`(${where})`);
  const names = asRecordArray(a.Patients)
    .map((p) => displayName(p.Nickname, p.FirstName))
    .filter((n): n is string => n !== undefined);
  if (names.length > 0) parts.push(`for ${names.join(', ')}`);
  const date = typeof a.StartDate === 'string' && a.StartDate !== '' ? a.StartDate : 'no date';
  const status = a.PendingCancel ? 'cancellation requested' : a.PendingReschedule ? 'reschedule requested' : 'scheduled';
  return briefLine(parts.join(' '), date, status);
}

export function registerAppointmentTools(
  server: McpServer,
  client: TherapyPortalClient,
  clients?: ClientDirectory | null,
): void {
  server.registerTool(
    'therapyportal_list_appointments',
    {
      description:
        'List upcoming therapy appointments / sessions from TherapyPortal: date and time, ' +
        'clinician, telehealth or in-person location, and which client each is for, plus any ' +
        'pending appointment requests and the practice’s phone number. The portal shows future ' +
        'appointments only — there is no past-visit history.',
      annotations: READ,
      _meta: healthMeta('whats-on', {
        canonical: true,
        subject: 'client',
        aliases: ['therapy', 'therapist', 'counselor', 'counseling', 'session', 'appointment'],
      }),
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe('Most appointments to return, soonest first (1–200). Default 20.'),
        client: clientArg(clients),
        view: z
          .enum(VIEWS)
          .optional()
          .describe(
            'compact (default) projects each appointment to the fields a caller acts on; "full" keeps every ' +
              'field this server understands; "raw" returns the portal payload untouched; "brief" returns one ' +
              'line per appointment: <type> with <clinician> for <client> — <ISO start> — ' +
              '<scheduled|cancellation requested|reschedule requested>.',
          ),
      }),
    },
    async ({ limit, client: who, view }) => {
      const target = who === undefined ? undefined : await resolveClient(client, clients, who);
      const raw = await client.appointments();
      const upcoming = (d: Record<string, unknown>): Record<string, unknown>[] =>
        asRecordArray(d.Appointments)
          .filter((a) => target === undefined || isFor(a, target))
          .sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
      if (view === 'brief') {
        const text = upcoming(asRecord(raw)).slice(0, limit).map(appointmentBrief).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      }
      return viewResponse(view, raw, (data) => {
        const d = asRecord(data);
        if (!Array.isArray(d.Appointments)) return undefined;
        const all = upcoming(d);
        return tidy({
          practice: d.PracticeName,
          practicePhone: d.PracticePhone,
          total: all.length,
          appointments: all.slice(0, limit).map((a) =>
            tidy({
              apptId: a.ApptId,
              start: a.StartDate,
              end: a.EndDate,
              timeZone: a.TimeZoneAbbreviation,
              type: a.CalendarEntryTypeName,
              clinician: a.ClinicianDisplayName,
              clinicianTitle: a.ClinicianDisplayTitle,
              telehealth: a.IsTelehealth,
              location: a.LocationName,
              clients: asRecordArray(a.Patients).map((p) => displayName(p.Nickname, p.FirstName)),
              pendingCancel: a.PendingCancel || undefined,
              pendingReschedule: a.PendingReschedule || undefined,
            }),
          ),
          requests: asRecordArray(d.AppointmentRequests).length > 0 ? d.AppointmentRequests : undefined,
        });
      });
    },
  );
}
