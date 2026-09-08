import {QWEN_DEFAULT_BASE_URL} from "../llm/providerRegistry.js";
import type {LLMSourceConnection} from "../llm/types.js";

/** Only the V0-tested source/model/endpoint tuple is enabled. */
export function supportsToolImages(source: LLMSourceConnection, model: string): boolean {
    if (source.id !== "qwen" || model !== "qwen3.8-flash") return false;
    try {
        const url = new URL(source.baseUrl || QWEN_DEFAULT_BASE_URL);
        return url.origin === "https://trial.cn-beijing.maas.aliyuncs.com" && !url.search && !url.hash && !url.username && !url.password &&
            ["/compatible-mode/v1", "/compatible-mode/v1/", "/compatible-mode/v1/chat/completions"].includes(url.pathname);
    } catch {return false;}
}
