import { env } from "../env.js";

export class PlasmicLoaderClient {
  private base: string;

  constructor(
    private readonly projectId: string,
    private readonly projectToken: string,
    studioHost: string = env.studioHost
  ) {
    this.base = `${studioHost}/api/v1`;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      headers: {
        "x-plasmic-api-project-tokens": `${this.projectId}:${this.projectToken}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Plasmic Loader API ${res.status} ${res.statusText}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async getAllData(preview = false): Promise<LoaderAllData> {
    const params = new URLSearchParams({
      projectIds: this.projectId,
      platform: "react",
      ...(preview ? { preview: "true" } : {}),
    });
    return this.request<LoaderAllData>(`/loader/all?${params}`);
  }

  async getComponentData(componentNameOrPath: string, preview = false): Promise<LoaderAllData> {
    const params = new URLSearchParams({
      projectIds: this.projectId,
      platform: "react",
      componentName: componentNameOrPath,
      ...(preview ? { preview: "true" } : {}),
    });
    return this.request<LoaderAllData>(`/loader/code/component?${params}`);
  }
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
