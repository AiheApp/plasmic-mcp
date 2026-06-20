export declare class PlasmicWriteClient {
    private readonly studioHost;
    private readonly projectId;
    private readonly secretToken;
    constructor(studioHost: string, projectId: string, secretToken: string);
    updateProject(body: WriteProjectBody): Promise<WriteProjectResponse>;
}
export interface ComponentBody {
    type: string;
    children?: ComponentBody[];
    value?: string;
    [key: string]: unknown;
}
export interface NewComponentSpec {
    name: string;
    path?: string;
    body?: ComponentBody;
}
export interface UpdateComponentSpec {
    byUuid?: string;
    name?: string;
    path?: string;
    body?: ComponentBody;
}
export interface TokenSpec {
    name: string;
    value: string;
    type: "Color" | "Spacing" | "Opacity" | "LineHeight" | "FontFamily" | "FontSize" | "BoxShadow";
}
export interface WriteProjectBody {
    newComponents?: NewComponentSpec[];
    updateComponents?: UpdateComponentSpec[];
    tokens?: TokenSpec[];
}
export interface WriteProjectResponse {
    newComponents?: Array<{
        uuid: string;
        path?: string;
        name: string;
    }>;
}
