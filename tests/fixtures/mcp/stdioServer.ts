import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "pillar-test-mcp", version: "1.0.0" });

server.registerTool("echo", {
  description: "Echo a message",
  inputSchema: { message: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }));

server.registerTool("environment", {
  description: "Read one environment variable for isolation tests",
  inputSchema: { name: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ name }) => ({
  content: [{type: "text", text: process.env[name] ?? "<missing>"}],
}));

server.registerTool("large_text", {
  description: "Return a large deterministic text result",
  inputSchema: { size: z.number().int().min(1).max(100_000).default(60_000) },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ size }) => ({ content: [{ type: "text", text: "x".repeat(size) }] }));

server.registerTool("structured", {
  description: "Return structured content",
  inputSchema: { value: z.string() },
  outputSchema: { echoed: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ value }) => ({
  content: [{ type: "text", text: "structured result" }],
  structuredContent: { echoed: value },
}));

server.registerTool("fail", {
  description: "Return an MCP error",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => ({ content: [{ type: "text", text: "fixture failure" }], isError: true }));

server.registerTool("slow", {
  description: "Wait until complete or cancelled",
  inputSchema: { delayMs: z.number().int().min(1).max(10_000) },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async ({ delayMs }, extra) => {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (extra.signal.aborted) {
      return { content: [{ type: "text", text: "cancelled" }], isError: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { content: [{ type: "text", text: "slow complete" }] };
});

server.registerTool("binary", {
  description: "Return a tiny image block",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
}, async () => ({
  content: [{
    type: "image",
    data: Buffer.from("fixture-image").toString("base64"),
    mimeType: "image/png",
  }],
}));

server.registerTool("mutate", {
  description: "Represent a destructive MCP action without changing the fixture host",
  inputSchema: { value: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ value }) => ({
  content: [{ type: "text", text: `mutated:${value}` }],
}));

await server.connect(new StdioServerTransport());
