import { describe, expect, test } from "bun:test";
import {
  getDoingTasksSection,
  getToolGuidanceSection,
} from "../../src/prompt/sections.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {VERIFICATION_GUIDANCE} from "../../src/prompt/verification.js";

describe("system prompt task constraints", () => {
  test("生产 Prompt 承认会话持续授权，且不替代执行层审批", () => {
    const content = createInitialHistory("/project", "test-model")[0]!.content ?? "";
    expect(content).toContain("当前会话已明确的持续授权在指定范围内有效");
    expect(content).toContain("一次性批准不扩展为其他任务的长期授权");
    expect(content).toContain("用户撤回或改变范围时遵循最新指令");
    expect(content).toContain("不会自动修改工具权限或替代 Runtime 审批");
    expect(content).toContain("这不授权停止任意系统进程或删除 Worktree");
    expect(content).toContain("Push 前核对分支、远端和待推送提交均在授权范围内");
    expect(content).not.toContain("否则总是先确认");
    expect(content).not.toContain("CLAUDE.md");
  });
  test("生产 Prompt 约束无依据重写，并要求验证前提与结论直接对应", () => {
    const content = createInitialHistory("/project", "test-model")[0]!.content ?? "";
    expect(content).toContain("尚未满足的用户要求、明确的代码缺陷或新的测试/观察证据");
    expect(content).toContain("构建通过不等于功能完成");
    expect(content).toContain("停止依赖该前提的检查并标为未验证；独立检查可以继续");
    expect(content).toContain("整页截图变化不能证明特定模型旋转");
    expect(content).toContain("前提失败后撤回依赖它的结论");
    expect(content).toContain("异常时及时退出并关闭脚本创建的连接");
    expect(content).toContain("只有用户明确要求建设该基础设施时");
  });
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
    expect(content).toContain("宿主工具、MCP 或已接入的 Skill");
    expect(content).toContain("没有浏览器入口或入口不可用时，停止该验证分支");
    expect(content).toContain("不要自行搜寻本机浏览器");
    expect(content).toContain("最终说明真实浏览器交互未验证");
    expect(content).toContain("项目已有 E2E 可按其现有流程执行");
    expect(content).toContain("只有用户明确要求搭建浏览器自动化或 E2E 基础设施时");
    expect(content).toContain("『网页项目』『实际运行』『验证核心玩法』均不构成该要求");
    expect(content).toContain("web_fetch 只读取正文，不提供搜索引擎或浏览器操作");
    expect(content.indexOf("先按已提供的能力")).toBeLessThan(content.indexOf("只围绕用户原始要求"));
    expect(content).not.toContain("普通任务的收尾不得");
    expect(content).not.toContain("仅当该验证是原始目标的必要条件时继续聚焦排查");
    expect(content).toContain("先核对已有结果并修正结论");
    expect(content).not.toContain("Verification");
  });

  test("普通文件一次完整读取，只有定点或超限读取才分页", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("省略 offset/limit");
    expect(content).toContain("不要人为切成小页连续扫描");
    expect(content).toContain("只有已知目标行段或文件超过单次读取上限时");
  });

  test("完整逻辑修改可批量提交，入口验证前置", () => {
    const content = getToolGuidanceSection();

    expect(content).toContain("一次 edit_file 的 edits 数组");
    expect(content).toContain("同一已读原版本");
    expect(content).toContain("先跑通最小入口和关键行为");
    expect(content).not.toContain("8000 字符");
    expect(content).toContain("写入顺序执行");
    expect(content).toContain("不保证整批回滚");
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
    expect(content).toContain("Commit 和 Push 分别需要用户明确授权");
    expect(content).toContain("git add -- <精确路径...>");
    expect(content).toContain("不得使用 git add .、git add -A、跳过 Hook");
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
