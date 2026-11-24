import type { Env, FileRecord } from "./types";

export function isPreviewCandidate(name: string) {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

// Inline responses are restricted to raster formats, verified from object
// bytes. A renamed HTML/SVG upload must never become active page content.
export async function previewMime(env: Env, file: FileRecord) {
  if (
    file.status !== "ready" ||
    file.bytes <= 0 ||
    !isPreviewCandidate(file.name)
  )
    return null;
  const object = await env.BUCKET.get(file.object_key, {
    range: { offset: 0, length: Math.min(file.bytes, 32) },
  });
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const starts = (signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
    return "image/gif";
  if (
    starts([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  )
    return "image/webp";
  return null;
}
