export declare class PlasmicLoaderClient {
    private readonly projectId;
    private readonly projectToken;
    private base;
    constructor(projectId: string, projectToken: string, studioHost?: string);
    private request;
    getAllData(preview?: boolean): Promise<LoaderAllData>;
    getComponentData(componentNameOrPath: string, preview?: boolean): Promise<LoaderAllData>;
    getProjectModel(preview?: boolean): Promise<ProjectModel>;
}
export interface ProjectModel {
    site: {
        __iid: number;
        __type: "Site";
        components?: ProjectModelComponent[];
        styleTokens?: unknown[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export interface ProjectModelComponent {
    __iid: number;
    __type: "Component";
    uuid?: string;
    name?: string;
    tplTree?: unknown;
    params?: unknown[];
    states?: unknown[];
    [key: string]: unknown;
}
export interface LoaderComponent {
    id: string;
    name: string;
    displayName?: string;
    projectId: string;
    isPage: boolean;
    path?: string;
    cssFile?: string;
    entry?: string;
    usedComponents?: string[];
    metadata?: Record<string, string>;
}
export interface LoaderProject {
    id: string;
    token: string;
    version?: string;
}
export interface LoaderAllData {
    components: LoaderComponent[];
    globalGroups: unknown[];
    projects: LoaderProject[];
    modules?: {
        browser?: unknown[];
        server?: unknown[];
    };
    external?: string[];
    activeSplits?: unknown[];
}
