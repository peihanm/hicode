import { describe, expect, test } from "bun:test";
import {
  getDoingTasksSection,
  getToolGuidanceSection,
} from "../../src/prompt/sections.js";

describe("system prompt task constraints", () => {
  test("没有真实隔离时禁止声称沙盒", () => {
    const content = getDoingTasksSection();

    expect(content).toContain("不得把普通子进程、临时文件或 timeout 称为「沙盒」");
    expect(content).toContain("实际存在且已验证生效的隔离边界");
    expect(content).toContain("代码直接在本机进程执行");
  });

  test("curl 只用于本地 API/HTML 可达性而不是功能测试", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("本地 API 或 HTML 是否可访问");
    expect(content).toContain("少量 GET/HEAD 可达性探测");
    expect(content).toContain("不要用一组临时 curl 请求代替项目测试或浏览器验证");
    expect(content).toContain("不要用 `head -c`、`cut -b` 等按字节截断");
    expect(content).toContain("可能切断 UTF-8 字符");
  });

  test("普通文件一次完整读取，只有定点或超限读取才分页", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("省略 offset/limit");
    expect(content).toContain("不要人为切成小页连续扫描");
    expect(content).toContain("只有已知目标行段或文件超过单次读取上限时");
  });

  test("复杂文件先写可运行骨架并按职责分阶段落盘", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("不要在一个 write_file/edit_file 调用中生成全部实现");
    expect(content).toContain("先写最小可运行骨架");
    expect(content).toContain("单次工具调用新增的文件内容不得超过 8000 字符");
    expect(content).toContain("预计超出时必须继续拆分");
    expect(content).toContain("不要按任意字节机械切块");
    expect(content).toContain("方案和当前步骤明确后立即调用工具落盘");
    expect(content).toContain("可检查、可恢复的文件状态");
  });

  test("开放式代码库问题在第一次搜索前优先委派 Explore", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("在第一次开放式 glob/list_files/grep/read_file 前");
    expect(content).toContain("『这个项目做什么』『深入理解 src』『某功能的完整链路』");
    expect(content).toContain("3 个以上文件、2 个以上目录或 3 次以上查询");
    expect(content).toContain("不要先由 Root 遍历多个目录再委派");
    expect(content).toContain("需要 Explore 结果才能继续回答或实现时使用前台默认模式");
    expect(content).toContain("委派后不要在 Root 重复同一调查");
    expect(content.indexOf("在第一次开放式")).toBeLessThan(
      content.indexOf("搜索文本字面量用 grep")
    );
  });

  test("Git 查询和明确请求的 Commit 都使用 Bash", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("只读的 git status、git diff、git log");
    expect(content).toContain("只有用户明确要求本地 Git 保存/Commit 时");
    expect(content).toContain("git add -- <精确路径...>");
    expect(content).toContain("不得使用 git add .、git add -A、Amend、Push、跳过 Hook");
  });

  test("Bash 子目录和后台服务使用显式受管生命周期", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("每次 bash 调用都是独立进程");
    expect(content).toContain("传 bash.cwd");
    expect(content).toContain("先运行项目已有的最小语法、构建或测试检查");
    expect(content).toContain("确需重启则先 bash_task stop");
    expect(content).toContain("不要重叠启动");
    expect(content).toContain("不要用 lsof/kill 按端口接管");
  });

  test("普通修改由主 Agent 验证，独立 Verification 由模型按需决定", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("先由你自己");
    expect(content).toContain("不要为普通修改启动 Verification");
    expect(content).toContain("Runtime 不会替你自动调度");
    expect(content).not.toContain("自动启动独立 Verification Agent");
  });

  test("主 Agent 按原始成功标准最小验证并停止扩需求", () => {
    const doing = getDoingTasksSection();
    const tools = getToolGuidanceSection();

    expect({
      minimalEvidence: doing.includes("只围绕用户原始要求做最小充分验证"),
      noExpandedMatrix: doing.includes("不要因为自己增加的实现细节而扩展错误矩阵"),
      stopAfterEvidence: doing.includes("覆盖后立即结束"),
      noOpportunisticFix: doing.includes("不阻断原始目标的可选改进时，不要继续修改"),
      noRepeat: doing.includes("不要重复已经获得有效证据的检查"),
      truthfulClaims: doing.includes("不要把一个成功路径概括成『全部验证通过』"),
      transientPort: tools.includes("不要仅为验证修改项目默认端口"),
    }).toEqual({
      minimalEvidence: true,
      noExpandedMatrix: true,
      stopAfterEvidence: true,
      noOpportunisticFix: true,
      noRepeat: true,
      truthfulClaims: true,
      transientPort: true,
    });
  });
});
