# CLAUDE.md — therapyportal-mcp

MCP for TherapyPortal (the TherapyNotes client portal): reads and downloads, plus three
confirm-gated writes (send a message, reply, upload a file for a document). Two transports:
a server-side sign-in (`src/transport-server.ts`, the default when an email and
password are set) and the fetchproxy browser bridge (`src/transport-fetchproxy.ts`).

## Things that are true of this repo

- **Every data call needs `portalpractice` = the NUMERIC `PracticeID`**, not the URL's
  practice code. Without it the portal answers 404 "Page Not Found", which looks exactly
  like a wrong path. `tnrac` and `tnv` ride along too; `src/transport.ts` explains.
- **The anonymous practice page looks almost like the signed-in one.** Signed in means a
  `TNRAC` input AND a `userInfo` with an `"ID"`; `parsePageTokens` checks both.
- **Never retry a sign-in.** A rejected password or DOB is a `PermanentTransportError`,
  cached by the session manager. The DOB check locks after a few wrong dates.
- **The client record is sensitive.** `document/getpatientsforportaluser` returns the full
  demographic file (address, SSN field, notes). Tools project an allowlist on every rung.
- **Fixtures are synthetic.** Nothing captured from the owner's account goes into
  `tests/` — `git grep` any real value before committing.
- **Message thread shapes are unverified** (the owner's inbox was empty), so the message
  tools pass the payload through. Project them once a real thread has been seen.
- **Writes go through `transport.send`, never `call`.** `call` is the read path and may
  replay (fetchproxy re-reads TNRAC and retries a 401; the server transport's
  `withSession` re-signs-in and replays). `send` posts once: fetchproxy re-reads the page
  first, the server uses `ensure()` and on a signed-out answer `invalidate()`s and returns it.
- **The write shapes are unverified on the wire** (derived from the portal JS; no send was
  ever made). The settings/topics/assigned-clinician lookups were verified live.
- **Uploads are three calls:** segments to `/app/common/files/FileSegmentReceiver.ashx`
  (`transport.uploadSegment`, cookies only, no page fields), then
  `document/stageduploadvalidation`, then the submit. Only the submit uses `sendOnce`. The
  guid and `DocumentDate` are minted in `execute`; the gate binds the file's SHA-256.
- **Nothing that needs a signature.** `PatientSignatureRequired` is refused; signature
  endpoints, form filling and payments are deliberately not implemented.
- **`.doc` is refused**: mcp-utils' magic-byte check cannot verify OLE2, and `vetUploadFile`
  fails closed. `.docx` is vetted as `application/zip` and sent with its Office MIME type.
- **A result payload key named `note` collides with the untrusted envelope** (the payload gets
  nested under `data`). Use another key.
- Logs go to stderr only (stdout is JSON-RPC).
