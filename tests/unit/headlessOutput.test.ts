import {expect, test} from "bun:test";
import {buildHeadlessRunSummary, formatHeadlessOutput, formatHeadlessCliError, formatHeadlessProgress} from "../../src/headless/output.js";
import type {TurnResult} from "../../src/sdk/types.js";
const completed: TurnResult = {threadId:"session",turnId:"turn",items:[],finalResponse:"done",stopReason:"completed",iterations:1,durationMs:0,usage:null};
test("Headless 使用 SDK TurnResult，历史工具失败不改运行退出状态", () => {
 const result = buildHeadlessRunSummary({...completed, items:[
  {id:"failed",type:"tool_call",status:"failed",toolCallId:"failed",name:"bash",category:"command",arguments:{command:"false"},outcome:"failed"},
  {id:"retry",type:"tool_call",status:"completed",toolCallId:"retry",name:"bash",category:"command",arguments:{command:"true"},outcome:"ok"},
 ]});
 expect(result.exitCode).toBe(0); expect(result.items).toHaveLength(2);
 expect(formatHeadlessOutput(result,"text")).toBe("done");
 expect(JSON.parse(formatHeadlessOutput(result,"json")).items[0].outcome).toBe("failed");
});
test.each([["interrupted",130],["max_turns",3],["permission_denied",2],["hook_blocked",2],["hook_error",2],["hook_limit",2]] as const)("运行停止 %s 保留退出码",(stopReason,exitCode)=>{
 const summary=buildHeadlessRunSummary({...completed,stopReason});expect(summary.exitCode).toBe(exitCode);expect(summary.ok).toBe(false);
 expect(formatHeadlessOutput(summary,"text")).toContain(stopReason);
});
test("异常输出与 SDK 事件预览使用真实字段",()=>{
 expect(formatHeadlessCliError(new Error("oops"),"json")).toContain('"exitCode": 1');
 expect(formatHeadlessProgress({type:"item.started",threadId:"s",turnId:"t",sequence:1,protocolVersion:1,emittedAt:"now",item:{id:"c",type:"tool_call",status:"in_progress",toolCallId:"c",name:"bash",category:"command",arguments:{command:"echo npm test"}}})).toContain("echo npm test");
});
