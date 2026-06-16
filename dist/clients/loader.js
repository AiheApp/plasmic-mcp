import { env } from "../env.js";
export class PlasmicLoaderClient {
    projectId;
    projectToken;
    base;
    constructor(projectId, projectToken, studioHost = env.studioHost) {
        this.projectId = projectId;
        this.projectToken = projectToken;
        this.base = `${studioHost}/api/v1`;
    }
    async request(path) {
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
        return res.json();
    }
    async getAllData(preview = false) {
        const params = new URLSearchParams({
            projectIds: this.projectId,
            platform: "react",
            ...(preview ? { preview: "true" } : {}),
        });
        return this.request(`/loader/all?${params}`);
    }
    async getComponentData(componentNameOrPath, preview = false) {
        const params = new URLSearchParams({
            projectIds: this.projectId,
            platform: "react",
            componentName: componentNameOrPath,
            ...(preview ? { preview: "true" } : {}),
        });
        return this.request(`/loader/code/component?${params}`);
    }
}
//# sourceMappingURL=loader.js.map