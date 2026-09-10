import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { getWelcomeLayout, Welcome } from "../../src/ui/bootstrap/Welcome.js";

afterEach(() => cleanup());

describe("Welcome", () => {
  test("启动页用完整介绍框展示品牌、定位和入口", () => {
    const frame = render(<Welcome />).lastFrame() ?? "";
    expect(frame).toContain("◆ PILLAR");
    expect(frame).toContain("CODING AGENT");
    expect(frame).toContain("BUILD  /  INSPECT  /  FIX  /  VERIFY");
    expect(frame).toContain("From intent to verified code, inside your terminal.");
    expect(frame).toContain("❯ Describe what you want to change");
    expect(frame).toContain("/ Explore commands and workflows");
    expect(frame).toContain("Enter send  ·  shift+tab Build/Plan");
    expect(frame).not.toContain("? shortcuts");
    expect(frame.split("\n")[0]).toMatch(/^╔═+╗$/);
  });

  test("窄终端进入紧凑布局且保持最小内容宽度", () => {
    expect(getWelcomeLayout(40)).toEqual({contentWidth: 38, compact: true});
    expect(getWelcomeLayout(20)).toEqual({contentWidth: 18, compact: true});
    expect(getWelcomeLayout(80)).toEqual({contentWidth: 58, compact: false});
  });
});
