import {memo, useEffect, useState} from "react";
import {Box, Text} from "ink";
import type {UIModelStreamInfo, UIModelStreamProgressRef,} from "../turn/eventStore.js";
import {COLORS} from "../theme.js";
import type {LLMRetryInfo} from "../../llm/types.js";

const RETRY_REASONS: Record<LLMRetryInfo["reason"], string> = {
    connection: "Connection failed",
    http: "Service temporarily unavailable",
    empty_response: "Model returned an empty response",
    output_stall: "Generation stalled",
    stream_disconnected: "Response connection interrupted",
    empty_stream: "No response data received",
    invalid_json: "Corrupt response data",
    protocol: "Incomplete response format",
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
    if (!modelStream) return activityLabel ?? "Thinking...";
    switch (modelStream.phase) {
        case "requesting":
            return "Waiting for model response...";
        case "stalled":
            return "No streaming data yet; the server may still be processing...";
        case "retrying":
            return modelStream.retry
                ? `${RETRY_REASONS[modelStream.retry.reason]}, retrying the model request (${modelStream.retry.attempt}/${modelStream.retry.maxAttempts})...`
                : "Retrying the model request...";
        case "reasoning":
            return "Generating reasoning...";
        case "tool_input":
            return `Building ${modelStream.toolName ?? "tool call"} arguments...`;
        case "content":
            return "Generating response...";
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
        displayedTokens: 0,
        frame: 0,
    });

    useEffect(() => {
        const update = () => {
            setAnimation((current) => {
                const progress = progressRef.current ?? modelStream;
                const displayedTokens = !stopping && progress && progress.outputCharacters > 0
                    ? progress.estimatedOutputTokens
                    : 0;
                return {
                    displayedTokens,
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
        modelStream?.estimatedOutputTokens,
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
                {stopping ? "Stopping..." : streamLabel(modelStream, activityLabel)}
                {!stopping && modelStream && animation.displayedTokens > 0
                    ? ` · ~${animation.displayedTokens.toLocaleString("en-US")} tokens`
                    : ""}
            </Text>
        </Box>
    );
});
