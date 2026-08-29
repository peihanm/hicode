import type {VerificationVerdict} from "../../types.js";

const VERDICT_PATTERN = /^VERDICT: (PASS|FAIL|PARTIAL)$/gm;
const SUMMARY_PATTERN = /^SUMMARY:\s*(.+)$/gm;
const MAX_SUMMARY_LENGTH = 220;

export function parseVerificationVerdict(
    report: string
): VerificationVerdict | undefined {
    let verdict: VerificationVerdict | undefined;
    for (const match of report.matchAll(VERDICT_PATTERN)) {
        verdict = match[1] as VerificationVerdict;
    }
    return verdict;
}

function cleanSummaryLine(line: string): string {
    return line
        .replace(/^\s*[-*]\s*/, "")
        .replace(/^(?:✅|❌|⚠️)\s*/, "")
        .replace(/^\*\*(.+)\*\*$/, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateSummary(summary: string): string {
    return summary.length > MAX_SUMMARY_LENGTH
        ? `${summary.slice(0, MAX_SUMMARY_LENGTH)}...`
        : summary;
}

function sectionPatterns(verdict: VerificationVerdict): RegExp[] {
    if (verdict === "FAIL") {
        return [/关键缺陷/i, /阻塞问题/i, /失败(?:原因|依据)?/i, /FAIL\s*依据/i];
    }
    if (verdict === "PARTIAL") {
        return [/未验证/i, /验证缺口/i, /受限|限制/i];
    }
    return [/已验证/i, /验证结果/i, /通过(?:项|证据)?/i];
}

/**
 * 返回适合折叠 TUI 的单行验证结论。新报告使用 SUMMARY 协议；旧报告
 * 或模型漏写协议时，从与 verdict 对应的章节提取首条正文。
 */
export function parseVerificationSummary(
    report: string,
    verdict: VerificationVerdict
): string {
    let explicit: string | undefined;
    for (const match of report.matchAll(SUMMARY_PATTERN)) {
        explicit = cleanSummaryLine(match[1] ?? "");
    }
    if (explicit) return truncateSummary(explicit);

    const lines = report.split(/\r?\n/);
    const patterns = sectionPatterns(verdict);
    const headingIndex = lines.findIndex((line) => {
        const heading = line.replace(/^\s*#{1,6}\s*/, "").trim();
        return patterns.some((pattern) => pattern.test(heading));
    });
    if (headingIndex >= 0) {
        for (const line of lines.slice(headingIndex + 1)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("```") || /^#{1,6}\s/.test(trimmed)) {
                if (/^#{1,6}\s/.test(trimmed)) break;
                continue;
            }
            if (trimmed.startsWith("VERDICT:")) break;
            const summary = cleanSummaryLine(trimmed);
            if (summary) return truncateSummary(summary);
        }
    }

    if (verdict === "FAIL") {
        return "独立验证发现阻塞问题；按 Ctrl+O 查看完整报告";
    }
    if (verdict === "PARTIAL") {
        return "部分关键路径缺少独立验证证据；按 Ctrl+O 查看完整报告";
    }
    return "关键路径已获得独立验证证据";
}
