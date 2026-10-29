# TherapyPortal API (as used by therapyportal-mcp)

TherapyPortal is the client portal of TherapyNotes (`www.therapyportal.com/p/<practice>/`).
There is no public API; everything here was read from the portal's shipped JS bundles
(`/static/javascript/...`, served without a session) and confirmed against the page's
real requests and a live account on 2026-10-29 (site version `2026.8.9.49928.241710`).

## Sign-in (server transport) — verified live

1. `GET /p/<code>/login/` — sets `ASP.NET_SessionId`, `access-token` and others; the page
   carries `siteVersion = "…"` and `"PracticeID":<n>` (no TNRAC yet).
2. `POST /portal/practice/login/processlogin.aspx?msg=1`, form-encoded:
   `email`, `password` = **uppercase hex SHA-512 of the NFC-normalised password**
   (`TN.Common.Security.PasswordHasher`), `doCookieCheck=false`, plus `correlationid`,
   `tnv`, `portalpractice`. Answer: `{ IsSuccessful, ErrorMessage, NeedsDobAuthentication,
   IsExpiredToken, UserID, RecommendedRedirect, … }`. A wrong password is
   `{"IsSuccessful":false,"ErrorMessage":"The email and password you entered did not match any account. Please try again."}`.
3. When `NeedsDobAuthentication`: the same endpoint again with `dob=MM/DD/YYYY`,
   `authenticationAttempt=0`, `isExpiredToken=<from step 2>` (`dobauthenticationviewer.js`).
   The UI disables the field after a few wrong dates, so the server tries once. Verified
   live: the owner's account takes this step on every server-side sign-in.
4. `GET /p/<code>/` — the signed-in practice page, carrying the data-call tokens below.

Signed-out signals: the practice page has **no** `<input id="TNRAC">` and its
`userInfo` has an empty `Email` and no `ID` (the anonymous page is otherwise similar —
it is the public dashboard); a data call is answered **401** with an `Error | TherapyPortal` page.

## Request shape

Every data call is:

```
POST https://www.therapyportal.com/portal/practice/<area>/<verb>.aspx?msg=<n>
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

<fields>&correlationid=<uuid4>&tnrac=<TNRAC>&tnv=<siteVersion>&portalpractice=<PracticeID>
```

The page's AJAX layer appends the last four fields to every request, in lowercase:

- `tnrac`: anti-forgery token, the value of the practice page's `<input id="TNRAC">`.
- `tnv`: `siteVersion = "…"` from the page. A stale value gets HTTP 409 (the version-warning path).
- `portalpractice`: the **numeric** `userInfo.PracticeID` from the page, NOT the URL slug.
  Without it, every endpoint answers **404 with the HTML "Page Not Found" page**, which
  looks exactly like a wrong path.
- `correlationid`: any uuid4.

The helper fetches `GET /p/<code>/` once per invocation and reads all three values from it.
A page with no `TNRAC`, or no `PracticeID`, means signed out.

JSON-object arguments go in ONE form field as a JSON string (often `request=`, sometimes
`Request=` or `json=`; the name matters).

## Endpoints (verified live unless marked)

| path | fields | notes |
|---|---|---|
| `getdashboardinfoforportaluser` | `request=1` | per client: names + `PatientStatisticsDocumentCounts` |
| `getportaldocumentstatisticsforportaluser` | — | pending-completion / pending-approval counts per client |
| `document/getpatientsforportaluser` | — | full demographic records. **Sensitive, always project** |
| `appointments/appointmentinformation` | `json={"searchAllAppointmentsForTheDay":false,"usersCurrentTimeInUtc":"<ISO Z>"}` | `Appointments[]` (future only), `AppointmentRequests[]`, practice name and phone |
| `documents/api/getportaluserdocumentrequestsbystatus` | `Request=[1,4,5]` | statuses: PortalDocRequestStatus `1` Pending, `4` InProgress, `5` Completed (`0` Deleted, `2` Canceled, `3` Expired). Each request has `PortalDocuments[]`, whose `PortalDocumentStatus` is `1` Pending, `2` InProgress, `3` Completed |
| `documents/api/getalwaysavailabledocumentsforportaluser` | — | standing forms |
| `billing/payments/getbalancesdueforportaluser` | — | `AmountToPatient` per client |
| `billing/payments/getreceiptsforportaluser` | — | `PaymentId`, amounts, `TransactionData[]` |
| `messages/getthreads` | `patientselection=null&readstatus=2&audiences=0,1,2&topicid=-1&patientid=<id>&newestfirst=true&recordnumber=0&recordstoretrieve=200&addresseetype=` | the exact body the UI sends for "All Conversations". `null` when there are no threads. Thread shape **not yet seen** (the test account had none); `readstatus` values other than `2` are unverified |
| `messages/getmessages` | `threadid=<id>` | **unverified** (no threads to test). Reading is separate from `markthreadasread`, which the helper never calls |
| `messages/getusercounts` | — | `null` with no messages |

## Downloads (job-based)

1. Create a job, which returns `{"JobId":n}`:
   - completed form: `document/createportalformdownloadrequest`, with
     `request={"PortalFormId":<PortalDocumentId>,"PatientId":<id>,"PatientDocumentType":<type>}`
     (captured from the document page's "Download Document" button; `PortalFormId` IS
     the `PortalDocumentId`). `document/downloadcompleteddocument` with
     `{"Id":<PortalDocumentId>}` returns HTTP 500 for these forms.
   - receipt: `billing/payments/createreceiptdownloadrequest` with `PaymentId=<id>`.
2. Poll `document/getdocumentdownloadstatus` with `request={"Id":<JobId>}` until it returns
   `{"ProgressPercentage":100,"EncryptedJobID":"…"}`. This usually takes a few seconds; the UI polls every 5 s.
3. `fpx download https://www.therapyportal.com/p/<code-lowercase>/document/download/<EncryptedJobID>/`
   returns a PDF.

Both download paths were verified with real PDFs (a form of about 68 KB, a receipt of about 41 KB).
`PatientDocumentType` `0` is a file the PRACTICE uploaded (e.g. a PDF sent for review). It
has no job: the document page links it directly, and
`fpx download https://www.therapyportal.com/p/<code>/documents/files/download/<PortalDocumentId>/`
returns the file (verified, a 134 KB PDF). Other types are unverified.

## Writes (wrapped by the server, confirm-gated) — UNVERIFIED on the wire

Derived 2026-10-29 from the portal's public JS (site version `2026.8.9.49928.241710`),
modules under `/static/javascript/tsbin/`: `Projects/SecureMessages/Services/SecureMessagingDataService.js`,
`Projects/SecureMessages/Views/Inbox/CreateMessageViewV2.js`, `.../ThreadViewV2.js`,
`Services/Portal/DocumentsDataService.js`, `Controllers/Portal/DocumentViewController.js`,
`Controllers/Portal/AlwaysAvailableDocumentViewController.js`, and
`/static/javascript/common/files/xhrfileuploader.js`. **No write has been sent live**; the
three lookups marked "verified live" were called live, read-only. The fpx helper wraps none
of these.

Every write data call is the normal request shape above (four page fields appended). An
object argument is ONE form field holding a JSON string; the field name and its case matter.
The server posts each write exactly once (`transport.send`) and never replays it after a
re-sign-in.

### Enums

- AudienceType: `0` Administrative, `1` Billing, `2` Clinical
- AddresseeType: `0` Patient (the only one a portal user uses), `1` Internal
- MessageType: `0` Message
- PatientFileReferenceType: `0` None, `1` PortalDocument, `2` InsurancePolicy,
  `3` FormUploadedInsurancePolicy, `4` LibraryDocument, `5` HipaaNppForm
- FormAdviceType: `0` Information, `1` Confirmation, `2` Warning, `3` Error, `4` Highlight.
  A FormAdvice is `{ Id, Type, Message, Fields: [] }`; the document write endpoints answer
  `{ "FormAdvice": FormAdvice[] }`, and any Type `3` means rejected.

### Lookups the writes read first

| path | fields | answer |
|---|---|---|
| `messages/getsettings` | `forceFromService=false` | **verified live.** `{ PracticeSettings: { SecureMessagingEnabled, PortalMessage, ShowPortalAdminMessage, PortalAdminMessageEnglish, ShowPortalBillingMessage, PortalBillingMessageEnglish, … }, Topics }` |
| `messages/gettopicsforaudiences` | `audiences=0,1,2&patientId=<id>&ignoreUserPermissions=` | **verified live.** `Topic[]` = `{ Id, PracticeId, Audience, Description, DateCreated, DateModified, Status, SortOrder }`. `Description` is practice-written |
| `messages/checkifpatienthasassignedclinician` | `patientid=<id>` | **verified live.** A bare JSON boolean. False means a Clinical message may not reach a clinician |

### New conversation: `messages/createnewthread`

Field `ThreadRequest` = JSON:

```
{ InternalAddressees: [], MessagePreview: <plain text, first 500 chars>, MessageBody: <HTML>,
  MessageBodyCount: <plain-text length>, AddresseeType: 0,
  TopicId: <Topic.Id>, Audience: <Topic.Audience>, PatientId: <patientId>, Subject: <string> }
```

The UI requires a subject (pre-filled with the topic's `Description`), a topic, and a body
of 1 to 5000 characters. The body HTML is the editor's: each line HTML-escaped in its own
`<p>…</p>`, an empty line as `<p><br></p>`. Success answers the created thread as JSON;
anything else is a failure. A practice may throttle: the UI's failure text is "You have
sent too many messages to the practice since the practice responded".

### Reply: `messages/respondtothread`

Fields: `MessageRequest` = JSON `{ MessagePreview, MessageBody, MessageBodyCount, MessageType: 0, MarkThreadRead: <bool> }`,
`ThreadId=<id>`, `PatientId=<id>`. The server sends `MarkThreadRead: false` unless told
otherwise (the read tools never mark anything read). Success answers the created message as
JSON. An archived thread cannot be replied to (the UI says to start a new conversation). The
thread shape is still unseen, so the server checks no thread fields and surfaces the
portal's failure.

### Upload a file for a document

Three steps; only the last reaches the practice.

1. **Stage the bytes**: `POST https://www.therapyportal.com/app/common/files/FileSegmentReceiver.ashx`.
   Not a data call: no form fields, no `tnrac`/`tnv`/`portalpractice`, cookies only. The
   client makes a uuid4 `guid` per file and splits the bytes into 102 400-byte segments.
   Segment `i` is sent with headers `X-Upload-Guid`, `X-Upload-Segment: <i>`,
   `X-Upload-Segment-Size: 102400`, `X-Upload-Segment-Is-Final: <true iff last>`,
   `X-Upload-File-Name: <encodeURIComponent(name)>`, `X-Upload-File-Size: <total>`,
   `X-Upload-File-Mime-Type`, and a body that is the segment's base64 (text, no data-URL
   prefix). The name has `|<>"` stripped first. Success is HTTP 200 with a body that does
   not contain `Error` (an error body is `{ "Error": "<message>" }`). The portal retries a
   non-200 segment up to 3 times and never an `Error` body; the server does the same, and
   sends segments in order. The portal's own client refuses an empty file, an extension
   longer than 16 characters, and Google Drive shortcuts (`.gdoc` etc.).
2. **Validate**: `document/stageduploadvalidation`, field `request` = JSON
   - pending request document: `{ FileUploadGuid, ReferenceId: <PortalDocumentId>, ReferenceType: 1 }`
   - always-available library document: `{ FileUploadGuid, ReferenceId: <LibraryDocumentId>, ReferenceVersionId: <LibraryDocumentVersionId>, ReferenceType: 4 }`

   Answers `{ FormAdvice }`; a Type 3 stops here (the staged temp file is orphaned).
3. **Submit**. `SavePatientFileRequest` = `{ ReferenceId, ReferenceVersionId, ReferenceType, PatientId, FileSize, FileName, MimeType, DocumentDate: <ISO now>, Guid }`.
   - pending request document (in `getportaluserdocumentrequestsbystatus`, `IsUploadRequired`
     true, not completed): `document/uploadportalresponse`, field `request` = that object with
     `ReferenceType: 1, ReferenceId: <PortalDocumentId>, ReferenceVersionId: null, PatientId: <the document's PatientId>`.
   - always-available library document (an item of `getalwaysavailabledocumentsforportaluser`
     with `PatientDocumentType` 2 and `IsUploadRequired` true; `LibraryDocumentId` is its
     `PatientDocumentKey`, `LibraryDocumentVersionId` its `RevisionId`):
     `document/submitalwaysavailablelibrarydocumentupload`, field `request` =
     `{ PatientId, LibraryDocumentId, LibraryDocumentVersionId, UploadedResponse: <SavePatientFileRequest with ReferenceType: 1, ReferenceId: null, ReferenceVersionId: null> }`.
     (The submit uses ReferenceType 1 where validation used 4. That is copied from the
     portal's code.)

   Answers `{ FormAdvice }`; Type 3 is a rejection, otherwise success.

### Not wrapped, on purpose

- anything needing a signature (`PatientSignatureRequired` true is refused):
  `uploadportalresponseandsignature`, `submitalwaysavailableuploadsignaturerequireddocument`,
  `savecapturedsignatureforportaluser`
- form filling: `document/save*form`, `submitalwaysavailable*form`
- `messages/markthreadasread` (a reply can mark read only through its own `MarkThreadRead`)
- payments: `billing/payments/saveportalpayment` — never
