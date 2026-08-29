import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Diagnostic,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import type { LspManagerLike } from "../../src/lsp/types.js";
import type { LSPServerInstance } from "../../src/lsp/serverInstance.js";

export interface FakeLspState {
  requests: string[];
  openedFiles: string[];
  shutdownCount: number;
}

export function createFakeLspManager(
  cwd: string,
  label: string,
  options: { diagnostics?: Diagnostic[] } = {}
): { manager: LspManagerLike; state: FakeLspState } {
  const state: FakeLspState = {
    requests: [],
    openedFiles: [],
    shutdownCount: 0,
  };
  const location = {
    uri: pathToFileURL(join(cwd, `${label}.ts`)).href,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
  };
  const server: LSPServerInstance = {
    name: label,
    config: {
      command: "fake",
      extensions: [".ts"],
    },
    state: "running",
    async start() {},
    async stop() {},
    isHealthy: () => true,
    async sendRequest<T>(method: string): Promise<T> {
      state.requests.push(method);
      if (method === "workspace/symbol") {
        const result: SymbolInformation[] = [
          {
            name: label,
            kind: 12,
            location,
          },
        ];
        return result as T;
      }
      return null as T;
    },
    async sendNotification() {},
  };

  const manager: LspManagerLike = {
    getServerForFile: () => server,
    async openFile(filePath) {
      state.openedFiles.push(filePath);
    },
    async waitForDiagnostics() {
      return options.diagnostics;
    },
    async syncFileAndGetDiagnostics() {
      return options.diagnostics;
    },
    listServers: () => [
      { name: label, state: "running", extensions: [".ts"] },
    ],
    toAbsolute: (filePath) => join(cwd, filePath),
    async shutdown() {
      state.shutdownCount += 1;
    },
  };

  return { manager, state };
}
