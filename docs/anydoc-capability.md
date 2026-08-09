# AnyDoc document-ingestion capability

AnyDoc is auto-installed BB infrastructure for agents. It adds no generated UI and does not replace BB file listing, attachments, document storage, memory, or operational state.

## Flow

1. An agent locates a supported file through BB's existing host/workspace file capabilities.
2. `anydoc_ingest_document` reads it from the requesting thread's actual host or from BB's existing project-attachment byte surface. Workspace scope is root-confined by the host daemon; host scope requires an explicit absolute path; attachment scope reuses already-uploaded bytes.
3. Firecrawl AnyDoc converts the bytes locally to clean GitHub-Flavored Markdown. No document content leaves BB for conversion.
4. BB stores the Markdown, outline, source SHA-256, Markdown SHA-256, source path/host/root, MIME type, size, modification time, and ingestion time in the plugin's private SQLite database.
5. The result returns a content-addressed `anydoc:sha256:<source hash>` evidence reference and a bounded Markdown chunk. Larger results are paged through `anydoc_read_document`.
6. Entity, workstream, and goal associations can be supplied during ingestion or merged later with `anydoc_associate_evidence`.
7. Agents cite the evidence reference when updating canonical memory, opportunities, decisions, external-action proposals, and outcome evaluations in the shared operating loop.

Repeated ingestion of identical bytes reuses the same document identity, merges provenance locations and associations, and does not duplicate the content.

## Supported inputs

Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF formats supported by AnyDoc. Encrypted, malformed, unsupported, image-only PDF, and resource-limit failures are surfaced explicitly; OCR remains a future capability adapter rather than hidden fallback behavior.

## Runtime and safety

The converter runs locally through AnyDoc's portable WASM package. BB's backend plugin builder emits imported WASM under `dist/server-assets`, producing a self-contained cross-platform builtin without native Node addons or runtime `node_modules`. Source documents are capped at 20 MiB and tool responses at 80,000 characters per chunk.
