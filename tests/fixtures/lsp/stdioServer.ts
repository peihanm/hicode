#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

const logIndex = process.argv.indexOf("--log");
const logPath = logIndex >= 0 ? process.argv[logIndex + 1] : undefined;
const envNameIndex = process.argv.indexOf("--env-name");
const envName = envNameIndex >= 0 ? process.argv[envNameIndex + 1] : undefined;
const oversizedFrame = process.argv.includes("--oversized-frame");
let input = Buffer.alloc(0);

function log(event: string): void {
  if (logPath) appendFileSync(logPath, `${event}\n`, "utf8");
}

function send(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
  );
}

function respond(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function publishDiagnostics(uri: string): void {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 2,
          source: "fixture-lsp",
          code: "FIXTURE",
          message: "fixture diagnostic",
        },
      ],
    },
  });
}

function handle(message: JsonRpcMessage): void {
  const method = message.method;
  if (!method) return;
  log(method);

  if (method === "initialize" && message.id !== undefined) {
    if (oversizedFrame) {
      process.stdout.write("Content-Length: 20000000\r\n\r\n");
      return;
    }
    respond(message.id, {
      capabilities: {
        textDocumentSync: 1,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      },
      serverInfo: { name: "pillar-test-lsp", version: "1" },
    });
    return;
  }

  if (method === "textDocument/documentSymbol" && message.id !== undefined) {
    respond(message.id, [
      {
        name: "fixtureSymbol",
        kind: 12,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 26 },
        },
      },
    ]);
    return;
  }

  if (method === "workspace/symbol" && message.id !== undefined) {
    respond(message.id, []);
    return;
  }

  if (method === "textDocument/didOpen" || method === "textDocument/didSave") {
    const params = message.params as {
      textDocument?: { uri?: string };
    } | undefined;
    const uri = params?.textDocument?.uri;
    if (uri) publishDiagnostics(uri);
    return;
  }

  if (method === "shutdown" && message.id !== undefined) {
    respond(message.id, null);
    return;
  }

  if (method === "exit") {
    setTimeout(() => process.exit(0), 0);
    return;
  }

  if (message.id !== undefined) respond(message.id, null);
}

function parse(): void {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      input = input.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (input.length < bodyEnd) return;
    const body = input.subarray(bodyStart, bodyEnd).toString("utf8");
    input = input.subarray(bodyEnd);
    handle(JSON.parse(body) as JsonRpcMessage);
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  parse();
});
process.stdin.resume();
log("process/start");
if (envName) log(`env:${envName}=${process.env[envName] ?? "<missing>"}`);
