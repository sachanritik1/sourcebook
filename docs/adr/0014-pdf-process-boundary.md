# 0014: Bound PDF parsing outside the worker process

## Decision

The document worker starts a fresh Node child process for each PDF extraction and sends the private bytes over stdin. Only extracted text returns over stdout. The child receives no application environment variables or provider/database credentials. It enforces the existing 5 MB input and 2 million character output limits. The parent caps stdout to 8 MB, waits at most `PDF_EXTRACTION_TIMEOUT_MS` (30 seconds by default), and kills the child on timeout or excess output. Node's child heap is limited to 128 MB. Plain UTF-8 text keeps the direct extraction path.

The existing BullMQ failure path handles parse errors and timeouts: bounded retries, a failed job, and a dead-letter record after the retry budget. A manual retry starts a new event. The worker can continue processing other documents after a child exits or is killed. The integration tests exercise a real PDF, a timeout, and a malformed PDF followed by a successful one.

## Trade-offs and limits

A process costs more startup time than a worker thread, but it gives parser crashes and a blocked parser a separate process boundary. The 128 MB flag limits V8's old heap, not total resident memory or CPU. The child runs with the same OS user and can still access the filesystem and network; removing secrets from its environment is defense in depth, not a security sandbox. Production handling of hostile PDFs needs a container or OS sandbox with hard memory, CPU, filesystem, and network restrictions. Each worker can run up to four jobs concurrently, so capacity planning must include up to four PDF children per worker.

The child entry point is compiled with the API and worker. Integration tests build first so they exercise the same JavaScript artifact that Docker runs. PDF bytes are sent over stdin, not command arguments; parser error messages are truncated before logging.
