// Types for playwright.config.ts, which imports this CI helper (#4397).
export declare function parseE2eShard(value: string | undefined): { index: number; total: number } | null;
export declare function chromiumSpecFiles(testDir: string): string[];
export declare function specsForShard(files: readonly string[], shard: { index: number; total: number }): string[];
export declare function exactSpecPatterns(files: readonly string[]): RegExp[];
