# 0011: Browser uploads and job progress

## Decision

The web app relays each selected PDF or text file through a Next.js Route Handler to the existing Express upload endpoint. The browser generates one UUID `Idempotency-Key` per selected file and keeps the file and key together while it is on the page. If the upload response is lost, retrying that draft sends the same file and key; the API returns the original document and job IDs. Multiple selected files are sent one at a time, each creating its own job. Express still checks membership, validates file content, and commits the document, job, outbox event, and key record together.

The web handler bounds multipart input before parsing it: 5 MB of file data plus 64 KB of envelope overhead. It accepts exactly one nonempty `file` field and forwards the file with the unchanged key. Express remains the final validator. The web server creates an `X-Request-ID` for each API call; Express uses it in logs and the outbox payload. No document bytes or tokens are cached or logged by the web app.

The workspace view reads document and job lists from Express. It polls every three seconds only while a job is queued or processing and the tab is visible. Failed jobs expose the existing manual retry endpoint, which resets the PostgreSQL job and creates a **new event ID**. API membership checks cover document lists, job lists, and retry. A cross-origin browser write is rejected before forwarding.

## Trade-offs and failure cases

Relaying a file is simple for the 5 MB local limit; it uses web-server memory and an extra network hop. Larger files should move to private object storage with signed upload URLs and an API finalization step. If a tab closes after the API commits but before the browser sees the response, its in-memory file/key pair is lost. The user should check the document list before selecting the file again; a newly selected file gets a new key and is a separate upload. Keeping file bytes in durable browser storage is intentionally deferred. Polling is easy to reason about at this scale; push updates can be considered when active-job counts justify persistent connections.
