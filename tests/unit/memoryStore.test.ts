import {expect,test} from "bun:test";
import {writeFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {withTempProject} from "../helpers/tempProject.js";
test("旧 Markdown 留存但不加载，损坏的新发布版本 fail closed",async()=>withTempProject(async(cwd,storage)=>{
 const store=new MemoryPublicationStore(storage,cwd);await mkdir(store.directory,{recursive:true});await writeFile(join(store.directory,"legacy.md"),"旧正文");expect(store.snapshot().sources).toEqual([]);
 await writeFile(join(store.directory,"publication.json"),"{broken");expect(()=>store.snapshot()).toThrow("JSON");
}));
