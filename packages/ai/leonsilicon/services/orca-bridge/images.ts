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
  mimeType: "image/jpeg" | "image/png";
}

// Pillow, for hosts without sips (Hermes Cloud's Linux): resize to the given width (or fit the long
// edge) and save as JPEG.
const PILLOW = `import sys
from PIL import Image
src, out, width, edge = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = Image.open(src).convert("RGB")
if width > 0:
    im = im.resize((width, max(1, round(im.height * width / im.width))))
else:
    im.thumbnail((edge, edge))
im.save(out, "JPEG", quality=72)`;
const PYTHONS = ["/opt/hermes/.venv/bin/python", "python3"];

/** Writes a JPEG of `src` to `out`, `width` wide (0 = fit MAX_IMAGE_EDGE). False when no converter works. */
async function toJpeg(src: string, out: string, width: number): Promise<boolean> {
  if (process.platform === "darwin") {
    await exec(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "72",
        ...(width ? ["--resampleWidth", String(width)] : ["-Z", String(MAX_IMAGE_EDGE)]),
        src,
        "--out",
        out,
      ],
      { timeout: 20_000 },
    );
    return true;
  }
  for (const python of PYTHONS) {
    try {
      await exec(python, ["-c", PILLOW, src, out, String(width), String(MAX_IMAGE_EDGE)], {
        timeout: 20_000,
      });
      return true;
    } catch {
      // try the next interpreter
    }
  }
  return false;
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
          if (await toJpeg(real, out, width ? outWidth : 0)) {
            images.push({
              type: "image",
              data: fs.readFileSync(out).toString("base64"),
              mimeType: "image/jpeg",
            });
            record.imageCoordinates =
              factor === 1 && width
                ? "image pixels = window-local click coordinates"
                : `multiply image pixels by ${(1 / factor).toFixed(4)} for window-local click coordinates`;
          } else {
            // No converter: the original screenshot, in device pixels.
            images.push({
              type: "image",
              data: fs.readFileSync(real).toString("base64"),
              mimeType: /\.png$/i.test(real) ? "image/png" : "image/jpeg",
            });
            record.imageCoordinates = `divide image pixels by ${scale} for window-local click coordinates`;
          }
          record.attachedImage = images.length;
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
