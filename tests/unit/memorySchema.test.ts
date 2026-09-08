import {expect,test} from "bun:test";
import {parseMemoryNote} from "../../src/memory/note.js";
import {serializeMemoryNote} from "../../src/memory/note.js";
test("note round trip 与坏格式、未知字段和 UTF-8 上限",()=>{
 const note={operation:"remember" as const,type:"feedback" as const,content:"保持简洁"};expect(parseMemoryNote(serializeMemoryNote(note))).toEqual(note);
 for(const raw of ["---\noperation: remember\n---\n内容","---\noperation: remember\ntype: invalid\n---\n内容","---\noperation: remember\ntype: user\nversion: 1\n---\n内容","界".repeat(9000)])expect(()=>parseMemoryNote(raw)).toThrow();
});

test("note 校验错误给出可修复字段，不回显恶意枚举值或字段名",()=>{
 for(const raw of ["---\noperation: SECRET_VALUE\ntype: OTHER_SECRET\n---\n正文", "---\noperation: remember\ntype: user\nSECRET_FIELD: secret\n---\n正文"]){
  try{parseMemoryNote(raw);throw new Error("unexpected success");}catch(error){expect(error).toBeInstanceOf(Error);const message=(error as Error).message;expect(message).not.toContain("SECRET");expect(message.length).toBeLessThan(500);}
 }
});
