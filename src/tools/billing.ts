import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TherapyPortalClient } from '../client.js';
import { READ, asRecordArray, firstText, tidy } from './_shared.js';
import { viewArg, viewResponse } from '../view.js';

export function registerBillingTools(server: McpServer, client: TherapyPortalClient): void {
  server.registerTool(
    'therapyportal_list_balances',
    {
      description:
        'Show what is owed to the therapy practice in TherapyPortal: the balance due for each ' +
        'client, and whether autopay is on. Changes nothing — this server cannot make a payment.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.balances();
      return viewResponse(view, raw, (data) => {
        if (!Array.isArray(data)) return undefined;
        return asRecordArray(data).map((b) =>
          tidy({
            patientId: b.PatientId,
            client: firstText(b.PreferredName, b.FirstName),
            balanceDue: b.AmountToPatient,
            autoPay: b.AutoPayEnabled,
          }),
        );
      });
    },
  );

  server.registerTool(
    'therapyportal_list_receipts',
    {
      description:
        'List payments made to the therapy practice in TherapyPortal, each with its date, amount, ' +
        'card last four, and the dates of service it paid for. Returns the payment_id ' +
        'therapyportal_download_receipt takes — e.g. for an insurance or HSA/FSA claim.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.receipts();
      return viewResponse(view, raw, (data) => {
        if (!Array.isArray(data)) return undefined;
        return asRecordArray(data).map((r) =>
          tidy({
            paymentId: r.PaymentId,
            patientId: r.PatientId,
            client: r.PatientPreferredName,
            date: r.PaymentDate,
            amount: r.PaymentAmount,
            allocated: r.TotalAmountAllocated,
            cardLast4: r.CreditCardNumberLast4,
            services: asRecordArray(r.TransactionData).map((t) =>
              tidy({ dateOfService: t.DateOfService, paid: t.AmountPaid, description: t.TransactionDescription }),
            ),
          }),
        );
      });
    },
  );
}
