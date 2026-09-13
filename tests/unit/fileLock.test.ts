import {expect, test} from "bun:test";
import {mkdir, readFile, stat, symlink, utimes, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {withFileLock} from "../../src/persistence/fileLock.js";
import {withTempProject} from "../helpers/tempProject.js";
const source = resolve(import.meta.dir, "../../src/persistence/fileLock.ts");

test("serializes competing actions and releases on failure", async () => {
    await withTempProject(async cwd => {
        const path=join(cwd,"state.lock"); let active=0,max=0;
        await Promise.all(Array.from({length:12},()=>withFileLock(path,async()=>{
            max=Math.max(max,++active); await new Promise(r=>setTimeout(r,2)); --active;
        })));
        expect(max).toBe(1);
        await expect(withFileLock(path,async()=>{throw new Error("action failed");})).rejects.toThrow("action failed");
        await expect(stat(path)).rejects.toMatchObject({code:"ENOENT"});
    });
});

test("a dead recovery guard cannot block a new directory lease", async () => {
    await withTempProject(async cwd => {
        const path=join(cwd,"state.lock");
        await writeFile(`${path}.recovery`,"recovering\n");
        await mkdir(path); await utimes(path,new Date(0),new Date(0));
        expect(await withFileLock(path,async()=>"ok")).toBe("ok");
    });
});

test("recovers a killed process without stealing a live lease", async () => {
    await withTempProject(async cwd => {
        const path=join(cwd,"state.lock");
        const code=`import {withFileLock} from ${JSON.stringify(source)}; await withFileLock(${JSON.stringify(path)},async()=>{console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});});`;
        const child=Bun.spawn([process.execPath,"--no-env-file","-e",code],{stdout:"pipe",stderr:"pipe"});
        const reader=child.stdout.getReader();
        try {
            expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
            await utimes(path,new Date(0),new Date(0));
            await expect(withFileLock(path,async()=>"never")).rejects.toThrow("Timed out");
            child.kill("SIGKILL"); await child.exited;
            expect(await withFileLock(path,async()=>"recovered")).toBe("recovered");
        } finally {child.kill();await child.exited;reader.releaseLock();}
    });
},6000);

test("real processes never overlap and preserve all updates", async()=>{
    await withTempProject(async cwd=>{
        const counter=join(cwd,"count"); await writeFile(counter,"0");
        const code=`import {withFileLock} from ${JSON.stringify(source)};import{readFile,writeFile}from'node:fs/promises';for(let i=0;i<15;i++)await withFileLock(${JSON.stringify(join(cwd,"state.lock"))},async()=>{const n=Number(await readFile(${JSON.stringify(counter)},'utf8'));await writeFile(${JSON.stringify(counter)},String(n+1));});`;
        const children=Array.from({length:4},()=>Bun.spawn([process.execPath,"--no-env-file","-e",code],{stdout:"pipe",stderr:"pipe"}));
        expect(await Promise.all(children.map(child=>child.exited))).toEqual([0,0,0,0]);
        expect(await readFile(counter,"utf8")).toBe("60");
    });
});

test("rejects symlink and unknown owner entries without deleting them",async()=>{
    await withTempProject(async cwd=>{
        const target=join(cwd,"target"),path=join(cwd,"state.lock");await mkdir(target);await symlink(target,path);
        await expect(withFileLock(path,async()=>{})).rejects.toThrow("Unsafe");
        const other=join(cwd,"other.lock");await mkdir(other);await writeFile(join(other,"unknown"),"keep");
        await expect(withFileLock(other,async()=>{})).rejects.toThrow("Invalid");
        expect(await readFile(join(other,"unknown"),"utf8")).toBe("keep");
    });
});
