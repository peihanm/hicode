import {memo, useEffect, useState} from "react";
import {Box, Text} from "ink";
import type {UIModelStreamInfo, UIModelStreamProgressRef,} from "../turn/eventStore.js";
import {COLORS} from "../theme.js";
import type {LLMRetryInfo} from "../../llm/types.js";

const RETRY_REASONS: Record<LLMRetryInfo["reason"], string> = {
    connection: "连接失败",
    http: "服务暂时不可用",
    empty_response: "模型返回空回复",
    output_stall: "生成停滞",
    stream_disconnected: "响应连接中断",
    empty_stream: "未收到响应数据",
    invalid_json: "响应数据损坏",
    protocol: "响应格式不完整",
};

const DEFAULT_ANIMATION_INTERVAL_MS = 120;
const BASE_SPINNER_FRAMES =
    process.env.TERM === "xterm-ghostty"
        ? ["·", "✢", "✳", "✶", "✻", "*"]
        : process.platform === "darwin"
            ? ["·", "✢", "✳", "✶", "✻", "✽"]
            : ["·", "✢", "*", "✶", "✻", "✽"];
const SPINNER_FRAMES = [
    ...BASE_SPINNER_FRAMES,
    ...[...BASE_SPINNER_FRAMES].reverse(),
];

function streamLabel(
    modelStream: UIModelStreamInfo | null,
    activityLabel?: string
): string {
    if (!modelStream) return activityLabel ?? "思考中...";
    switch (modelStream.phase) {
        case "requesting":
            return "等待模型响应...";
        case "stalled":
            return "模型暂无流数据，可能仍在服务端处理...";
        case "retrying":
            return modelStream.retry
                ? `${RETRY_REASONS[modelStream.retry.reason]}，正在重新请求模型（${modelStream.retry.attempt}/${modelStream.retry.maxAttempts}）...`
                : "正在重新请求模型...";
        case "reasoning":
            return "正在生成推理...";
        case "tool_input":
            return `正在构造 ${modelStream.toolName ?? "工具调用"} 参数...`;
        case "content":
            return "正在生成回复...";
    }
}

export const ModelStreamStatus = memo(function ModelStreamStatus({
                                                                     modelStream,
                                                                     progressRef,
                                                                     stopping,
                                                                     activityLabel,
                                                                 }: {
    modelStream: UIModelStreamInfo | null;
    progressRef: UIModelStreamProgressRef;
    stopping: boolean;
    activityLabel?: string;
}) {
    const [animation, setAnimation] = useState({
        displayedCharacters: 0,
        frame: 0,
    });

    useEffect(() => {
        const update = () => {
            setAnimation((current) => {
                const displayedCharacters = stopping
                    ? 0
                    : (progressRef.current?.outputCharacters ?? modelStream?.outputCharacters ?? 0);
                return {
                    displayedCharacters,
                    frame: current.frame + 1,
                };
            });
        };
        update();
        const timer = setInterval(update, DEFAULT_ANIMATION_INTERVAL_MS);
        timer.unref?.();
        return () => clearInterval(timer);
    }, [
        modelStream?.outputCharacters,
        modelStream?.phase,
        modelStream?.toolName,
        progressRef,
        stopping,
    ]);

    const spinner = SPINNER_FRAMES[animation.frame % SPINNER_FRAMES.length];

    return (
        <Box marginTop={1}>
            <Box width={2}>
                <Text color={COLORS.assistant}>{spinner}</Text>
            </Box>
            <Text color={COLORS.dim}>
                {stopping ? "正在停止..." : streamLabel(modelStream, activityLabel)}
                {!stopping && modelStream && animation.displayedCharacters > 0
                    ? ` · ${animation.displayedCharacters} 字符`
                    : ""}
            </Text>
        </Box>
    );
});
