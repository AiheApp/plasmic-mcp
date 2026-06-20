export declare const env: {
    readonly studioHost: string;
    readonly chromeDebugUrl: string;
    readonly projectId: string | undefined;
    readonly email: string | undefined;
    readonly password: string | undefined;
};
export declare function resolveProjectId(override?: string): string;
