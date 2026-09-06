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
  });
  it("renders Vietnamese, explicit UTC expiry and unabridged accessible filenames", () => {
    const html = recipientPage(share, files, "vi");
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("Sẵn sàng tải xuống");
    expect(html).toContain('aria-label="Tải xuống: Thư mục QA.zip"');
    expect(html).toContain('<time datetime="');
    expect(html).toContain(" UTC</time>");
  });
});
