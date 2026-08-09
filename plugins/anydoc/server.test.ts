import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin, { convertAnyDocBytes } from "./server.js";

const csv = Buffer.from(
  "company,commitment,owner\nAcme,Send proposal by Friday,Malcolm\n",
);
const sha256 = createHash("sha256").update(csv).digest("hex");

function provenance() {
  return {
    kind: "host-file" as const,
    path: "/work/docs/commitments.csv",
    hostId: "host-1",
    rootPath: "/work",
    sourceSha256: sha256,
    sizeBytes: csv.length,
    mimeType: "text/csv",
    modifiedAtMs: 1_723_000_000_000,
    observedAt: "2026-08-09T15:00:00.000Z",
  };
}

describe("AnyDoc document ingestion infrastructure", () => {
  it("converts clean Markdown with stable evidence identity and associations", async () => {
    const record = await convertAnyDocBytes({
      bytes: csv,
      sourceName: "commitments.csv",
      provenance: provenance(),
      associations: {
        entityRefs: ["company:acme"],
        workstreamRefs: ["workstream:proposal"],
        goalIds: ["goal:close-acme"],
      },
      now: new Date("2026-08-09T15:00:00.000Z"),
    });
    expect(record.id).toBe(`doc_${sha256.slice(0, 24)}`);
    expect(record.evidenceRef).toBe(`anydoc:sha256:${sha256}`);
    expect(record.markdown).toContain(
      "| Acme | Send proposal by Friday | Malcolm |",
    );
    expect(record.associations).toEqual({
      entityRefs: ["company:acme"],
      workstreamRefs: ["workstream:proposal"],
      goalIds: ["goal:close-acme"],
    });
    expect(record.provenance[0]).toMatchObject({
      path: "/work/docs/commitments.csv",
      sourceSha256: sha256,
      sizeBytes: csv.length,
    });
  });

  it("converts structured rich-text documents through the same clean Markdown model", async () => {
    const bytes = Buffer.from(
      "{\\rtf1\\ansi\\b Quarterly plan\\b0\\par Acme commitment}",
    );
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const record = await convertAnyDocBytes({
      bytes,
      sourceName: "plan.rtf",
      provenance: {
        kind: "host-file",
        path: "/work/plan.rtf",
        hostId: "host-1",
        sourceSha256,
        sizeBytes: bytes.length,
        observedAt: "2026-08-09T15:00:00.000Z",
      },
    });
    expect(record.format).toBe("rtf");
    expect(record.markdown).toBe("**Quarterly plan**\n\nAcme commitment");
  });

  it("uses BB host file access, persists provenance, pages context, and merges later associations", async () => {
    const host = createFakePluginHost({
      pluginId: "anydoc",
      sdk: {
        threads: {
          get: () => ({ id: "thread-1", environmentId: "environment-1" }),
        },
        environments: {
          get: () => ({
            id: "environment-1",
            hostId: "host-1",
            path: "/work",
          }),
        },
        files: {
          read: (input: { path: string; rootPath?: string }) => ({
            path: input.path,
            content: csv.toString("base64"),
            contentEncoding: "base64",
            mimeType: "text/csv",
            sizeBytes: csv.length,
            modifiedAtMs: 1_723_000_000_000,
            sha256,
          }),
        },
      },
    });
    await plugin(host.bb);
    const first = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "anydoc_ingest_document",
          {
            path: "docs/commitments.csv",
            scope: "workspace",
            title: "Acme commitments",
            associations: {
              entityRefs: ["company:acme"],
              workstreamRefs: [],
              goalIds: [],
            },
            maxChars: 1_000,
          },
          { threadId: "thread-1", projectId: "project-1" },
        ),
      ),
    );
    expect(first).toMatchObject({
      evidenceRef: `anydoc:sha256:${sha256}`,
      title: "Acme commitments",
      format: "csv",
      offset: 0,
      nextOffset: null,
      associations: { entityRefs: ["company:acme"] },
    });
    expect(host.harness.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
      hostId: "host-1",
      path: "/work/docs/commitments.csv",
      rootPath: "/work",
    });

    const associated = JSON.parse(
      String(
        await host.harness.callAgentTool("anydoc_associate_evidence", {
          id: first.evidenceRef,
          associations: {
            entityRefs: ["person:malcolm"],
            workstreamRefs: ["workstream:proposal"],
            goalIds: ["goal:close-acme"],
          },
        }),
      ),
    );
    expect(associated.associations).toEqual({
      entityRefs: ["company:acme", "person:malcolm"],
      workstreamRefs: ["workstream:proposal"],
      goalIds: ["goal:close-acme"],
    });

    const read = JSON.parse(
      String(
        await host.harness.callAgentTool("anydoc_read_document", {
          id: first.id,
          offset: 0,
          maxChars: 1_000,
        }),
      ),
    );
    expect(read.markdown).toContain("Send proposal by Friday");
    expect(read.provenance[0]).toMatchObject({
      hostId: "host-1",
      rootPath: "/work",
      sourceSha256: sha256,
    });
    await host.harness.dispose();
  });

  it("ingests an existing BB project attachment without duplicating upload or file browsing", async () => {
    const host = createFakePluginHost({
      pluginId: "anydoc",
      sdk: {
        projects: {
          attachments: {
            read: () => ({
              bytes: csv,
              mimeType: "text/csv",
              sizeBytes: csv.length,
            }),
          },
        },
      },
    });
    await plugin(host.bb);
    const result = JSON.parse(
      String(
        await host.harness.callAgentTool(
          "anydoc_ingest_document",
          {
            path: "attachments/commitments.csv",
            scope: "attachment",
            associations: {
              entityRefs: ["company:acme"],
              workstreamRefs: [],
              goalIds: [],
            },
            maxChars: 1_000,
          },
          { threadId: "thread-1", projectId: "project-1" },
        ),
      ),
    );
    expect(
      host.harness.sdk.callsTo("projects.attachments.read")[0]?.[0],
    ).toMatchObject({
      projectId: "project-1",
      path: "attachments/commitments.csv",
    });
    expect(result.provenance[0]).toMatchObject({
      kind: "project-attachment",
      path: "attachments/commitments.csv",
      projectId: "project-1",
      sourceSha256: sha256,
    });
    expect(host.harness.sdk.callsTo("files.read")).toHaveLength(0);
    await host.harness.dispose();
  });

  it("rejects formats AnyDoc does not support", async () => {
    await expect(
      convertAnyDocBytes({
        bytes: Buffer.from("hello"),
        sourceName: "notes.txt",
        provenance: provenance(),
      }),
    ).rejects.toThrow(/Unsupported AnyDoc format/);
  });
});
