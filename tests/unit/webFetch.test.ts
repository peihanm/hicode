import {describe, expect, test} from "bun:test";
import {
  isPublicAddress,
  parsePublicWebUrl,
  validatePinnedAddresses,
} from "../../src/tools/webFetch/network.js";
import {decodeWebText, htmlToReadableText} from "../../src/tools/webFetch/webFetch.js";
import {WebFailures} from "../../src/tools/webFetch/state.js";
import {generateRuleForTool} from "../../src/permissions/index.js";
import {fileURLToPath} from "node:url";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {displayWebUrl, webFetchFailure} from "../../src/tools/webFetch/errors.js";

describe("web_fetch boundaries", () => {
  test("explicit DNS answers keep HTTPS identity and public address boundaries", () => {
    expect(validatePinnedAddresses(new URL("https://example.com"), ["8.8.8.8"])).toEqual([{address: "8.8.8.8", family: 4}]);
    for (const address of ["127.0.0.1", "10.0.0.1", "198.18.0.1", "::1", "not-an-IP"]) expect(() => validatePinnedAddresses(new URL("https://example.com"), [address, "8.8.8.8"])).toThrow();
    expect(() => validatePinnedAddresses(new URL("http://example.com"), ["8.8.8.8"])).toThrow("HTTPS");
    expect(() => validatePinnedAddresses(new URL("https://8.8.8.8"), ["1.1.1.1"])).toThrow("HTTPS");
  });
  test("declared encodings are decoded without silently corrupting text", () => {
    expect(decodeWebText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset="windows-1252"')).toBe("café");
    expect(decodeWebText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), "text/html; charset=gbk")).toBe("中文");
    expect(() => decodeWebText(Buffer.from([0xff]), "text/plain; charset=utf-8")).toThrow();
    expect(() => decodeWebText(Buffer.from("text"), "text/plain; charset=unknown")).toThrow();
  });
  test("changed queries retain service failure evidence without leaking query values", () => {
    const failures = new WebFailures();
    failures.record("https://example.com/search?q=private-one", 10);
    const note = failures.record("https://example.com/search?q=private-two", 20);
    expect(note).toContain("failed 1 time(s)");
    expect(note).toContain("service has 2 failed retrieval(s)");
    expect(note).not.toContain("private-");
    failures.clear("https://example.com/search?q=private-one");
    expect(failures.record("https://other.example.com/search", 1)).toContain("service has 1 failed retrieval(s)");
  });
  test.each(["open", "open-auto", "open-ask", "open-deny", "reuse", "refresh", "permission", "query", "no-store", "expired", "evicted", "octet", "binary", "invalid-utf8", "failure", "http-error", "pinned-private", "pinned-http", "pinned-denied"])("session source reuse and recovery: %s", async mode => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/webFetchReuse.ts", import.meta.url)), mode],
      {env: testChildEnvironment.base, stdout: "pipe", stderr: "pipe"});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toEqual({code: 0, stdout: "verified\n", stderr: ""});
  });
  test("diagnostics redact signed URLs and bound cyclic and aggregate causes", () => {
    const url = new URL("https://example.com/doc?signature=secret-value#private-fragment");
    expect(displayWebUrl(url.toString())).toBe("https://example.com/doc?[redacted]");
    const inner = Object.assign(new Error("secret-value"), {code: "ECONNRESET"});
    inner.cause = inner;
    const error = webFetchFailure("request", new AggregateError([inner, ...Array.from({length: 100}, () => new Error("x".repeat(5000)))], url.toString()), url);
    expect(error.message).toContain("ECONNRESET");
    expect(error.message).not.toContain("secret-value");
    expect(error.message).not.toContain("private-fragment");
    expect(error.message.length).toBeLessThan(3000);
  });
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


test.each(["signed", "deny", "foreign", "private"])("redirect references preserve the exact target and domain boundary: %s", async mode => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/webFetchRedirect.ts", import.meta.url)), mode],
        {env: testChildEnvironment.base, stdout: "pipe", stderr: "pipe"});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toEqual({code: 0, stdout: "verified\n", stderr: ""});
});
