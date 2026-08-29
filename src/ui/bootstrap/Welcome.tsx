import {Box, Text, useStdout} from "ink";
import {COLORS} from "../theme.js";

const MAX_CARD_WIDTH = 56;
const MIN_CARD_WIDTH = 32;

// 启动欢迎屏只负责品牌和最小使用引导。
// model/cwd 已由 StatusBar 展示，这里不重复占用视觉空间。
export function getWelcomeLayout(terminalWidth: number) {
    const cardWidth = Math.min(
        MAX_CARD_WIDTH,
        Math.max(MIN_CARD_WIDTH, terminalWidth - 2)
    );
    return {cardWidth, compact: cardWidth < 48};
}

export function Welcome() {
        const {stdout} = useStdout();
        const {cardWidth, compact} = getWelcomeLayout(stdout?.columns ?? 80);

        return (
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={COLORS.border}
                paddingX={2}
                paddingY={1}
                width={cardWidth}
            >
                <Box alignItems="center">
                    <Text color={COLORS.welcome} bold>
                        ◆ pillar
                    </Text>
                    <Text color={COLORS.dim}>
                        {compact ? " · 终端编程助手" : " · terminal pillar agent"}
                    </Text>
                </Box>

                {!compact && (
                    <Box marginTop={1}>
                        <Text>把想做的事交给我，我们从代码开始。</Text>
                    </Box>
                )}

                <Box marginTop={1} flexDirection="column">
                    <Text>
                        <Text color={COLORS.accent} bold>
                            ❯
                        </Text>
                        <Text> 描述任务，开始协作</Text>
                    </Text>
                    <Text>
                        <Text color={COLORS.accent} bold>
                            /
                        </Text>
                        <Text> 浏览命令与工作模式</Text>
                    </Text>
                </Box>

                <Box marginTop={1}>
                    <Text color={COLORS.dim}>
                        <Text color={COLORS.accent}>Enter</Text> 发送
                        {!compact && (
                            <>
                                {"  ·  "}
                                <Text color={COLORS.accent}>/</Text> 命令
                            </>
                        )}
                        {"  ·  "}
                        <Text color={COLORS.accent}>exit</Text> 退出
                    </Text>
                </Box>
            </Box>
        );
}
