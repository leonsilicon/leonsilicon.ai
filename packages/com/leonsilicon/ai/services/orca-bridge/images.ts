import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_IMAGES = 3;
const MAX_IMAGE_EDGE = 1568; // Hermes re-embeds anything larger at this long edge anyway
const IMAGE_FILE = /\.(png|jpe?g)$/i;
const TMP_ROOTS = [
  os.tmpdir(),
  "/var/folders/",
  "/tmp/",
  "/private/var/folders/",
  "/private/tmp/",
].map((p) => path.resolve(p));

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: "image/jpeg";
}

/**
 * Orca saves computer-use screenshots to local temp files, which remote clients cannot read.
 * Each one (at most three) becomes a JPEG at the window's point size, so image pixels equal the
 * window-local coordinates that click/scroll/drag take, and is returned as MCP image content.
 * The node that named the file gets `attachedImage` and `imageCoordinates` instead of `path`.
 */
export async function attachImages(value: unknown): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  async function visit(node: unknown): Promise<void> {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) await visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      typeof record.path === "string" &&
      IMAGE_FILE.test(record.path) &&
      images.length < MAX_IMAGES
    ) {
      const real = path.resolve(record.path);
      if (TMP_ROOTS.some((r) => real.startsWith(r)) && fs.existsSync(real)) {
        const scale = Number(record.scale) > 0 ? Number(record.scale) : 1;
        const width = Number(record.width) > 0 ? Math.round(Number(record.width) / scale) : 0;
        const height = Number(record.height) > 0 ? Math.round(Number(record.height) / scale) : 0;
        const longest = Math.max(width, height);
        const factor = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
        const outWidth = width ? Math.max(1, Math.round(width * factor)) : MAX_IMAGE_EDGE;
        const out = path.join(os.tmpdir(), `orca-bridge-${randomUUID()}.jpg`);
        try {
          await exec(
            "/usr/bin/sips",
            [
              "-s",
              "format",
              "jpeg",
              "-s",
              "formatOptions",
              "72",
              ...(width ? ["--resampleWidth", String(outWidth)] : ["-Z", String(MAX_IMAGE_EDGE)]),
              real,
              "--out",
              out,
            ],
            { timeout: 20_000 },
          );
          images.push({
            type: "image",
            data: fs.readFileSync(out).toString("base64"),
            mimeType: "image/jpeg",
          });
          record.attachedImage = images.length;
          record.imageCoordinates =
            factor === 1 && width
              ? "image pixels = window-local click coordinates"
              : `multiply image pixels by ${(1 / factor).toFixed(4)} for window-local click coordinates`;
          delete record.path;
        } catch (error) {
          record.attachError = String((error as Error).message).slice(0, 300);
        } finally {
          fs.rmSync(out, { force: true });
        }
      }
    }
    for (const key of Object.keys(record)) await visit(record[key]);
  }
  await visit(value);
  return images;
}
