/**
 * A development-only server for a DICOM study on disk.
 *
 * The browser cannot read a local folder without a user gesture, which makes
 * automated iteration hard. This plugin serves one study over HTTP so the app
 * can fetch it. It runs only under `vp dev`, and it is absent from any build.
 *
 * Point it at a study with the `DICOM_DEV_STUDY` environment variable:
 *
 *     DICOM_DEV_STUDY="/path/to/study" vp dev
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const ROUTE = "/__study";

interface SeriesEntry {
  readonly name: string;
  readonly files: readonly string[];
}

function findSeries(root: string): SeriesEntry[] {
  const series: SeriesEntry[] = [];

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    const dicomFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dcm"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

    if (dicomFiles.length > 0) {
      const name = relative(root, directory).split(sep).join("/") || ".";
      series.push({
        name,
        files: dicomFiles.map((file) => `${name}/${file}`),
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };

  walk(root);
  return series;
}

export function devStudy(): Plugin {
  return {
    name: "dicom-dev-study",
    apply: "serve",
    configureServer(server) {
      const configured = process.env.DICOM_DEV_STUDY;
      if (!configured) return;

      const root = resolve(configured);
      try {
        if (!statSync(root).isDirectory()) return;
      } catch {
        server.config.logger.warn(`[dev-study] no directory at ${root}`);
        return;
      }

      const series = findSeries(root);
      const total = series.reduce((sum, entry) => sum + entry.files.length, 0);
      server.config.logger.info(
        `[dev-study] serving ${total} files in ${series.length} series from ${root}`,
      );

      server.middlewares.use(ROUTE, (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");

        if (url.pathname === "/manifest.json") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ root, series }));
          return;
        }

        const wanted = decodeURIComponent(url.pathname.replace(/^\//, ""));
        const target = resolve(root, wanted);
        // Keep the server inside the study directory.
        if (!target.startsWith(root + sep)) {
          response.statusCode = 403;
          response.end("outside the study directory");
          return;
        }

        try {
          const body = readFileSync(target);
          response.setHeader("Content-Type", "application/dicom");
          response.setHeader("Content-Length", String(body.length));
          response.end(body);
        } catch {
          next();
        }
      });
    },
  };
}
