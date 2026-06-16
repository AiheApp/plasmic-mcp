import { env } from "../env.js";
export class PlasmicStudioClient {
    projectId;
    apiUser;
    apiToken;
    base;
    constructor(projectId, apiUser, apiToken, studioHost = env.studioHost) {
        this.projectId = projectId;
        this.apiUser = apiUser;
        this.apiToken = apiToken;
        this.base = `${studioHost}/api/v1`;
    }
    async request(path, options = {}) {
        const url = `${this.base}${path}`;
        const res = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "x-plasmic-api-user": this.apiUser,
                "x-plasmic-api-token": this.apiToken,
                ...options.headers,
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Plasmic Studio API ${res.status} ${res.statusText}: ${body}`);
        }
        return res.json();
    }
    async getProject() {
        return this.request(`/projects/${this.projectId}`);
    }
    async listComponents() {
        const data = await this.request(`/projects/${this.projectId}/components`);
        return data.components ?? [];
    }
    async getProjectBundle(branchId = "main") {
        return this.request(`/projects/${this.projectId}/branches/${branchId}/pkg-version`);
    }
    async listTokens() {
        const data = await this.request(`/projects/${this.projectId}/tokens`);
        return data.tokens ?? [];
    }
    async updateToken(tokenId, value) {
        return this.request(`/projects/${this.projectId}/tokens/${tokenId}`, { method: "PUT", body: JSON.stringify({ value }) });
    }
    async publish() {
        return this.request(`/projects/${this.projectId}/publish`, { method: "POST" });
    }
    async createComponent(name, type, pagePath) {
        return this.request(`/projects/${this.projectId}/components`, {
            method: "POST",
            body: JSON.stringify({
                name,
                type,
                ...(type === "page" && pagePath ? { path: pagePath } : {}),
            }),
        });
    }
}
//# sourceMappingURL=studio.js.map