export class PlasmicWriteClient {
    studioHost;
    projectId;
    secretToken;
    constructor(studioHost, projectId, secretToken) {
        this.studioHost = studioHost;
        this.projectId = projectId;
        this.secretToken = secretToken;
    }
    async updateProject(body) {
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
        return res.json();
    }
}
//# sourceMappingURL=write.js.map