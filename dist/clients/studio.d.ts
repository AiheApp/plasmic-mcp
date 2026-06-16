export declare class PlasmicStudioClient {
    private readonly projectId;
    private readonly apiUser;
    private readonly apiToken;
    private base;
    constructor(projectId: string, apiUser: string, apiToken: string, studioHost?: string);
    private request;
    getProject(): Promise<PlasticProject>;
    listComponents(): Promise<ComponentEntry[]>;
    getProjectBundle(branchId?: string): Promise<unknown>;
    listTokens(): Promise<DesignToken[]>;
    updateToken(tokenId: string, value: string): Promise<DesignToken>;
    publish(): Promise<{
        success: boolean;
    }>;
    createComponent(name: string, type: "page" | "component", pagePath?: string): Promise<ComponentEntry>;
}
export interface PlasticProject {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    workspaceId?: string;
    branches?: BranchEntry[];
}
export interface BranchEntry {
    id: string;
    name: string;
    status: string;
}
export interface ComponentEntry {
    id: string;
    name: string;
    isPage: boolean;
    pagePath?: string;
    projectId?: string;
}
export interface DesignToken {
    id: string;
    name: string;
    value: string;
    type: string;
}
