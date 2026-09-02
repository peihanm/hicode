export interface Counter {
    value(): number;
    increment(): number;
    decrement(): number;
    reset(): number;
}

export function createCounter(initial = 0): Counter {
    let current = initial;
    return {
        value: () => current,
        increment: () => --current,
        decrement: () => --current,
        reset: () => {
            current = initial;
            return current;
        },
    };
}
