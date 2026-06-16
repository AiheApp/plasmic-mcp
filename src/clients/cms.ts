import { env } from "../env.js";

export class PlasmicCmsClient {
  private base: string;

  constructor(
    private readonly databaseId: string,
    private readonly publicToken: string,
    private readonly secretToken?: string,
    cmsHost: string = env.studioHost
  ) {
    this.base = `${cmsHost}/api/v1/cms/databases/${databaseId}`;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    useSecret = false
  ): Promise<T> {
    const token = useSecret ? (this.secretToken ?? this.publicToken) : this.publicToken;
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-plasmic-api-cms-tokens": `${this.databaseId}:${token}`,
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Plasmic CMS API ${res.status} ${res.statusText}: ${body}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async listTables(): Promise<CmsTable[]> {
    const data = await this.request<{ tables: CmsTable[] }>("/tables");
    return data.tables ?? [];
  }

  async queryRows(
    tableIdentifier: string,
    opts: { limit?: number; offset?: number; locale?: string; where?: Record<string, unknown> } = {}
  ): Promise<CmsRowsResult> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("q[limit]", String(opts.limit));
    if (opts.offset !== undefined) params.set("q[offset]", String(opts.offset));
    if (opts.locale) params.set("q[locale]", opts.locale);
    const qs = params.toString();
    return this.request<CmsRowsResult>(`/tables/${tableIdentifier}/rows${qs ? `?${qs}` : ""}`);
  }

  async getRow(tableIdentifier: string, rowId: string): Promise<CmsRow> {
    return this.request<CmsRow>(`/tables/${tableIdentifier}/rows/${rowId}`);
  }

  async createRow(tableIdentifier: string, data: Record<string, unknown>): Promise<CmsRow> {
    if (!this.secretToken) throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
    return this.request<CmsRow>(
      `/tables/${tableIdentifier}/rows`,
      { method: "POST", body: JSON.stringify({ data }) },
      true
    );
  }

  async updateRow(tableIdentifier: string, rowId: string, data: Record<string, unknown>): Promise<CmsRow> {
    if (!this.secretToken) throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
    return this.request<CmsRow>(
      `/tables/${tableIdentifier}/rows/${rowId}`,
      { method: "PATCH", body: JSON.stringify({ data }) },
      true
    );
  }

  async deleteRow(tableIdentifier: string, rowId: string): Promise<void> {
    if (!this.secretToken) throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
    await this.request<void>(
      `/tables/${tableIdentifier}/rows/${rowId}`,
      { method: "DELETE" },
      true
    );
  }
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
