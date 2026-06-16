export declare class PlasmicCmsClient {
    private readonly databaseId;
    private readonly publicToken;
    private readonly secretToken?;
    private base;
    constructor(databaseId: string, publicToken: string, secretToken?: string | undefined, cmsHost?: string);
    private request;
    listTables(): Promise<CmsTable[]>;
    queryRows(tableIdentifier: string, opts?: {
        limit?: number;
        offset?: number;
        locale?: string;
        where?: Record<string, unknown>;
    }): Promise<CmsRowsResult>;
    getRow(tableIdentifier: string, rowId: string): Promise<CmsRow>;
    createRow(tableIdentifier: string, data: Record<string, unknown>): Promise<CmsRow>;
    updateRow(tableIdentifier: string, rowId: string, data: Record<string, unknown>): Promise<CmsRow>;
    deleteRow(tableIdentifier: string, rowId: string): Promise<void>;
}
export interface CmsTable {
    identifier: string;
    name: string;
    schema?: {
        fields?: CmsField[];
    };
}
export interface CmsField {
    identifier: string;
    name: string;
    type: string;
    required?: boolean;
}
export interface CmsRow {
    id: string;
    identifier?: string;
    createdAt?: string;
    updatedAt?: string;
    publishedAt?: string;
    data: Record<string, unknown>;
}
export interface CmsRowsResult {
    rows: CmsRow[];
    total?: number;
    limit?: number;
    offset?: number;
}
