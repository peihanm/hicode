// 颜色主题：统一管理 ANSI 颜色，方便以后改主题
// 用 ink 的 color prop，不直接写 ANSI 转义码

export const COLORS = {
    user: "#A0522D",
    assistant: "#A0522D",
    toolName: "#A0522D",
    toolArgs: "gray",
    toolResult: "gray",
    status: "#A0522D",
    prompt: "#A0522D",
    confirm: "yellow",
    error: "red",
    warning: "yellow",
    dim: "gray",
    border: "#A0522D",
    accent: "#A0522D",
    welcome: "#A0522D",
    diffAdded: "#2E7D32",
    diffRemoved: "#B3261E",
    diffAddedBackground: "#B7E4C7",
    diffRemovedBackground: "#F4C2C2",
    diffAddedWordBackground: "#74C69D",
    diffRemovedWordBackground: "#E5989B",
    diffText: "#202124",
} as const;

// 视觉符号常量：codebuddy/claude code 风格
export const SYMBOLS = {
    prompt: "❯",        // 输入框提示符
    userMark: "❯",      // 用户消息标记
    assistantMark: "●", // assistant 消息标记
    spinner: "✻",      // 思考中 spinner
    bullet: "•",       // 列表项
    timer: "◷",        // turn 耗时
} as const;
