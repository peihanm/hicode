export function hasFileSystemErrorCode(
    error: unknown,
    code: string
): error is {code: string} {
    return (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === code
    );
}
