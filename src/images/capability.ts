import type {LLMSourceConnection} from "../llm/types.js";

/** An explicit model declaration authorizes image encoding; protocol compatibility alone does not. */
export function supportsToolImages(source: LLMSourceConnection, model: string): boolean {
    return source.models?.find(candidate => candidate.id === model)?.imageInput === true;
}
