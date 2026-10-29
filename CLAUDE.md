# CLAUDE.md — therapyportal-mcp

Read-only MCP for TherapyPortal (the TherapyNotes client portal). Two transports:
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
- Logs go to stderr only (stdout is JSON-RPC).
