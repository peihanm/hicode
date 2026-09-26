import chalk from "chalk";

// Use the same color capability that Ink uses; never force RGB onto a basic terminal.
// Pastel diff backgrounds collapse to indistinguishable gray/white in ANSI-16.
const richColors = chalk.level >= 2;
const accent = richColors ? "#0369A1" : "cyan";

export const COLORS = {
    user: accent,
    assistant: richColors ? "#0E7490" : "cyan",
    toolName: accent,
    toolArgs: "gray",
    toolResult: "gray",
    status: accent,
    prompt: accent,
    error: "red",
    warning: "yellow",
    dim: "gray",
    border: "gray",
    accent,
    welcome: accent,
    surface: richColors ? "#F3F4F6" : "cyan",
    surfaceText: richColors ? "#6B7280" : "black",
    surfaceAccent: richColors ? accent : "black",
    diffAdded: richColors ? "#2E7D32" : "green",
    diffRemoved: richColors ? "#B3261E" : "red",
    diffAddedBackground: richColors ? "#B7E4C7" : "green",
    diffRemovedBackground: richColors ? "#F4C2C2" : "red",
    diffAddedWordBackground: richColors ? "#74C69D" : "green",
    diffRemovedWordBackground: richColors ? "#E5989B" : "red",
    diffText: richColors ? "#202124" : "black",
} as const;

// Shared terminal symbols.
export const SYMBOLS = {
    prompt: "❯",        // Input prompt
    userMark: "❯",      // User message marker
    assistantMark: "●", // Assistant message marker
    spinner: "✻",      // Thinking spinner
    bullet: "•",       // List bullet
    timer: "◷",        // Turn elapsed time
} as const;
