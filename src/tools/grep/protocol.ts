export interface SearchRequest {
    content: string;
    pattern: string;
    ignoreCase: boolean;
    multiline: boolean;
    offset: number;
    limit: number;
}

export interface SearchHit {
    line: number;
    start: number;
    end: number;
    match: number;
}

export type SearchResponse =
    | {kind: "matches"; count: number; hits: SearchHit[]}
    | {kind: "invalid_pattern"; message: string};
