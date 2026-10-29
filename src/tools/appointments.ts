import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import { READ, asRecord, asRecordArray, displayName, tidy } from './_shared.js';
import { viewArg, viewResponse } from '../view.js';

export function registerAppointmentTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_appointments',
    {
      description:
        'List upcoming therapy appointments / sessions from TherapyPortal: date and time, ' +
        'clinician, telehealth or in-person location, and which client each is for, plus any ' +
        'pending appointment requests and the practice’s phone number. The portal shows future ' +
        'appointments only — there is no past-visit history.',
      annotations: READ,
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe('Most appointments to return, soonest first (1–200). Default 20.'),
        view: viewArg(),
      }),
    },
    async ({ limit, view }) => {
      const raw = await client.appointments();
      return viewResponse(view, raw, (data) => {
        const d = asRecord(data);
        if (!Array.isArray(d.Appointments)) return undefined;
        const all = asRecordArray(d.Appointments)
          .slice()
          .sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
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
