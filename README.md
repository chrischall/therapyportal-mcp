# therapyportal-mcp

MCP server for **TherapyPortal**, the client portal of TherapyNotes
(`https://www.therapyportal.com/p/<practice>/`). It reads upcoming therapy
appointments, paperwork the practice sent, the practice's standing forms,
balances due, payment receipts and secure messages, and downloads completed
documents and receipts as PDFs.

> This project was developed and is maintained by AI. Use at your own discretion.
> It reads mental-health records, and only ever from the signed-in user's own account.

## Read-only

Every tool is a read. It sends no message, signs no form, uploads nothing and
makes no payment. A download is logged by the practice, the same way the
portal logs the click.

On the privacy side, `therapyportal_list_clients` returns names and date of
birth only. The portal's client record also carries the address, phones,
email, an SSN field, billing notes and free-text comments, and none of those
are ever passed through, on any `view`.

## Tools

| Tool | What it returns |
|---|---|
| `therapyportal_list_clients` | the clients linked to this login (for a parent, each child), with the `patientId` other tools take |
| `therapyportal_list_appointments` | upcoming appointments: time, clinician, telehealth or location, which client; pending requests; practice phone. The portal shows **no past visits** |
| `therapyportal_list_documents` | paperwork requests (`pending` / `completed` / `all`) and their documents, with `portalDocumentId` |
| `therapyportal_list_forms` | the practice's always-available forms (sign or upload as needed) |
| `therapyportal_get_document_counts` | per client, documents waiting to be completed or approved |
| `therapyportal_list_balances` | the balance due per client, and whether autopay is on |
| `therapyportal_list_receipts` | payments, with the dates of service each covered, and `paymentId` |
| `therapyportal_list_message_threads` | one client's secure-message conversations (does not mark read) |
| `therapyportal_get_thread_messages` | the messages in one conversation (does not mark read) |
| `therapyportal_download_document` | a completed form (rendered to PDF) or a file the practice uploaded |
| `therapyportal_download_receipt` | a payment receipt PDF |
| `therapyportal_healthcheck` | connectivity, from whichever transport is live |

Read tools take `view`. The default is `compact` (projected to the useful
fields); `full` and `raw` return more. Text the practice wrote (document
titles, instructions, messages) comes back inside an untrusted-content
envelope.

**Message tools are not verified against real messages.** The account this was
built against had none, so these two return the portal's payload exactly as
sent rather than a projection.

## Transports

| | Server (default when credentials are set) | Browser bridge |
|---|---|---|
| How | signs in itself with your email and password; holds a cookie jar in memory | relays every request through your signed-in Chrome tab via the ContextMint Bridge extension |
| Needs | `THERAPYPORTAL_EMAIL`, `THERAPYPORTAL_PASSWORD` (and `THERAPYPORTAL_DOB` if the portal asks) | the extension, and a signed-in portal tab |
| Hostable (claude.ai, phone) | yes | only as a bridged registration |
| Downloads | written to `THERAPYPORTAL_OUTPUT_DIR`, or inline | saved by the browser to its download folder |

The two can run side by side. A server-side sign-in does **not** end your
browser's portal session (checked live), and the portal signs out an idle
browser tab on its own after a while; that is the usual reason the bridge
reports "not signed in".

A rejected password or date of birth is **never retried**. The date-of-birth
check locks after a few wrong dates, so the server tries it once.

## Configuration

| Variable | |
|---|---|
| `THERAPYPORTAL_PRACTICE` | **required.** The code after `/p/` in your portal URL (a full URL also works) |
| `THERAPYPORTAL_EMAIL` | the email you sign in with |
| `THERAPYPORTAL_PASSWORD` | your portal password |
| `THERAPYPORTAL_DOB` | only if the portal asks for a date of birth at sign-in: `MM/DD/YYYY` (`M/D/YYYY` and `YYYY-MM-DD` are accepted) |
| `THERAPYPORTAL_TRANSPORT` | `server` or `fetchproxy`. Default: `server` when email and password are set |
| `THERAPYPORTAL_WS_PORT` | fetchproxy concentrator port, default `37149` (shared by the whole fleet) |
| `THERAPYPORTAL_OUTPUT_DIR` | where downloads are written (path-delimiter list; `~` expands). Default `~/Downloads` and `~/Documents`; a per-call `dest` must be inside one |
| `THERAPYPORTAL_INLINE_DOWNLOADS` | `true` returns downloads inline (base64), for a hosted runner |
| `FETCHPROXY_WS_HOST`, `FETCHPROXY_IDENTITY_DIR` | fetchproxy bind address and identity directory (advanced) |

Copy `.env.example` to `.env` for a local install.

```json
{
  "mcpServers": {
    "therapyportal": {
      "command": "npx",
      "args": ["-y", "@chrischall/therapyportal-mcp"],
      "env": { "THERAPYPORTAL_PRACTICE": "<code>" }
    }
  }
}
```

## Without the server

`skills/therapyportal-fpx` does the same reads from a shell with the `fpx` CLI,
through the signed-in tab. See its `SKILL.md`.

## Development

```sh
npm install
npm run build
npm test                 # typecheck + vitest, all mocked
npm run test:coverage    # 100% threshold
```

The wire protocol (tokens, sign-in, download jobs) is in
[`docs/THERAPYPORTAL-API.md`](docs/THERAPYPORTAL-API.md).
