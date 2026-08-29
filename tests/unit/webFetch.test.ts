import {describe, expect, test} from "bun:test";
import {
  isPublicAddress,
  parsePublicWebUrl,
} from "../../src/tools/webFetch/network.js";
import {htmlToReadableText} from "../../src/tools/webFetch/webFetch.js";
import {generateRuleForTool} from "../../src/permissions/index.js";

describe("web_fetch boundaries", () => {
  test("只接受不含凭据的公共 HTTP(S) URL", () => {
    expect(parsePublicWebUrl("https://example.com/docs").hostname)
      .toBe("example.com");
    expect(() => parsePublicWebUrl("file:///etc/passwd")).toThrow("仅支持");
    expect(() => parsePublicWebUrl("https://user:secret@example.com"))
      .toThrow("用户名或密码");
    expect(() => parsePublicWebUrl("http://localhost:3000"))
      .toThrow("公共互联网地址");
    expect(() => parsePublicWebUrl("http://10.0.0.8"))
      .toThrow("禁止访问私网");
    expect(() => parsePublicWebUrl("http://[::1]"))
      .toThrow("禁止访问私网");
  });

  test("IP 分类拒绝私网、链路本地和保留地址", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.1.2.3")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicAddress("198.18.0.43")).toBe(false);
  });

  test("HTML 清理脚本样式并保留可读正文", () => {
    const text = htmlToReadableText(`
      <html><head><style>.x{color:red}</style></head>
      <body><h1>Docs &amp; API</h1><script>alert(1)</script>
      <p>Hello&nbsp;world</p><ul><li>One</li><li>Two</li></ul></body></html>
    `);
    expect(text).toContain("Docs & API");
    expect(text).toContain("Hello world");
    expect(text).toContain("- One");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
  });

  test("不再询问规则只放行当前域名", () => {
    expect(generateRuleForTool("web_fetch", {
      url: "https://docs.example.com/guide?token=hidden",
    })).toBe("web_fetch(domain:docs.example.com)");
    expect(generateRuleForTool("web_fetch", {
      url: "file:///etc/passwd",
    })).toBeNull();
  });
});
