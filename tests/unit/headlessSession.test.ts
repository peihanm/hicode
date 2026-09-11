import {expect,test} from "bun:test";
import {prepareThreadSession} from "../../src/sdk/thread.js";
import {loadSession} from "../../src/session/index.js";
import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {runHeadlessForTest} from "../helpers/headless.js";
import {createTestSettings} from "../helpers/runtimeResources.js";

test("CLI 与 SDK 共用 Session seed，恢复时保留来源/模式/工具发现",async()=>withTempProject(async(cwd,storage)=>{
 const resources=createTestRuntimeResources(cwd);
 const fresh=prepareThreadSession(resources);
 expect(fresh.seed.history[0]?.role).toBe("system");expect(fresh.resumed).toBe(false);
 await saveSessionSnapshot(storage,{cwd,sessionId:"resume",model:"glm-test",history:[{role:"user",origin:"user",content:"hello"},{role:"assistant",content:"world"}],todos:[],permissionMode:"ask",collaborationMode:"plan",toolDiscovery:{version:2,loadedNames:["mcp__fixture__echo"]}});
 const loaded=loadSession(storage,cwd,"resume","glm-test")!;
 const restored=prepareThreadSession(resources,loaded);
 expect(restored.seed.sessionId).toBe("resume");expect(restored.state.collaborationMode).toBe("plan");expect(restored.state.permissionMode).toBe("ask");
 expect(restored.seed.toolDiscovery).toEqual(loaded.toolDiscovery);expect(restored.resumed).toBe(true);
}));
test("Headless 在创建 Root 前拒绝 picker 和不存在的恢复目标",async()=>withTempProject(async(cwd)=>{
 for(const resumeMode of [{kind:"picker"},{kind:"continue"},{kind:"session",sessionId:"missing"}] as const){
  await expect(runHeadlessForTest({cwd,settings:createTestSettings(),prompt:"hi",resumeMode,outputFormat:"json"},{createResources:async()=>{throw new Error("should not initialize");}})).rejects.toThrow(resumeMode.kind==="picker"?"headless 模式不能使用交互式":"没有找到可恢复");
 }
}));
