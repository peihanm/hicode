import {agentNameSchema, agentDescriptionSchema, agentPromptSchema} from "../subagents/definitionSchema.js";
import {z} from "zod";
import {hostMcpServerContributionSchema} from "../mcp/config.js";
import type {HostMcpServerContribution} from "../mcp/types.js";

const MAX_CONTRIBUTIONS_PER_DOMAIN = 64;
const MAX_INLINE_CONTENT_CHARS = 40_000;
const MAX_INSTRUCTION_TOTAL_CHARS = 120_000;
const contributionIdSchema = z.string().trim().min(1).max(128).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Use only letters, digits, dots, - and _, starting with a letter or digit"
);


export interface HostInstructionContribution {
    readonly id: string;
    readonly content: string;
}

export interface HostSkillContribution {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly content: string;
}

export interface HostAgentContribution {
    readonly name: string;
    readonly description: string;
    readonly systemPrompt: string;
    readonly tools?: readonly string[];
    readonly readOnly?: boolean;
}

export interface HiCodeRootContributions {
    readonly instructions?: readonly HostInstructionContribution[];
    readonly skills?: readonly HostSkillContribution[];
    readonly agents?: readonly HostAgentContribution[];
    readonly mcpServers?: readonly HostMcpServerContribution[];
}

const instructionSchema: z.ZodType<HostInstructionContribution> = z.object({
    id: contributionIdSchema,
    content: z.string().trim().min(1).max(MAX_INLINE_CONTENT_CHARS),
}).strict();

const skillSchema: z.ZodType<HostSkillContribution> = z.object({
    name: contributionIdSchema,
    description: z.string().trim().min(1).max(500),
    whenToUse: z.string().trim().min(1).max(500).optional(),
    content: z.string().trim().min(1).max(MAX_INLINE_CONTENT_CHARS),
}).strict();

const agentSchema: z.ZodType<HostAgentContribution> = z.object({
    name: agentNameSchema,
    description: agentDescriptionSchema,
    systemPrompt: agentPromptSchema,
    readOnly: z.boolean().optional(),
    tools: z.array(z.string().trim().min(1).max(128)).min(1).max(128).optional(),
}).strict();

const contributionsSchema: z.ZodType<HiCodeRootContributions> = z.object({
    instructions: z.array(instructionSchema).max(MAX_CONTRIBUTIONS_PER_DOMAIN).optional(),
    skills: z.array(skillSchema).max(MAX_CONTRIBUTIONS_PER_DOMAIN).optional(),
    agents: z.array(agentSchema).max(MAX_CONTRIBUTIONS_PER_DOMAIN).optional(),
    mcpServers: z.array(hostMcpServerContributionSchema)
        .max(MAX_CONTRIBUTIONS_PER_DOMAIN)
        .optional(),
}).strict();

export function normalizeHiCodeRootContributions(
    value: HiCodeRootContributions | undefined
): HiCodeRootContributions {
    const parsed = contributionsSchema.safeParse(value ?? {});
    if (!parsed.success) {
        const problem = parsed.error.issues[0];
        const field = problem?.path.join(".") || "<root>";
        throw new Error(
            `rootContributions.${field}: ${problem?.message ?? "Invalid format"}`
        );
    }
    assertUnique(
        parsed.data.instructions ?? [],
        (item) => item.id,
        "instructions"
    );
    assertUnique(
        parsed.data.skills ?? [],
        (item) => item.name,
        "skills"
    );
    assertUnique(
        parsed.data.agents ?? [],
        (item) => item.name,
        "agents"
    );
    assertUnique(
        parsed.data.mcpServers ?? [],
        (item) => item.name,
        "mcpServers"
    );
    const instructionChars = (parsed.data.instructions ?? []).reduce(
        (total, instruction) => total + instruction.content.length,
        0
    );
    if (instructionChars > MAX_INSTRUCTION_TOTAL_CHARS) {
        throw new Error(
            `Total rootContributions.instructions content exceeds ${MAX_INSTRUCTION_TOTAL_CHARS} character limit`
        );
    }
    return parsed.data;
}

function assertUnique<T>(
    values: readonly T[],
    identify: (value: T) => string,
    domain: string
): void {
    const seen = new Set<string>();
    for (const value of values) {
        const id = identify(value);
        const key = id.toLocaleLowerCase("en-US");
        if (seen.has(key)) {
            throw new Error(`rootContributions.${domain} contains duplicate name ${id}`);
        }
        seen.add(key);
    }
}
