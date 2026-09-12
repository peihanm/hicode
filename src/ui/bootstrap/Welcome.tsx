import {Box, Text} from "ink";
import {COLORS} from "../theme.js";
import {useTerminalWidth} from "../terminalSize.js";

const MAX_CONTENT_WIDTH = 58;

// The persistent welcome panel contains branding and minimal usage guidance.
// StatusBar already shows model/cwd; do not duplicate them here.
export function getWelcomeLayout(terminalWidth: number) {
    const contentWidth = Math.min(
        MAX_CONTENT_WIDTH,
        Math.max(1, terminalWidth - 2)
    );
    return {
        contentWidth,
        compact: contentWidth < 48,
    };
}

export function Welcome() {
    const {contentWidth, compact} = getWelcomeLayout(useTerminalWidth());
    const innerWidth = Math.max(1, contentWidth - 6);

    return (
        <Box
            flexDirection="column"
            width={contentWidth}
            borderStyle="double"
            borderColor={COLORS.accent}
            paddingX={2}
            paddingY={1}
        >
            <Box width={innerWidth} justifyContent="space-between">
                <Text color={COLORS.welcome} bold>◆ PILLAR</Text>
                {!compact && <Text color={COLORS.dim}>CODING AGENT</Text>}
            </Box>

            <Text color={COLORS.border}>{"━".repeat(innerWidth)}</Text>

            <Box marginTop={1}>
                <Text color={COLORS.accent} bold>BUILD</Text>
                <Text color={COLORS.dim}>  /  </Text>
                <Text color={COLORS.accent} bold>INSPECT</Text>
                <Text color={COLORS.dim}>  /  </Text>
                <Text color={COLORS.accent} bold>FIX</Text>
                {!compact && (
                    <>
                        <Text color={COLORS.dim}>  /  </Text>
                        <Text color={COLORS.accent} bold>VERIFY</Text>
                    </>
                )}
            </Box>

            {!compact && (
                <Text color={COLORS.dim}>
                    From intent to verified code, inside your terminal.
                </Text>
            )}

            <Box marginTop={1} flexDirection="column">
                <Text><Text color={COLORS.accent} bold>❯</Text> Describe what you want to change</Text>
                <Text><Text color={COLORS.accent} bold>/</Text> Explore commands and workflows</Text>
            </Box>

            <Box marginTop={1}>
                <Text color={COLORS.dim}>
                    <Text color={COLORS.accent}>Enter</Text> send
                    {!compact && (
                        <>
                            {"  ·  "}
                            <Text color={COLORS.accent}>shift+tab</Text> Build/Plan
                        </>
                    )}
                </Text>
            </Box>
        </Box>
    );
}
