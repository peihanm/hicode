import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  applyBatchToolResultBudget,
  processToolOutput,
} from "../../src/toolResults/index.js";
import {toolFileChanges} from "../../src/toolResults/uiData.js";
import { createFileChange } from "../../src/fileChanges/diff.js";
import type { Message } from "../../src/llm/types.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";

describe("tool result budgets", () => {
  test("Bash 失败 outcome 在预算落盘和配额失败后仍保留", async () => {
    await withTempProject(async cwd => {
      for (const quota of [0, 100_000]) {
        const store = createTestToolResultStore(cwd, `evidence-${quota}`, {maxSessionBytes: quota});
        const output = {content: "failed".repeat(1000), outcome: "failed" as const,
          uiData: {type: "shell_result" as const, receipt: {termination: "exit" as const, outputFailed: false}}};
        const result = await processToolOutput({output, toolName: "bash", toolCallId: "check", maxResultSizeChars: 10, store});
        expect(result.outcome).toBe("failed");
        expect(result.uiData).toEqual({type: "shell_result", receipt: {termination: "exit", outputFailed: quota === 0}});
      }
    });
  });
  test("模型结果预算不会丢弃独立的文件修改 UI 数据", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "ui-data", { hicodeHome: `${cwd}/results` });
      const change = createFileChange({
        path: "a.ts",
        kind: "update",
        oldContent: "const a = 1;\n",
        newContent: "const a = 2;\n",
      });
      const result = await processToolOutput({
        output: {
          content: "x".repeat(1_000),
          uiData: { type: "file_change", change },
        },
        toolName: "edit_file",
        toolCallId: "edit-ui",
        maxResultSizeChars: 10,
        store,
      });
      expect(result.persisted).toBeTruthy();
      expect(result.uiData).toEqual({ type: "file_change", change });
      expect(result.modelContent).not.toContain("const a = 2");
    });
  });
  test("单结果超过工具阈值后落盘", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "budget-a", {
        hicodeHome: join(cwd, "store"),
        previewChars: 10,
      });
      const result = await processToolOutput({
        output: "x".repeat(101),
        toolName: "synthetic",
        toolCallId: "call-a",
        maxResultSizeChars: 100,
        store,
      });
      expect(result.persisted?.complete).toBe(true);
      expect(result.modelContent).toContain("<persisted-output>");
      expect(result.displayContent.length).toBeLessThanOrEqual(10);
    });
  });

  test("批量预算优先持久化最大的 inline 结果", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "budget-b", {
        hicodeHome: join(cwd, "store"),
      });
      const history: Message[] = [
        { role: "tool", tool_call_id: "small", content: "s".repeat(4_000) },
        { role: "tool", tool_call_id: "large", content: "l".repeat(8_000) },
      ];
      const replacements = await applyBatchToolResultBudget({
        history,
        entries: [
          { messageIndex: 0, toolCallId: "small", toolName: "a" },
          { messageIndex: 1, toolCallId: "large", toolName: "b" },
        ],
        store,
        maxChars: 10_000,
      });
      expect(replacements.map((item) => item.toolCallId)).toEqual(["large"]);
      expect(history[0]?.content).toBe("s".repeat(4_000));
      expect(history[1]?.content).toContain("<persisted-output>");
    });
  });

  test("写盘失败时只返回有界 preview，不回退超限原文", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "budget-c", {
        hicodeHome: join(cwd, "store"),
        maxSessionBytes: 0,
        previewChars: 20,
      });
      const result = await processToolOutput({
        output: "q".repeat(10_000),
        toolName: "synthetic",
        toolCallId: "quota-failure",
        maxResultSizeChars: 100,
        store,
      });
      expect(result.outcome).toBe("output_failed");
      expect(result.modelContent).toContain("Operation outcome before output delivery: ok");
      expect(result.persisted).toBeUndefined();
      expect(result.modelContent).toContain("could not be saved");
      expect(result.modelContent.length).toBeLessThan(1_000);
      expect(result.modelContent).not.toContain("q".repeat(100));
    });
  });
});


test("delivery failure preserves committed file changes and non-success outcomes", async () => {
    await withTempProject(async cwd => {
        const store = createTestToolResultStore(cwd, "failed-delivery", {maxSessionBytes: 0});
        const change = createFileChange({path: "a.ts", kind: "update", oldContent: "old", newContent: "new"});
        for (const outcome of ["ok", "failed", "denied", "interrupted"] as const) {
            const result = await processToolOutput({store, toolName: "edit_file", toolCallId: outcome, maxResultSizeChars: 1,
                output: {content: "completed operation output".repeat(100), outcome, uiData: {type: "file_change", change}}});
            expect(result.outcome).toBe(outcome === "ok" ? "output_failed" : outcome);
            expect(result.uiData).toEqual(outcome === "ok" ? {type: "file_change", change} : undefined);
            expect(toolFileChanges(result.uiData, result.outcome)).toEqual(outcome === "ok" ? [change] : []);
            expect(result.modelContent).toContain(`Operation outcome before output delivery: ${outcome}`);
        }
    });
});
