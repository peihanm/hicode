import {expect,test} from "bun:test";
import {parseMemoryNote} from "../../src/memory/publicationAccess.js";
import {serializeMemoryNote} from "../../src/memory/publicationStore.js";
test("note round trip 与坏格式、未知字段和 UTF-8 上限",()=>{
 const note={operation:"remember" as const,type:"feedback" as const,content:"保持简洁"};expect(parseMemoryNote(serializeMemoryNote(note))).toEqual(note);
 for(const raw of ["---\noperation: remember\n---\n内容","---\noperation: remember\ntype: invalid\n---\n内容","---\noperation: remember\ntype: user\nversion: 1\n---\n内容","界".repeat(9000)])expect(()=>parseMemoryNote(raw)).toThrow();
});
