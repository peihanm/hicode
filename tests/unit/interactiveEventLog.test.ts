import {expect, test} from "bun:test";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInteractiveEventLog} from "../../src/cli/interactiveEventLog.js";

test("interactive export preserves event order and refuses overwrite or workspace targets", () => {
    const root=mkdtempSync(join(tmpdir(),"hicode-events-"));
    try {
        const cwd=join(root,"project");mkdirSync(cwd);
        const path=join(root,"events.jsonl");
        let failed=false;
        const log=createInteractiveEventLog(path,cwd,()=>{failed=true;});
        log.emit({type:"ready",sessionId:"test"});
        log.emit({type:"agent_event",sessionId:"test",event:{type:"assistant_text",content:"你好"}});
        log.emit({type:"settled",sessionId:"test",reason:"completed",status:"completed",persistenceStatus:"saved",runningAgents:0,pendingAgentMessages:0});
        log.close();log.close();log.emit({type:"ready",sessionId:"ignored"});
        const records=readFileSync(path,"utf8").trim().split("\n").map(line=>JSON.parse(line));
        expect(records.map(r=>r.sequence)).toEqual([1,2,3]);
        expect(records[1].event.content).toBe("你好");expect(failed).toBe(false);
        expect(statSync(path).mode&0o777).toBe(0o600);
        expect(()=>createInteractiveEventLog(path,cwd,()=>{})).toThrow();
        expect(()=>createInteractiveEventLog(join(cwd,"events"),cwd,()=>{})).toThrow("outside");
        const target=join(root,"existing");writeFileSync(target,"keep");symlinkSync(target,join(root,"link"));
        expect(()=>createInteractiveEventLog(join(root,"link"),cwd,()=>{})).toThrow();
        expect(readFileSync(target,"utf8")).toBe("keep");
    } finally {rmSync(root,{recursive:true,force:true});}
});
