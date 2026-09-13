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
        activityLabel="Running project-reviewer Agent..."
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("Running project-reviewer Agent...");
    expect(frame).not.toContain("Thinking");
  });

  test("展示明确标记的 Token 估算量，无新数据时数值不补涨", async () => {
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
    expect(instance.lastFrame()).toContain("Generating reasoning");
    expect(instance.lastFrame()).toContain("~1 tokens");

    progressRef.current = {
      ...modelStream,
      outputCharacters: 8000,
      estimatedOutputTokens: 2000,
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(instance.lastFrame()).toContain("~2,000 tokens");
    expect(instance.lastFrame()).not.toContain("characters");

    // 没有新数据，只有独立 glyph 动画继续更新。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settledFrameCount = instance.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(instance.frames.length).toBeGreaterThan(settledFrameCount);
    expect(instance.lastFrame()).toContain("~2,000 tokens");
    instance.unmount();
  });

  test("输出停滞重试时显示明确恢复状态", () => {
    const modelStream: UIModelStreamInfo = {
      phase: "retrying",
      outputCharacters: 0,
      estimatedOutputTokens: 0,
      retry: {reason: "output_stall", attempt: 2, maxAttempts: 3},
    };
    const frame = render(
      <ModelStreamStatus
        modelStream={modelStream}
        progressRef={{ current: modelStream }}
        stopping={false}
      />
    ).lastFrame() ?? "";

    expect(frame).toContain("Generation stalled, retrying the model request");
    expect(frame).toContain("2/3");
  });

  test("流损坏重试展示真实原因而不是生成停滞", () => {
    const modelStream: UIModelStreamInfo = {
      phase: "retrying", outputCharacters: 0, estimatedOutputTokens: 0,
      retry: {reason: "invalid_json", attempt: 3, maxAttempts: 3},
    };
    const instance = render(<ModelStreamStatus modelStream={modelStream}
      progressRef={{current: modelStream}} stopping={false} />);
    expect(instance.lastFrame()).toContain("Corrupt response data");
    expect(instance.lastFrame()).toContain("3/3");
    expect(instance.lastFrame()).not.toContain("Generation stalled");
    instance.unmount();
  });
});


test("下一次请求清零计数，停止后隐藏计数", async () => {
    const running: UIModelStreamInfo = {phase: "tool_input", toolName: "write_file", outputCharacters: 4000, estimatedOutputTokens: 1000};
    const progressRef: UIModelStreamProgressRef = {current: running};
    const view = render(<ModelStreamStatus modelStream={running} progressRef={progressRef} stopping={false}/>);
    await new Promise(resolve => setTimeout(resolve, 140));
    expect(view.lastFrame()).toContain("~1,000 tokens");
    const next: UIModelStreamInfo = {phase: "requesting", outputCharacters: 0, estimatedOutputTokens: 0};
    progressRef.current = next;
    view.rerender(<ModelStreamStatus modelStream={next} progressRef={progressRef} stopping={false}/>);
    await new Promise(resolve => setTimeout(resolve, 140));
    expect(view.lastFrame()).toContain("Waiting for model response");
    expect(view.lastFrame()).not.toContain("tokens");
    view.rerender(<ModelStreamStatus modelStream={running} progressRef={progressRef} stopping/>);
    expect(view.lastFrame()).not.toContain("tokens");
    view.unmount();
});
