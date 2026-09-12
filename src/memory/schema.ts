import { z } from "zod";
export const memoryKeySchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters and digits separated by single hyphens only");
