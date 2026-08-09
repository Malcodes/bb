import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPluginServer } from "./build-plugin-server.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

describe("plugin backend binary assets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-plugin-server-wasm-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits imported WASM beside the self-contained server bundle", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-wasm-fixture",
        version: "0.1.0",
        type: "module",
        bb: {
          name: "WASM fixture",
          description: "Backend WASM asset fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(root, "server.ts"),
      'import wasmUrl from "./module.wasm?url"; export { wasmUrl }; export default function plugin() {}\n',
    );
    // Minimal valid empty WebAssembly module.
    await writeFile(
      join(root, "module.wasm"),
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );

    const toolchain = await resolvePluginBuildToolchain(join(root, ".tools"));
    const built = await buildPluginServer(root, "0.9.0-test", toolchain);
    const module = (await import(
      `${pathToFileURL(built.jsPath).href}?test=1`
    )) as {
      wasmUrl: string;
    };
    const emitted = new URL(module.wasmUrl, pathToFileURL(built.jsPath));
    await expect(access(emitted)).resolves.toBeUndefined();
    await expect(readFile(emitted)).resolves.toEqual(
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
  });
});
