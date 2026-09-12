import {describe, expect, test} from "bun:test";
import {
  isPublicAddress,
  parsePublicWebUrl,
} from "../../src/tools/webFetch/network.js";
import {htmlToReadableText} from "../../src/tools/webFetch/webFetch.js";
import {generateRuleForTool} from "../../src/permissions/index.js";
import {fileURLToPath} from "node:url";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

describe("web_fetch boundaries", () => {
  test.each(["default", "maximum", "http-error", "save-failure"])("全文证据 %s", async mode => {
    const child = Bun.spawn([process.execPath,
      fileURLToPath(new URL("../fixtures/webFetchEvidence.ts", import.meta.url)), mode],
      {env: testChildEnvironment.base, stdout: "pipe", stderr: "pipe"});
    const [code, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toEqual({code: 0, stdout: "verified\n", stderr: ""});
  });
  test("只接受不含凭据的公共 HTTP(S) URL", () => {
    expect(parsePublicWebUrl("https://example.com/docs").hostname)
      .toBe("example.com");
    expect(() => parsePublicWebUrl("file:///etc/passwd")).toThrow("Only");
    expect(() => parsePublicWebUrl("https://user:secret@example.com"))
      .toThrow("username or password");
    expect(() => parsePublicWebUrl("http://localhost:3000"))
      .toThrow("public internet");
    expect(() => parsePublicWebUrl("http://10.0.0.8"))
      .toThrow("blocks private");
    expect(() => parsePublicWebUrl("http://[::1]"))
      .toThrow("blocks private");
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
