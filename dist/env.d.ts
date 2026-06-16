export declare const env: {
    studioHost: string;
    apiUser: string | undefined;
    apiToken: string | undefined;
    projectId: string | undefined;
    projectToken: string | undefined;
    cmsDatabaseId: string | undefined;
    cmsPublicToken: string | undefined;
    cmsSecretToken: string | undefined;
};
export declare function requireStudioAuth(): void;
export declare function resolveProjectId(override?: string): string;
export declare function resolveProjectToken(override?: string): string;
export declare function resolveCmsCredentials(databaseIdOverride?: string, publicTokenOverride?: string): {
    databaseId: string;
    publicToken: string;
};
