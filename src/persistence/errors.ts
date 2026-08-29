export function hasFileSystemErrorCode(
    error: unknown,
    code: string
): error is {code: string} {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as {code?: string}).code === code
    );
}
