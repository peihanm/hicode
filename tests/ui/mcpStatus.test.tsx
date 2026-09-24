import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {McpStatus} from "../../src/ui/mcp/McpStatus.js";
import type {McpServerSnapshot} from "../../src/mcp/types.js";
import stringWidth from "string-width";
afterEach(cleanup);
const server = (name: string, status: McpServerSnapshot["status"]): McpServerSnapshot => ({name, status, source: "project", toolCount: 0});

test("healthy/disabled servers have no transient row; failures coexist with connection progress", () => {
  const view = render(<McpStatus servers={[server("ok", "connected"), server("off", "disabled")]}/>);
  expect(view.lastFrame()).toBe("");
  view.rerender(<McpStatus servers={[server("ok", "connected"), server("loading", "connecting"), server("broken", "failed")]}/>);
  expect(view.lastFrame()).toContain("Connecting MCP · 1/3 ready · loading");
  expect(view.lastFrame()).toContain("MCP failed · broken");
  view.rerender(<McpStatus servers={[server("denied", "denied"), server("skipped", "pending-approval")]}/>);
  expect(view.lastFrame()).not.toContain("Connecting"); expect(view.lastFrame()).not.toContain("MCP failed");
  expect(view.lastFrame()).toContain("MCP not connected");
});

test("many failures stay bounded and reflow in narrow terminals without control characters", () => {
  const servers = Array.from({length: 12}, (_, i) => server(`server-${i}\x1b[31m\n`, "failed"));
  const view = render(<McpStatus servers={servers}/>);
  expect(view.lastFrame()).toContain("+9"); expect(view.lastFrame()).not.toContain("server-3");
  expect(view.lastFrame()).not.toContain("\x1b");
  expect((view.lastFrame() ?? "").split("\n").every(line => stringWidth(line) <= 80)).toBe(true);
});

test.each(["connected", "failed"] as const)("loading animates only its glyph, then stops when %s", async status => {
  let parentRenders = 0;
  function Parent() {parentRenders++; return <McpStatus servers={[server("blender", "connecting")]}/>;}
  const view = render(<Parent/>);
  const startedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 380));
  const loadingFrames = view.frames.filter(frame => frame.includes("Connecting MCP"));
  expect(new Set(loadingFrames.map(frame => frame.match(/[◐◓◑◒]/)?.[0])).size).toBeGreaterThan(1);
  expect(new Set(loadingFrames.map(frame => frame.replace(/[◐◓◑◒]/g, "*")).values()).size).toBe(1);
  expect(loadingFrames.length).toBeLessThanOrEqual(Math.ceil((Date.now() - startedAt) / 120) + 2);
  expect(parentRenders).toBe(1);
  view.rerender(<McpStatus servers={[server("blender", status)]}/>);
  await new Promise(resolve => setTimeout(resolve, 40));
  const settled = view.frames.length;
  await new Promise(resolve => setTimeout(resolve, 280));
  expect(view.frames.length).toBe(settled);
  expect(view.lastFrame()).not.toMatch(/[◐◓◑◒]/);
  if (status === "failed") expect(view.lastFrame()).toContain("MCP failed · blender");
  else expect(view.lastFrame()).toBe("");
});
