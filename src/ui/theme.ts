// Centralized color theme for consistent ANSI colors and future theme changes.
// Use Ink's color prop rather than raw ANSI escapes.

export const COLORS = {
    user: "#0369A1",
    assistant: "#0E7490",
    toolName: "#0369A1",
    toolArgs: "gray",
    toolResult: "gray",
    status: "#0369A1",
    prompt: "#0369A1",
    error: "red",
    warning: "yellow",
    dim: "gray",
    border: "gray",
    accent: "#0369A1",
    welcome: "#0369A1",
    surface: "#F3F4F6",
    surfaceText: "#6B7280",
    diffAdded: "#2E7D32",
    diffRemoved: "#B3261E",
    diffAddedBackground: "#B7E4C7",
    diffRemovedBackground: "#F4C2C2",
    diffAddedWordBackground: "#74C69D",
    diffRemovedWordBackground: "#E5989B",
    diffText: "#202124",
} as const;

// Visual symbols in the Codebuddy/Claude Code style.
export const SYMBOLS = {
    prompt: "❯",        // Input prompt
    userMark: "❯",      // User message marker
    assistantMark: "●", // Assistant message marker
    spinner: "✻",      // Thinking spinner
    bullet: "•",       // List bullet
    timer: "◷",        // Turn elapsed time
} as const;
