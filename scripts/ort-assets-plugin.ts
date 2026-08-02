/**
 * Serve the ONNX Runtime WebAssembly from our own origin.
 *
 * transformers.js asks a public CDN for the runtime binary. A page that allows
 * a CDN in `script-src` lets that CDN run any code it likes, which is the wrong
 * trade for a viewer that handles medical images. The Content-Security-Policy
 * refuses it, and the download fails.
 *
 * So the binaries ship with the site. This plugin copies them out of the
 * installed package into `/ort/`, in the development server and in the build.
 * The shell then points the runtime at that path.
 *
 * The names are fixed, not hashed, because the runtime builds the URL itself at
 * load time from a prefix. Caching is handled by the immutable version in the
 * path, which changes whenever the package does.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

export const ORT_PREFIX = "/ort/";

/**
 * Find the folder that holds the runtime binaries.
 *
 * onnxruntime-web is a transitive dependency, and pnpm does not put a
 * transitive dependency in the top level `node_modules`. It also does not
 * export its `package.json`. So the search starts at the transformers.js entry
 * point and resolves the runtime's main file from there. That file sits beside
 * the binaries.
 */
function runtimeDirectory(): string | undefined {
  try {
    const here = createRequire(import.meta.url);
    const transformers = here.resolve("@huggingface/transformers");
    const beside = createRequire(transformers);
    return dirname(beside.resolve("onnxruntime-web"));
  } catch {
    return undefined;
  }
}

/**
 * The runtime is two files per build, not one.
 *
 * Each `.wasm` has a `.mjs` beside it that loads it. The runtime imports the
 * `.mjs` from the same prefix, so both must ship. Only the
 * `ort-wasm-simd-threaded` family is copied. The other files in that folder are
 * the bundler entry points, which the application already holds.
 */
const WANTED = /^ort-wasm-simd-threaded[.\w-]*\.(wasm|mjs)$/;

function binaries(): { name: string; path: string }[] {
  const dist = runtimeDirectory();
  if (!dist) return [];
  try {
    return readdirSync(dist)
      .filter((name) => WANTED.test(name))
      .map((name) => ({ name, path: join(dist, name) }));
  } catch {
    return [];
  }
}

function contentType(name: string): string {
  return name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8";
}

export function ortAssets(): Plugin {
  return {
    name: "ort-wasm-assets",

    configureServer(server) {
      const files = new Map(binaries().map((file) => [file.name, file.path]));
      if (files.size === 0) {
        server.config.logger.warn("[ort-assets] found no onnxruntime-web binaries");
        return;
      }
      server.middlewares.use(ORT_PREFIX, (request, response, next) => {
        const name = decodeURIComponent((request.url ?? "").replace(/^\//, "").split("?")[0] ?? "");
        const path = files.get(name);
        if (!path) {
          next();
          return;
        }
        const body = readFileSync(path);
        response.setHeader("Content-Type", contentType(name));
        response.setHeader("Content-Length", String(body.length));
        response.end(body);
      });
    },

    generateBundle() {
      for (const file of binaries()) {
        this.emitFile({
          type: "asset",
          fileName: `ort/${file.name}`,
          source: readFileSync(file.path),
        });
      }
    },
  };
}
