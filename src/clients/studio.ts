import { env } from "../env.js";

export class PlasmicStudioClient {
  private base: string;

  constructor(
    private readonly projectId: string,
    private readonly apiUser: string,
    private readonly apiToken: string,
    studioHost: string = env.studioHost
  ) {
    this.base = `${studioHost}/api/v1`;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-plasmic-api-user": this.apiUser,
        "x-plasmic-api-token": this.apiToken,
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Plasmic Studio API ${res.status} ${res.statusText}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async getProject(): Promise<PlasticProject> {
    return this.request<PlasticProject>(`/projects/${this.projectId}`);
  }

  async listComponents(): Promise<ComponentEntry[]> {
    const data = await this.request<{ components: ComponentEntry[] }>(
      `/projects/${this.projectId}/components`
    );
    return data.components ?? [];
  }

  async getProjectBundle(branchId = "main"): Promise<unknown> {
    return this.request<unknown>(
      `/projects/${this.projectId}/branches/${branchId}/pkg-version`
    );
  }

  async listTokens(): Promise<DesignToken[]> {
    const data = await this.request<{ tokens: DesignToken[] }>(
      `/projects/${this.projectId}/tokens`
    );
    return data.tokens ?? [];
  }

  async updateToken(tokenId: string, value: string): Promise<DesignToken> {
    return this.request<DesignToken>(
      `/projects/${this.projectId}/tokens/${tokenId}`,
      { method: "PUT", body: JSON.stringify({ value }) }
    );
  }

  async publish(): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      `/projects/${this.projectId}/publish`,
      { method: "POST" }
    );
  }

  async createComponent(name: string, type: "page" | "component", pagePath?: string): Promise<ComponentEntry> {
    return this.request<ComponentEntry>(
      `/projects/${this.projectId}/components`,
      {
        method: "POST",
        body: JSON.stringify({
          name,
          type,
          ...(type === "page" && pagePath ? { path: pagePath } : {}),
        }),
      }
    );
  }
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
