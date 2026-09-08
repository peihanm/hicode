import { z } from "zod";
export const memoryKeySchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "只能包含小写字母、数字和单个连字符分隔");
