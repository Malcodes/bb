import { createHash } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { initSync, toMarkdownBytes } from "@firecrawl/anydoc-wasm";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_CHUNK_CHARS = 40_000;
const MAX_CHUNK_CHARS = 80_000;
let anydocInitialized = false;
let anydocInitialization: Promise<void> | null = null;
async function ensureAnyDocInitialized(): Promise<void> {
  if (anydocInitialized) return;
  anydocInitialization ??= (async () => {
    let filePath: string;
    if (import.meta.url.includes("/dist/server.js")) {
      // Dynamic so source-mode tsx never tries to execute a .wasm import;
      // esbuild still sees and emits it for packaged backend bundles.
      const { default: wasmUrl } =
        await import("@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm?url");
      filePath = fileURLToPath(new URL(wasmUrl, import.meta.url));
    } else {
      filePath = createRequire(import.meta.url).resolve(
        "@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm",
      );
    }
    initSync({ module: readFileSync(filePath) });
    anydocInitialized = true;
  })();
  await anydocInitialization;
}

const SUPPORTED_EXTENSIONS = new Set([
  "doc",
  "docx",
  "docm",
  "ppt",
  "pps",
  "pot",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "csv",
  "pdf",
]);

export interface AnyDocAssociation {
  entityRefs: string[];
  workstreamRefs: string[];
  goalIds: string[];
}

export interface AnyDocProvenance {
  kind: "host-file" | "project-attachment";
  path: string;
  hostId?: string;
  projectId?: string;
  rootPath?: string;
  sourceSha256: string;
  sizeBytes: number;
  mimeType?: string;
  modifiedAtMs?: number;
  observedAt: string;
}

export interface AnyDocRecord {
  id: string;
  evidenceRef: string;
  title: string;
  format: string;
  markdown: string;
  markdownSha256: string;
  outline: Array<{ level: number; title: string }>;
  provenance: AnyDocProvenance[];
  associations: AnyDocAssociation;
  ingestedAt: string;
  updatedAt: string;
}

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeAssociations(
  left: AnyDocAssociation,
  right: AnyDocAssociation,
): AnyDocAssociation {
  return {
    entityRefs: uniq([...left.entityRefs, ...right.entityRefs]),
    workstreamRefs: uniq([...left.workstreamRefs, ...right.workstreamRefs]),
    goalIds: uniq([...left.goalIds, ...right.goalIds]),
  };
}

function outline(markdown: string): AnyDocRecord["outline"] {
  return markdown
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      return match
        ? [{ level: match[1]!.length, title: match[2]!.slice(0, 300) }]
        : [];
    })
    .slice(0, 200);
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function portableBasename(name: string): string {
  return name.replace(/\\/g, "/").split("/").at(-1) ?? name;
}

function formatFromName(name: string): string {
  return path.extname(portableBasename(name)).slice(1).toLowerCase();
}

export async function convertAnyDocBytes(input: {
  bytes: Uint8Array;
  sourceName: string;
  sourceSha256?: string;
  title?: string;
  provenance: AnyDocProvenance;
  associations?: Partial<AnyDocAssociation>;
  now?: Date;
}): Promise<AnyDocRecord> {
  if (input.bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `Document exceeds AnyDoc's ${MAX_SOURCE_BYTES} byte ingestion limit`,
    );
  }
  const format = formatFromName(input.sourceName);
  if (!SUPPORTED_EXTENSIONS.has(format)) {
    throw new Error(
      `Unsupported AnyDoc format ${JSON.stringify(format || "unknown")}`,
    );
  }
  await ensureAnyDocInitialized();
  const sourceSha256 =
    input.sourceSha256 ??
    createHash("sha256").update(input.bytes).digest("hex");
  const markdown = cleanMarkdown(toMarkdownBytes(input.bytes, format as never));
  if (!markdown) throw new Error("AnyDoc produced no meaningful Markdown");
  const now = (input.now ?? new Date()).toISOString();
  const associations: AnyDocAssociation = {
    entityRefs: uniq(input.associations?.entityRefs ?? []),
    workstreamRefs: uniq(input.associations?.workstreamRefs ?? []),
    goalIds: uniq(input.associations?.goalIds ?? []),
  };
  return {
    id: `doc_${sourceSha256.slice(0, 24)}`,
    evidenceRef: `anydoc:sha256:${sourceSha256}`,
    title:
      input.title?.trim() ||
      path.basename(
        portableBasename(input.sourceName),
        path.extname(portableBasename(input.sourceName)),
      ),
    format,
    markdown,
    markdownSha256: createHash("sha256").update(markdown).digest("hex"),
    outline: outline(markdown),
    provenance: [{ ...input.provenance, sourceSha256 }],
    associations,
    ingestedAt: now,
    updatedAt: now,
  };
}

function migrate(bb: BbPluginApi, db: Db): void {
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS anydoc_documents (
      id TEXT PRIMARY KEY,
      evidence_ref TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      markdown TEXT NOT NULL,
      markdown_sha256 TEXT NOT NULL,
      outline_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      associations_json TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ]);
}

function rowToRecord(row: Record<string, unknown>): AnyDocRecord {
  return {
    id: String(row.id),
    evidenceRef: String(row.evidence_ref),
    title: String(row.title),
    format: String(row.format),
    markdown: String(row.markdown),
    markdownSha256: String(row.markdown_sha256),
    outline: JSON.parse(String(row.outline_json)),
    provenance: JSON.parse(String(row.provenance_json)),
    associations: JSON.parse(String(row.associations_json)),
    ingestedAt: String(row.ingested_at),
    updatedAt: String(row.updated_at),
  };
}

function getRecord(db: Db, id: string): AnyDocRecord | null {
  const row = db
    .prepare("SELECT * FROM anydoc_documents WHERE id = ? OR evidence_ref = ?")
    .get(id, id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

function saveRecord(db: Db, record: AnyDocRecord): AnyDocRecord {
  const existing = getRecord(db, record.id);
  if (existing) {
    record.provenance = [
      ...existing.provenance,
      ...record.provenance.filter(
        (candidate) =>
          !existing.provenance.some(
            (current) =>
              current.path === candidate.path &&
              current.hostId === candidate.hostId &&
              current.sourceSha256 === candidate.sourceSha256,
          ),
      ),
    ];
    record.associations = mergeAssociations(
      existing.associations,
      record.associations,
    );
    record.ingestedAt = existing.ingestedAt;
  }
  db.prepare(
    `INSERT INTO anydoc_documents (
      id, evidence_ref, title, format, markdown, markdown_sha256,
      outline_json, provenance_json, associations_json, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      markdown = excluded.markdown,
      markdown_sha256 = excluded.markdown_sha256,
      outline_json = excluded.outline_json,
      provenance_json = excluded.provenance_json,
      associations_json = excluded.associations_json,
      updated_at = excluded.updated_at`,
  ).run(
    record.id,
    record.evidenceRef,
    record.title,
    record.format,
    record.markdown,
    record.markdownSha256,
    JSON.stringify(record.outline),
    JSON.stringify(record.provenance),
    JSON.stringify(record.associations),
    record.ingestedAt,
    record.updatedAt,
  );
  return record;
}

function publicRecord(
  record: AnyDocRecord,
  offset = 0,
  maxChars = DEFAULT_CHUNK_CHARS,
) {
  const boundedOffset = Math.max(0, Math.min(offset, record.markdown.length));
  const markdown = record.markdown.slice(
    boundedOffset,
    boundedOffset + maxChars,
  );
  const nextOffset =
    boundedOffset + markdown.length < record.markdown.length
      ? boundedOffset + markdown.length
      : null;
  return {
    id: record.id,
    evidenceRef: record.evidenceRef,
    title: record.title,
    format: record.format,
    markdown,
    markdownLength: record.markdown.length,
    offset: boundedOffset,
    nextOffset,
    markdownSha256: record.markdownSha256,
    outline: record.outline,
    provenance: record.provenance,
    associations: record.associations,
    ingestedAt: record.ingestedAt,
    updatedAt: record.updatedAt,
  };
}

function joinHostPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/^[\\/]+/, "")}`;
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

const associationSchema = z
  .object({
    entityRefs: z.array(z.string().min(1)).max(100).default([]),
    workstreamRefs: z.array(z.string().min(1)).max(100).default([]),
    goalIds: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict();

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  migrate(bb, db);

  bb.agents.registerTool({
    name: "anydoc_ingest_document",
    description:
      "Convert a supported office document into clean Markdown with durable provenance and an evidence reference. Use BB's existing file path/attachment access to identify the source; this tool adds document parsing rather than duplicating file browsing.",
    instructions:
      "Use for workspace/host files or project attachments in DOC/DOCX/DOCM, PPT/PPTX/PPTM/PPS/PPSX/PPSM/POT, XLS/XLSX/XLSM/XLSB, ODT/ODS/ODP, RTF, EPUB, CSV, and text-based PDF. The result's evidenceRef is the canonical citation for entity facts, opportunities, workstreams, and goal evaluations. Continue with anydoc_read_document when nextOffset is present.",
    parameters: z
      .object({
        path: z.string().min(1),
        scope: z.enum(["workspace", "host", "attachment"]).default("workspace"),
        hostId: z.string().min(1).optional(),
        title: z.string().max(300).optional(),
        associations: associationSchema.default({
          entityRefs: [],
          workstreamRefs: [],
          goalIds: [],
        }),
        maxChars: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_CHUNK_CHARS)
          .default(DEFAULT_CHUNK_CHARS),
      })
      .strict(),
    async execute(input, context) {
      const observedAt = new Date().toISOString();
      let bytes: Uint8Array;
      let sourceSha256: string;
      let provenance: AnyDocProvenance;

      if (input.scope === "attachment") {
        const attachment = await bb.sdk.projects.attachments.read({
          projectId: context.projectId,
          path: input.path,
          signal: context.signal,
        });
        if (attachment.sizeBytes > MAX_SOURCE_BYTES) {
          throw new Error(
            `Document exceeds AnyDoc's ${MAX_SOURCE_BYTES} byte ingestion limit`,
          );
        }
        bytes = attachment.bytes;
        sourceSha256 = createHash("sha256").update(bytes).digest("hex");
        provenance = {
          kind: "project-attachment",
          path: input.path,
          projectId: context.projectId,
          sourceSha256,
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
          observedAt,
        };
      } else {
        const thread = await bb.sdk.threads.get({ threadId: context.threadId });
        let hostId = input.hostId;
        let rootPath: string | undefined;
        let filePath = input.path;
        if (input.scope === "workspace") {
          if (!thread.environmentId) {
            throw new Error("This thread has no workspace environment");
          }
          const environment = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
            signal: context.signal,
          });
          if (!environment.path) {
            throw new Error("This thread environment has no workspace path");
          }
          hostId = environment.hostId;
          rootPath = environment.path;
          filePath = isAbsoluteHostPath(input.path)
            ? input.path
            : joinHostPath(environment.path, input.path);
        } else if (!isAbsoluteHostPath(input.path)) {
          throw new Error(
            "Host-scoped AnyDoc ingestion requires an absolute path",
          );
        }

        const file = await bb.sdk.files.read({
          hostId,
          path: filePath,
          rootPath,
          signal: context.signal,
        });
        if (file.sizeBytes > MAX_SOURCE_BYTES) {
          throw new Error(
            `Document exceeds AnyDoc's ${MAX_SOURCE_BYTES} byte ingestion limit`,
          );
        }
        bytes =
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64")
            : Buffer.from(file.content, "utf8");
        sourceSha256 = file.sha256;
        provenance = {
          kind: "host-file",
          path: file.path,
          hostId: hostId ?? "primary",
          rootPath,
          sourceSha256,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
          modifiedAtMs: file.modifiedAtMs,
          observedAt,
        };
      }

      const record = await convertAnyDocBytes({
        bytes,
        sourceName: input.path,
        sourceSha256,
        title: input.title,
        associations: input.associations,
        provenance,
      });
      return JSON.stringify(
        publicRecord(saveRecord(db, record), 0, input.maxChars),
      );
    },
  });

  bb.agents.registerTool({
    name: "anydoc_read_document",
    description:
      "Read another bounded Markdown chunk or the durable provenance/associations for a previously ingested AnyDoc evidence record.",
    parameters: z
      .object({
        id: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        maxChars: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_CHUNK_CHARS)
          .default(DEFAULT_CHUNK_CHARS),
      })
      .strict(),
    execute(input) {
      const record = getRecord(db, input.id);
      if (!record) throw new Error(`AnyDoc ingestion not found: ${input.id}`);
      return JSON.stringify(publicRecord(record, input.offset, input.maxChars));
    },
  });

  bb.agents.registerTool({
    name: "anydoc_associate_evidence",
    description:
      "Associate an ingested document with canonical entity, workstream, and goal references without re-parsing it.",
    parameters: z
      .object({
        id: z.string().min(1),
        associations: associationSchema,
      })
      .strict(),
    execute(input) {
      const record = getRecord(db, input.id);
      if (!record) throw new Error(`AnyDoc ingestion not found: ${input.id}`);
      record.associations = mergeAssociations(
        record.associations,
        input.associations,
      );
      record.updatedAt = new Date().toISOString();
      saveRecord(db, record);
      return JSON.stringify(publicRecord(record, 0, 1_000));
    },
  });

  bb.agents.configure(() => ({
    tools: [
      "anydoc_ingest_document",
      "anydoc_read_document",
      "anydoc_associate_evidence",
    ],
    skills: [],
    instructions:
      "AnyDoc is shared ingestion infrastructure, not a document UI. Use it when a supported binary/office document contains context needed for the current goal. Preserve the returned evidenceRef in facts, opportunities, decisions, and outcomes; associate canonical entities/workstreams/goals as they become clear. Do not duplicate BB file browsing, and do not surface raw document detail unless it affects what the human must understand, decide, approve, or do.",
  }));
}
