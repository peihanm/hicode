export function trimIncompleteUtf8(buffer: Buffer): Buffer {
    if (buffer.length === 0) return buffer;
    let leadIndex = buffer.length - 1;
    while (leadIndex >= 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex--;
    if (leadIndex < 0) return Buffer.alloc(0);
    const lead = buffer[leadIndex]!;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    const available = buffer.length - leadIndex;
    return available < expected ? buffer.subarray(0, leadIndex) : buffer;
}

export function selectUtf8Range(
    buffer: Buffer,
    limit: number
): { content: Buffer; startAdjustment: number } {
    let startAdjustment = 0;
    while (
        startAdjustment < buffer.length &&
        (buffer[startAdjustment]! & 0xc0) === 0x80
        ) {
        startAdjustment += 1;
    }
    let desiredEnd = Math.min(buffer.length, startAdjustment + limit);
    let content = trimIncompleteUtf8(
        buffer.subarray(startAdjustment, desiredEnd)
    );
    while (content.length === 0 && desiredEnd < buffer.length) {
        desiredEnd += 1;
        content = trimIncompleteUtf8(buffer.subarray(startAdjustment, desiredEnd));
    }
    return {content, startAdjustment};
}
