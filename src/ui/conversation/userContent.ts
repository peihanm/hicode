import type {MessageContent} from "../../images/content.js";

/** User-facing labels are local to a message; the original image references stay in History. */
export function userContentText(content: MessageContent): string {
    if (typeof content === "string") return content;
    const labels = content.filter(part => part.type === "image").map((_, index) => `[Image #${index + 1}]`).join(" ");
    const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
    return labels ? `${labels}${text ? ` ${text}` : ""}` : text;
}
