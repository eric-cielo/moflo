export interface MofloInitOptions {
    projectRoot: string;
    force?: boolean;
    skipIndex?: boolean;
    interactive?: boolean;
    minimal?: boolean;
}
export interface MofloInitAnswers {
    guidance: boolean;
    guidanceDirs: string[];
    codeMap: boolean;
    srcDirs: string[];
    tests: boolean;
    testDirs: string[];
    gates: boolean;
    stopHook: boolean;
}
export interface MofloInitResult {
    steps: {
        name: string;
        status: 'created' | 'updated' | 'skipped' | 'error';
        detail?: string;
    }[];
}
/**
 * Discover test directories by checking common locations and walking for
 * colocated __tests__ dirs. Returns relative paths.
 */
export declare function discoverTestDirs(root: string): string[];
export declare function initMoflo(options: MofloInitOptions): Promise<MofloInitResult>;
//# sourceMappingURL=moflo-init.d.ts.map