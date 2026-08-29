import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { getWelcomeLayout, Welcome } from "../../src/ui/bootstrap/Welcome.js";

afterEach(() => cleanup());

describe("Welcome", () => {
  test("宽屏显示完整品牌、说明和快捷键", () => {
    const frame = render(<Welcome />).lastFrame() ?? "";
    expect(frame).toContain("◆ pillar · terminal pillar agent");
    expect(frame).toContain("把想做的事交给我，我们从代码开始。");
    expect(frame).toContain("Enter 发送  ·  / 命令  ·  exit 退出");
    expect(frame.split("\n")[0]).toBe(
      "╭──────────────────────────────────────────────────────╮"
    );
  });

  test("窄终端进入紧凑布局且保持最小卡片宽度", () => {
    expect(getWelcomeLayout(40)).toEqual({cardWidth: 38, compact: true});
    expect(getWelcomeLayout(20)).toEqual({cardWidth: 32, compact: true});
    expect(getWelcomeLayout(80)).toEqual({cardWidth: 56, compact: false});
  });
});
