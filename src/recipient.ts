import { escape } from "./http";

const icons = {
  cloud:
    '<path d="M6 17a4 4 0 0 1-.7-7.94A7 7 0 0 1 19 8a4.5 4.5 0 0 1-.5 9H16M12 20V10m-3 3 3-3 3 3"/>',
  download:
    '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  document:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h5"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-6-6L3 21"/>',
  archive:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M10 3v2m0 2v2m0 2v2"/><rect x="8" y="15" width="4" height="4" rx="1"/>',
  video:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
  audio:
    '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
};
function icon(name: keyof typeof icons) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}
function fileKind(name: string): keyof typeof icons {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "heic", "gif", "svg", "webp"].includes(ext))
    return "image";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  if (["mp4", "mov", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "flac"].includes(ext)) return "audio";
  return "document";
}
function bytes(value: number, locale: string) {
  const unit =
    value < 1000 ? "B" : value < 1e6 ? "KB" : value < 1e9 ? "MB" : "GB";
  const divisor = { B: 1, KB: 1000, MB: 1e6, GB: 1e9 }[unit];
  return `${(value / divisor).toLocaleString(locale, { maximumFractionDigits: 2 })} ${unit}`;
}
const styles = `
:root{color-scheme:light dark;--bg:#f3f5fa;--surface:#fff;--text:#172238;--muted:#647087;--line:#e4e9f1;--blue:#285ee8;--soft:#eef3ff;--shadow:0 12px 48px #182e5910}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% 0,#e4ebff 0,transparent 54%),var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--blue)}a:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid var(--blue);outline-offset:5px}svg{width:24px;height:24px;flex:none}.shell{max-width:860px;margin:0 auto;padding:32px 24px 36px}.brandbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px}.brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:20px;letter-spacing:-.5px}.brand-icon{display:grid;place-items:center;width:38px;height:38px;background:var(--blue);color:white;border-radius:12px;box-shadow:0 4px 12px #285ee82b}.brand-icon svg{width:23px}.byline{font-size:12px;color:var(--muted);letter-spacing:0}.top-note{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}.top-note svg{width:15px;height:15px}p{color:var(--muted);margin:0}.file-panel{background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.panel-heading{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:22px 24px;border-bottom:1px solid var(--line)}.panel-title h1{font-size:22px;line-height:1.2;letter-spacing:-.45px;margin:0;font-weight:750}.panel-title p{font-size:12px;margin-top:5px}.panel-total{text-align:right;min-width:110px}.panel-total strong{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}.panel-total span{display:block;margin-top:1px;color:var(--muted);font-size:11px}.files{list-style:none;padding:0;margin:0}.file{display:flex;align-items:center;gap:15px;padding:18px 24px}.file+.file{border-top:1px solid var(--line)}.file-icon{width:44px;height:48px;flex:none;display:grid;place-items:center;border-radius:11px;background:var(--soft);color:var(--blue)}.file-icon.archive{background:#fff4e7;color:#a36520}.file-icon.image{background:#f6edff;color:#8850b9}.file-icon.audio,.file-icon.video{background:#e7f5f1;color:#287d68}.file-info{flex:1;min-width:0}.filename{display:block;font-size:14px;line-height:1.5;font-weight:650;overflow-wrap:anywhere}.file-meta{display:flex;gap:8px;align-items:center;margin-top:5px;font-size:12px;color:var(--muted)}.extension{font-size:9px;letter-spacing:.45px;font-weight:700;border:1px solid var(--line);border-radius:4px;padding:1px 4px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.download{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:9px 14px;background:var(--soft);color:var(--blue);border:1px solid transparent;border-radius:9px;text-decoration:none;font-size:12px;font-weight:650;white-space:nowrap;transition:background .15s,color .15s}.download:hover{background:var(--blue);color:white}.download svg{width:16px;height:16px}.files.single .download{background:var(--blue);color:#fff}.expiry{display:flex;align-items:center;gap:12px;margin:18px 4px 0;padding:15px 18px;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--surface) 55%,transparent)}.expiry>svg{color:var(--muted);width:20px;height:20px}.expiry strong{font-size:12px;font-weight:650}.expiry p{font-size:12px;margin-top:2px}.footer{display:flex;justify-content:space-between;align-items:start;gap:18px;padding:22px 6px 0;color:var(--muted);font-size:11px}.footer p{max-width:440px}.footer a{color:var(--muted);white-space:nowrap;text-underline-offset:3px}.footer a:hover{color:var(--blue)}.report-card{padding:28px;background:var(--surface);border:1px solid var(--line);border-radius:20px}.report-card h1{font-size:28px;line-height:1.2;letter-spacing:-.6px;margin:0 0 12px}.report-card p{margin-bottom:20px}textarea{width:100%;min-height:160px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:14px;font:inherit;resize:vertical}button{background:var(--blue);color:white;border:0;border-radius:9px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer}.report-card button{margin-top:16px}.skip{position:absolute;top:-80px}.skip:focus{top:8px;left:8px;background:var(--surface);padding:8px;z-index:2}
@media(prefers-color-scheme:dark){:root{--bg:#111722;--surface:#1b2331;--text:#edf2fb;--muted:#a6b2c8;--line:#303b4e;--blue:#8bacff;--soft:#273653;--shadow:0 12px 48px #0002}body{background:radial-gradient(ellipse at 50% 0,#1d2b49 0,transparent 54%),var(--bg)}.brand-icon,button,.files.single .download{background:#3a68e9;color:#fff}.file-icon.archive{background:#3e3225;color:#edb66f}.file-icon.image{background:#382c47;color:#caa0ef}.file-icon.audio,.file-icon.video{background:#223e38;color:#91cbb9}}
@media(max-width:600px){.shell{padding:22px 16px 30px}.brandbar{margin-bottom:20px}.top-note{display:none}.panel-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;padding:18px;gap:12px}.panel-title{min-width:0}.panel-title h1{font-size:20px}.panel-total{min-width:0}.panel-total strong{font-size:14px}.file{display:grid;grid-template-columns:38px minmax(0,1fr);padding:17px 18px;gap:12px}.file-icon{width:38px;height:44px}.file-info{min-width:0}.download{grid-column:2;margin:0;width:100%;min-height:44px}.expiry{margin-top:16px;padding:14px}.footer{flex-direction:column;gap:10px}.report-card{padding:22px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const uploadingStyles = `.uploading{display:flex;gap:12px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--soft)}.uploading>svg{color:var(--blue);width:22px;height:22px}.uploading strong{font-size:13px;font-weight:650}.uploading p{font-size:12px;margin-top:2px}.file.pending .file-icon,.file.pending .file-info{opacity:.55}.pending-label{font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;padding:9px 4px}@media(max-width:600px){.uploading{padding:12px 18px}.pending-label{grid-column:2;padding:0}}`;

const previewStyles = `.image-preview{margin:0;padding:20px 24px;border-bottom:1px solid var(--line);text-align:center}.image-preview a{display:block;line-height:0;border-radius:8px;max-height:70vh;overflow:auto;background:var(--bg)}.image-preview img{display:block;max-width:100%;width:auto;height:auto;margin:auto}.image-preview figcaption{margin-top:10px;color:var(--muted);font-size:12px}@media(max-width:600px){.image-preview{padding:16px 18px}}`;

export const page = (
  title: string,
  body: string,
  locale = "en",
  metadata = "",
) =>
  `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>${escape(title)} · MFCloud</title>${metadata}<style>${styles}${uploadingStyles}${previewStyles}</style></head><body><a class="skip" href="#main">${locale === "vi" ? "Đến nội dung" : "Skip to content"}</a><div class="shell"><header class="brandbar"><div class="brand"><span class="brand-icon">${icon("cloud")}</span><span>MFCloud <span class="byline">by MFinder</span></span></div><div class="top-note">${icon("arrow")}${locale === "vi" ? "Chia sẻ gọn gàng." : "Sharing, made simple."}</div></header><main id="main">${body}</main></div></body></html>`;

function expiryAside(expiresAt: number, vi: boolean) {
  const expiry = new Date(expiresAt * 1000);
  const expiryText = new Intl.DateTimeFormat(vi ? "vi-VN" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(expiry);
  const remaining = Math.max(
    1,
    Math.ceil((expiresAt - Date.now() / 1000) / 3600),
  );
  const duration =
    remaining >= 48
      ? `${Math.ceil(remaining / 24)} ${vi ? "ngày" : "days"}`
      : `${remaining} ${vi ? "giờ" : remaining === 1 ? "hour" : "hours"}`;
  return `<aside class="expiry">${icon("clock")}<div><strong>${vi ? `Còn ${duration} để tải xuống` : `Available for ${duration}`}</strong><p>${vi ? "Hết hạn" : "Expires"} <time datetime="${expiry.toISOString()}">${escape(expiryText)} UTC</time></p></div></aside>`;
}
export function recipientPage(
  share: {
    token: string;
    bytes: number;
    expires_at: number | null;
    status?: string;
    ttl?: number;
  },
  files: Array<{ id: string; name: string; bytes: number; status?: string }>,
  locale: "en" | "vi",
  preview?: { id: string; name: string; mime: string; origin: string },
) {
  const vi = locale === "vi";
  const imagePath = preview
    ? `/${share.token}/files/${preview.id}/preview`
    : "";
  const image = preview
    ? `<figure class="image-preview"><a href="${imagePath}" target="_blank" rel="noopener" aria-label="${vi ? "Xem ảnh kích thước gốc" : "View full-size image"}"><img src="${imagePath}" alt="${escape(preview.name)}" decoding="async"></a><figcaption>${vi ? "Bấm vào ảnh để xem kích thước gốc" : "Click the image to view it at full size"}</figcaption></figure>`
    : "";
  // The sender shared the link before the upload finished: list every file,
  // offer only the finished ones, and reload until the collection is published.
  const uploading = share.status === "uploading" || share.expires_at === null;
  const isReady = (file: { status?: string }) =>
    !uploading || file.status === "ready";
  const finished = files.filter(isReady).length;
  const refresh = uploading ? '<meta http-equiv="refresh" content="30">' : "";
  const metadata = preview
    ? `<meta property="og:type" content="website"><meta property="og:title" content="${escape(preview.name)}"><meta property="og:description" content="${vi ? "Ảnh được chia sẻ qua MFinder" : "Image shared with MFinder"}"><meta property="og:url" content="${escape(new URL(`/${share.token}`, preview.origin).href)}"><meta property="og:image" content="${escape(new URL(imagePath, preview.origin).href)}"><meta property="og:image:type" content="${escape(preview.mime)}"><meta property="og:image:alt" content="${escape(preview.name)}">`
    : "";
  const count = vi
    ? `${files.length} file`
    : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  const banner = uploading
    ? `<div class="uploading" role="status">${icon("cloud")}<div><strong>${vi ? "Người gửi vẫn đang tải lên" : "The sender is still uploading"}</strong><p>${vi ? `Đã xong ${finished}/${files.length} file. Trang này tự cập nhật.` : `${finished} of ${files.length} ${files.length === 1 ? "file" : "files"} ready. This page updates automatically.`}</p></div></div>`
    : "";
  const expiryNote = uploading
    ? (() => {
        const days = Math.max(1, Math.round((share.ttl ?? 86400) / 86400));
        return `<aside class="expiry">${icon("clock")}<div><strong>${vi ? `Tải được trong ${days} ngày sau khi tải lên xong` : `Available for ${days} ${days === 1 ? "day" : "days"} after the upload finishes`}</strong></div></aside>`;
      })()
    : expiryAside(share.expires_at!, vi);
  const rows = files
    .map((file) => {
      const kind = fileKind(file.name);
      const extension = file.name.includes(".")
        ? file.name.split(".").pop()!.slice(0, 12).toUpperCase()
        : "FILE";
      const action = vi ? "Tải xuống" : "Download";
      if (!isReady(file)) {
        const pending = vi ? "Đang tải lên…" : "Uploading…";
        return `<li class="file pending"><span class="file-icon ${kind}">${icon(kind)}</span><div class="file-info"><strong class="filename">${escape(file.name)}</strong><div class="file-meta"><span>${bytes(file.bytes, locale)}</span><span class="extension">${escape(extension)}</span></div></div><span class="pending-label" aria-label="${pending}: ${escape(file.name)}">${pending}</span></li>`;
      }
      return `<li class="file"><span class="file-icon ${kind}">${icon(kind)}</span><div class="file-info"><strong class="filename">${escape(file.name)}</strong><div class="file-meta"><span>${bytes(file.bytes, locale)}</span><span class="extension">${escape(extension)}</span></div></div><a class="download" href="/${share.token}/files/${file.id}" download aria-label="${action}: ${escape(file.name)}">${icon("download")}<span>${action}</span></a></li>`;
    })
    .join("");
  return page(
    vi ? "File được chia sẻ" : "Shared files",
    `<section class="file-panel" aria-labelledby="files-heading"><div class="panel-heading"><div class="panel-title"><h1 id="files-heading">${vi ? "File được chia sẻ" : "Shared files"}</h1><p>${count}</p></div><div class="panel-total"><strong>${bytes(share.bytes, locale)}</strong><span>${vi ? "tổng dung lượng" : "total size"}</span></div></div>${banner}${image}<ul class="files ${files.length === 1 ? "single" : ""}">${rows}</ul></section>${expiryNote}<footer class="footer"><p>${vi ? "Chỉ mở file từ người bạn tin tưởng." : "Only open files from people you trust."}</p><a href="/${share.token}/report">${vi ? "Báo cáo vi phạm" : "Report abuse"}</a></footer>`,
    locale,
    refresh + metadata,
  );
}
