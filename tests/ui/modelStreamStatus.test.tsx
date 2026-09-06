import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ModelStreamStatus } from "../../src/ui/status/ModelStreamStatus.js";
import type {
  UIModelStreamInfo,
  UIModelStreamProgressRef,
} from "../../src/ui/turn/eventStore.js";

describe("ModelStreamStatus", () => {
  test("没有父模型流时显示当前工具活动而不是泛化的思考中", () => {
    const frame = render(
      <ModelStreamStatus
        modelStream={null}
        progressRef={{ current: null }}
        stopping={false}
        activityLabel="正在运行 project-reviewer Agent..."
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("正在运行 project-reviewer Agent...");
    expect(frame).not.toContain("思考中");
  });

  test("从 progress ref 平滑追赶，追平后保持 token 并继续 glyph 动画", async () => {
    const modelStream: UIModelStreamInfo = {
      phase: "reasoning",
      outputCharacters: 4,
      estimatedOutputTokens: 1,
    };
    const progressRef: UIModelStreamProgressRef = {
      current: modelStream,
    };
    const instance = render(
      <ModelStreamStatus
        modelStream={modelStream}
        progressRef={progressRef}
        stopping={false}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(instance.lastFrame()).toContain("正在生成推理");
    expect(instance.lastFrame()).toContain("~1 tokens");

    progressRef.current = {
      ...modelStream,
      outputCharacters: 28,
      estimatedOutputTokens: 7,
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const progressingTokens = Number(
      instance.lastFrame()?.match(/~(\d+) tokens/)?.[1]
    );
    expect(progressingTokens).toBeGreaterThan(1);
    expect(progressingTokens).toBeLessThan(7);

    const deadline = Date.now() + 2_500;
    while (
      !instance.lastFrame()?.includes("~7 tokens") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(instance.lastFrame()).toContain("~7 tokens");

    // token 追平后保持真实值，但独立 spinner 行仍继续产生有界动画帧。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settledFrameCount = instance.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(instance.frames.length).toBeGreaterThan(settledFrameCount);
    expect(instance.lastFrame()).toContain("~7 tokens");
    instance.unmount();
  });

  test("输出停滞重试时显示明确恢复状态", () => {
    const modelStream: UIModelStreamInfo = {
      phase: "retrying",
      outputCharacters: 0,
      estimatedOutputTokens: 0,
    };
    const frame = render(
      <ModelStreamStatus
        modelStream={modelStream}
        progressRef={{ current: modelStream }}
        stopping={false}
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("生成停滞，正在重新请求模型");
  });
});
