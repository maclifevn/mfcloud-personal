import { describe, it, expect } from "vitest";
import { recipientPage } from "../src/recipient";

describe("recipient page", () => {
  const share = { token: "Ab3xY9", bytes: 1031, expires_at: 1788700000 };
  const files = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      name: 'A \"quoted\" <img onerror=alert(1)>.png',
      bytes: 1031,
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      name: "Thư mục QA.zip",
      bytes: 0,
    },
  ];
  it("escapes names in text and download labels without rendering uploaded content", () => {
    const html = recipientPage(share, files, "en");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img onerror=alert(1)&gt;.png");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).not.toContain("<script");
    for (const file of files)
      expect(html).toContain(`href="/Ab3xY9/files/${file.id}" download`);
    expect(html).toContain("0 B");
    expect(html).toContain('href="/Ab3xY9/report"');
    expect(html).toContain("Shared files");
    expect(html).toContain("total size");
    expect(html).not.toContain('class="hero"');
    expect(html).not.toContain("Your files are here");
    expect(html).not.toContain("Ready to download");
  });
  it("renders Vietnamese, explicit UTC expiry and unabridged accessible filenames", () => {
    const html = recipientPage(share, files, "vi");
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("File được chia sẻ");
    expect(html).toContain("tổng dung lượng");
    expect(html).not.toContain("File đã sẵn sàng");
    expect(html).toContain('aria-label="Tải xuống: Thư mục QA.zip"');
    expect(html).toContain('<time datetime="');
    expect(html).toContain(" UTC</time>");
  });
  it("lists pending files without download links while the sender is still uploading", () => {
    const pending = files.map((file, index) => ({
      ...file,
      status: index === 0 ? "ready" : "uploading",
    }));
    const html = recipientPage(
      {
        token: "Ab3xY9",
        bytes: 1031,
        expires_at: null,
        status: "uploading",
        ttl: 604800,
      },
      pending,
      "en",
    );
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
    expect(html).toContain("The sender is still uploading");
    expect(html).toContain("1 of 2 files ready");
    expect(html).toContain(`href="/Ab3xY9/files/${files[0].id}" download`);
    expect(html).not.toContain(`/Ab3xY9/files/${files[1].id}`);
    expect(html).toContain("Uploading…");
    expect(html).toContain("Available for 7 days after the upload finishes");
    expect(html).not.toContain("<time");
    const vi = recipientPage(
      {
        token: "Ab3xY9",
        bytes: 1031,
        expires_at: null,
        status: "uploading",
        ttl: 86400,
      },
      pending,
      "vi",
    );
    expect(vi).toContain("Người gửi vẫn đang tải lên");
    expect(vi).toContain("Đã xong 1/2 file");
    expect(vi).toContain("Tải được trong 1 ngày sau khi tải lên xong");
  });
  it("does not refresh a published page", () => {
    const html = recipientPage(share, files, "en");
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("still uploading");
  });
});
