import {z} from "zod";

export const agentNameSchema = z.string().trim().min(1).max(64).regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "Must start with a letter and contain only letters, digits, - and _"
);
export const agentDescriptionSchema = z.string().trim().min(1).max(500);
export const agentPromptSchema = z.string().trim().min(1).max(40_000);
