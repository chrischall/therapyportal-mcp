# therapyportal-mcp

MCP server for **TherapyPortal**, the client portal of TherapyNotes
(`https://www.therapyportal.com/p/<practice>/`). It reads upcoming therapy
appointments, paperwork the practice sent, the practice's standing forms,
balances due, payment receipts and secure messages, and downloads completed
documents and receipts as PDFs. It can also send secure messages and upload a
file in answer to a document request, each behind a confirm gate.

> This project was developed and is maintained by AI. Use at your own discretion.
> It reads mental-health records, and only ever from the signed-in user's own account.

## Not read-only

Most tools are reads. Three are writes, and each one reaches the practice and
cannot be undone through this server:

| Tool | What it sends | Look up first with |
|---|---|---|
| `therapyportal_send_message` | a new secure-message conversation, for one client, under a topic | `therapyportal_list_message_topics` |
| `therapyportal_reply_message` | a reply in an existing conversation (leaves read state alone unless `mark_thread_read`) | `therapyportal_list_message_threads` |
| `therapyportal_upload_document` | a local file in answer to a pending document request, or an upload-required always-available form | `therapyportal_list_documents`, `therapyportal_list_forms` |

All three are annotated `destructive` and confirm-gated (see below). The server
signs no form, fills in no form and makes no payment. Anything that needs a
signature (`PatientSignatureRequired`) is refused, with a pointer to the portal.
A download is logged by the practice, the same way the portal logs the click.

On the privacy side, `therapyportal_list_clients` returns names and date of
birth only. The portal's client record also carries the address, phones,
email, an SSN field, billing notes and free-text comments, and none of those
are ever passed through, on any `view`.

## Tools

| Tool | What it returns |
|---|---|
| `therapyportal_list_clients` | the clients linked to this login (for a parent, each child), with the `patientId` other tools take |
| `therapyportal_list_appointments` | upcoming appointments: time, clinician, telehealth or location, which client; pending requests; practice phone. The portal shows **no past visits** |
| `therapyportal_list_documents` | paperwork requests (`pending` / `completed` / `all`) and their documents, with `portalDocumentId` and whether each needs an upload or a signature |
| `therapyportal_list_forms` | the practice's always-available forms (sign or upload as needed), with `libraryDocumentId` |
| `therapyportal_get_document_counts` | per client, documents waiting to be completed or approved |
| `therapyportal_list_balances` | the balance due per client, and whether autopay is on |
| `therapyportal_list_receipts` | payments, with the dates of service each covered, and `paymentId` |
| `therapyportal_list_message_threads` | one client's secure-message conversations (does not mark read) |
| `therapyportal_get_thread_messages` | the messages in one conversation (does not mark read) |
| `therapyportal_download_document` | a completed form (rendered to PDF) or a file the practice uploaded |
| `therapyportal_download_receipt` | a payment receipt PDF |
| `therapyportal_list_message_topics` | the topics a client can message (`topicId`, and whether each reaches clinical, billing or administrative staff), whether messaging is on, and whether the client has an assigned clinician |
| `therapyportal_send_message` | **write.** Start a new conversation (confirm-gated) |
| `therapyportal_reply_message` | **write.** Reply in a conversation (confirm-gated) |
| `therapyportal_upload_document` | **write.** Upload a PDF, JPG, JPEG, PNG, HEIC or DOCX (max 25 MB) for a document that asks for one (confirm-gated) |
| `therapyportal_healthcheck` | connectivity, from whichever transport is live |

Read tools take `view`. The default is `compact` (projected to the useful
fields); `full` and `raw` return more. Text the practice wrote (document
titles, instructions, messages) comes back inside an untrusted-content
envelope.

**Message tools are not verified against real messages.** The account this was
built against had none, so the thread and message reads return the portal's
payload exactly as sent rather than a projection.

## Writes

The three writes are **derived from the portal's own JavaScript**
(`SecureMessagingDataService`, `CreateMessageViewV2`, `ThreadViewV2`,
`DocumentsDataService`, the document view controllers and `xhrfileuploader`)
and are **UNVERIFIED on the wire**: no automated run sends a message or uploads
a file, because each one reaches the practice. An owner-supervised live test
confirms them later. The lookups they make first (messaging settings, topics,
the assigned-clinician check, the document and form lists) were verified live,
read-only.

Before showing a preview, each write checks against live reads: the client is
one of yours (`therapyportal_list_clients`), the practice has secure messaging
turned on, the topic exists for that client, and, for an upload, that the
document or form exists, is not completed, asks for an upload and needs no
signature.

- **Messages.** Plain text, 1 to 5000 characters, sent as the portal's editor
  sends it (one HTML paragraph per line). A practice may refuse new messages
  after several unanswered ones; a refusal says so. Archived conversations
  cannot be replied to.
- **Uploads.** The file must be inside `THERAPYPORTAL_UPLOAD_DIR` (default
  `~/Downloads`, `~/Documents` or `~/Desktop`; `$MCP_DATA_DIR/uploads` when
  hosted), a regular file (no symlinks), and its contents must match its
  extension. Legacy `.doc` is refused (its format cannot be checked before
  upload); save it as PDF or `.docx`. The file is staged in 100 KB segments,
  validated by the portal, and only then submitted. Only the submit reaches the
  practice.
- **Sent once.** A write is posted exactly once. It is never replayed after a
  re-sign-in, on either transport. A send the portal answers with a 5xx, or
  whose connection drops, is reported as `status: "unknown"` rather than as an
  error, so a model checks the matching list before trying again instead of
  sending twice.

## Confirm gate

Every write is gated by `@chrischall/mcp-utils`' `confirmWrite`, through its
`defineWrite` / `registerWrite`. The first call sends nothing and returns a
**preview + a `confirmToken`**; only a second call carrying that token, after
you approve the preview, sends. The exact request (for an upload, the file's
name, type, size and SHA-256) and the shown preview are bound into the token,
so an argument, file or portal state that changed since the preview is refused
as `DRAFT_CHANGED`. Values that change on every send (the upload guid, the
document date) are made at send time and are not bound. Practice-written text
in a preview or a result (topic names, document titles, the returned
conversation) is wrapped as untrusted content. `MCP_CONFIRM_MODE` /
`MCP_CONFIRM_ELICITATION` tune the gate (see Configuration).

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
| `THERAPYPORTAL_UPLOAD_DIR` | where an upload's `file_path` must be (path-delimiter list; `~` expands). Default `~/Downloads`, `~/Documents` and `~/Desktop`; `$MCP_DATA_DIR/uploads` when hosted |
| `MCP_CONFIRM_MODE` | confirm-gate mode for every write. `ask-user` (default) = preview + `confirmToken` round-trip; `auto` lets a capable host confirm in one step; an unrecognised value fails closed (`refuse`) |
| `MCP_CONFIRM_ELICITATION` | `on` (default) lets the host confirm a write interactively; `off` forces the `confirmToken` round-trip |
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

`skills/therapyportal-fpx` does the same reads (not the writes) from a shell with the `fpx` CLI,
through the signed-in tab. See its `SKILL.md`.

## Development

```sh
npm install
npm run build
npm test                 # typecheck + vitest, all mocked
npm run test:coverage    # 100% threshold
```

The wire protocol (tokens, sign-in, download jobs, the write shapes) is in
[`docs/THERAPYPORTAL-API.md`](docs/THERAPYPORTAL-API.md).
