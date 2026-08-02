#!/usr/bin/env node
/**
 * Refuse a build that Cloudflare will not accept.
 *
 * Cloudflare rejects a single asset larger than 25 MiB. The ONNX runtime sits
 * just under that line: `ort-wasm-simd-threaded.jsep.wasm` is about 24.9 MiB,
 * so an upgrade of onnxruntime-web can push it over and break the deploy. A
 * deploy is the worst place to find that out.
 *
 * The check runs on the build output, in CI and by hand:
 *
 *     vp build && vp run check:assets
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Cloudflare refuses any file larger than this. */
const LIMIT = 25 * 1024 * 1024;

/**
 * Warn here, well before the limit.
 *
 * A file this close leaves no room for the next dependency bump, and the person
 * who reads the warning is the one who can act on it.
 */
const WARN = 23 * 1024 * 1024;

/** Cloudflare also caps how many files one deployment holds. */
const FILE_COUNT_LIMIT = 20_000;

const DIST = "dist";

interface Asset {
  readonly path: string;
  readonly bytes: number;
}

function walk(directory: string): Asset[] {
  const found: Asset[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push({ path, bytes: statSync(path).size });
  }
  return found;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function main(): void {
  let assets: Asset[];
  try {
    assets = walk(DIST);
  } catch {
    console.error(`no ${DIST} directory. Run \`vp build\` first.`);
    process.exitCode = 1;
    return;
  }

  if (assets.length === 0) {
    console.error(`${DIST} is empty. Run \`vp build\` first.`);
    process.exitCode = 1;
    return;
  }

  const byLargest = [...assets].sort((a, b) => b.bytes - a.bytes);
  const oversized = byLargest.filter((asset) => asset.bytes > LIMIT);
  const close = byLargest.filter((asset) => asset.bytes > WARN && asset.bytes <= LIMIT);
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);

  console.log(`${assets.length} files, ${mib(total)} total`);
  console.log("largest:");
  for (const asset of byLargest.slice(0, 5)) {
    console.log(`  ${mib(asset.bytes).padStart(10)}  ${relative(DIST, asset.path)}`);
  }

  for (const asset of close) {
    console.warn(
      `\nWARNING: ${relative(DIST, asset.path)} is ${mib(asset.bytes)}. ` +
        `The Cloudflare limit is ${mib(LIMIT)}, so ${mib(LIMIT - asset.bytes)} is left. ` +
        `A dependency upgrade can push it over.`,
    );
  }

  if (assets.length > FILE_COUNT_LIMIT) {
    console.error(
      `\nFAIL: ${assets.length} files. Cloudflare accepts ${FILE_COUNT_LIMIT} in one deployment.`,
    );
    process.exitCode = 1;
  }

  if (oversized.length > 0) {
    console.error(`\nFAIL: ${oversized.length} file(s) are larger than the ${mib(LIMIT)} limit:`);
    for (const asset of oversized) {
      console.error(`  ${mib(asset.bytes)}  ${relative(DIST, asset.path)}`);
    }
    console.error("\nCloudflare will refuse this deployment. Make the file smaller, or host it");
    console.error("outside the deployment, for example in the R2 bucket.");
    process.exitCode = 1;
    return;
  }

  if (close.length === 0) console.log("\nevery asset is inside the Cloudflare limits");
}

main();
