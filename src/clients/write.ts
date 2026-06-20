export class PlasmicWriteClient {
  constructor(
    private readonly studioHost: string,
    private readonly projectId: string,
    private readonly secretToken: string
  ) {}

  async updateProject(body: WriteProjectBody): Promise<WriteProjectResponse> {
    const res = await fetch(`${this.studioHost}/api/v1/projects/${this.projectId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-plasmic-api-project-tokens": `${this.projectId}:${this.secretToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plasmic Write API ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<WriteProjectResponse>;
  }
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
  newComponents?: Array<{ uuid: string; path?: string; name: string }>;
}
