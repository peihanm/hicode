import {expect,test} from "bun:test";
import {parseMemoryTopic,serializeMemoryTopic} from "../../src/memory/topic.js";
test("topics accept plain Markdown or small descriptive headers, never require workflow IDs",()=>{
 const topic={name:"Style",description:"Response style",type:"feedback" as const,content:"保持简洁"};
 expect(parseMemoryTopic(serializeMemoryTopic(topic),"style")).toEqual(topic);
 expect(parseMemoryTopic("# 人工记忆\n\n内容","manual").content).toContain("内容");
 for(const raw of ["", "---\nname: x\n---\nbody", "---\nname: x\ndescription: x\ntype: wrong\n---\nbody", "界".repeat(15000)])expect(()=>parseMemoryTopic(raw,"test")).toThrow();
});
test("bad header errors do not echo secret values",()=>{
 try{parseMemoryTopic("---\nname: x\ndescription: x\ntype: SECRET_VALUE\n---\nbody","test");throw new Error("unexpected success");}catch(error){expect((error as Error).message).not.toContain("SECRET_VALUE");}
});

test("formal and draft topics share header/body constraints", async () => {
 const {memoryDraftTopicSchema} = await import("../../src/memory/publicationSchema.js");
 const {stringify} = await import("yaml");
 const valid={name:"Style",description:"Response style",type:"feedback",content:"Keep it brief"};
 for (const patch of [{name:"bad\nname"},{description:"bad\nsummary"},{description:"界".repeat(101)},{content:""},{content:"界".repeat(11000)},{type:"invalid"}]) {
  const {content,...header}={...valid,...patch};
  expect(()=>parseMemoryTopic(`---\n${stringify(header)}---\n${content}`,"style")).toThrow();
  expect(memoryDraftTopicSchema.safeParse({...header,content,key:"style",sources:[]}).success).toBe(false);
 }
 expect(memoryDraftTopicSchema.safeParse({...valid,key:"style",sources:[]}).success).toBe(true);
 expect(()=>parseMemoryTopic("---\nname: [SECRET_MARKER\n---\nbody","style")).toThrow("Invalid Memory YAML header");
});
