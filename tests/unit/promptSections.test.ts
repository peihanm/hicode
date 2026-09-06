import { describe, expect, test } from "bun:test";
import {
  getDoingTasksSection,
  getToolGuidanceSection,
} from "../../src/prompt/sections.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {VERIFICATION_GUIDANCE} from "../../src/prompt/verification.js";

describe("system prompt task constraints", () => {
  test("没有真实隔离时禁止声称沙盒", () => {
    const content = getDoingTasksSection();

    expect(content).toContain("不得把普通子进程、临时文件或 timeout 称为「沙盒」");
    expect(content).toContain("实际存在且已验证生效的隔离边界");
    expect(content).toContain("代码直接在本机进程执行");
  });

  test("curl 只用于本地 API/HTML 可达性而不是功能测试", () => {
    const content = getDoingTasksSection() + getToolGuidanceSection();

    expect(content).toContain("本地 API 或 HTML 是否可访问");
    expect(content).toContain("少量 GET/HEAD 可达性探测");
    expect(content).toContain("不要用一组临时 curl 请求代替项目测试或浏览器验证");
    expect(content).toContain("不要用 `head -c`、`cut -b` 等按字节截断");
    expect(content).toContain("可能切断 UTF-8 字符");
  });

  test("Root 生产 prompt 保留验证边界，能力不足不扩大验收", () => {
    const content = createInitialHistory("/project", "test-model")[0]!.content ?? "";
    expect(content.split(VERIFICATION_GUIDANCE)).toHaveLength(2);
    expect(content).toContain("项目包含前端不代表本次任务必须打开浏览器");
    expect(content).toContain("项目已有测试可以按其现有流程执行");
    expect(content).toContain("普通任务的收尾不得临时创建");
    expect(content).toContain("先核对已有结果并修正结论");
    expect(content).not.toContain("Verification");
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

  test("Root 默认完成顺序任务，子 Agent 只用于有收益的并行或隔离工作", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("Root 默认亲自完成调查、实现和验证");
    expect(content).toContain("跨多个文件或目录");
    expect(content).toContain("本身都不是委派理由");
    expect(content).toContain("能与 Root 的其他有效工作并行");
    expect(content).toContain("若 Root 必须等待结果才能继续");
    expect(content).toContain("GeneralPurpose 默认不自动使用");
    expect(content).toContain("它是前台串行 Agent");
    expect(content).toContain("不要把整个已批准计划转交给它");
    expect(content).toContain("委派后不要重复同一调查");
    expect(content).not.toContain("3 个以上文件、2 个以上目录或 3 次以上查询");
    expect(content).not.toContain("必须先用 agent 启动 Explore");
    expect(content.indexOf("Root 默认亲自完成")).toBeLessThan(
      content.indexOf("搜索代码位置、符号名")
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

  test("普通修改由主 Agent 验证，独立复查使用实际可用子 Agent", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("日常验证由你直接完成");
    expect(content).toContain("当前清单中可用的子 Agent");
    expect(content).toContain("要求返回发现、证据和未检查范围");
    expect(content).not.toContain("Verification");
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
