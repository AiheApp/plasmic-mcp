import { env } from "../env.js";
export class PlasmicCmsClient {
    databaseId;
    publicToken;
    secretToken;
    base;
    constructor(databaseId, publicToken, secretToken, cmsHost = env.studioHost) {
        this.databaseId = databaseId;
        this.publicToken = publicToken;
        this.secretToken = secretToken;
        this.base = `${cmsHost}/api/v1/cms/databases/${databaseId}`;
    }
    async request(path, options = {}, useSecret = false) {
        const token = useSecret ? (this.secretToken ?? this.publicToken) : this.publicToken;
        const url = `${this.base}${path}`;
        const res = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "x-plasmic-api-cms-tokens": `${this.databaseId}:${token}`,
                ...options.headers,
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Plasmic CMS API ${res.status} ${res.statusText}: ${body}`);
        }
        if (res.status === 204)
            return undefined;
        return res.json();
    }
    async listTables() {
        const data = await this.request("/tables");
        return data.tables ?? [];
    }
    async queryRows(tableIdentifier, opts = {}) {
        const params = new URLSearchParams();
        if (opts.limit !== undefined)
            params.set("q[limit]", String(opts.limit));
        if (opts.offset !== undefined)
            params.set("q[offset]", String(opts.offset));
        if (opts.locale)
            params.set("q[locale]", opts.locale);
        const qs = params.toString();
        return this.request(`/tables/${tableIdentifier}/rows${qs ? `?${qs}` : ""}`);
    }
    async getRow(tableIdentifier, rowId) {
        return this.request(`/tables/${tableIdentifier}/rows/${rowId}`);
    }
    async createRow(tableIdentifier, data) {
        if (!this.secretToken)
            throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
        return this.request(`/tables/${tableIdentifier}/rows`, { method: "POST", body: JSON.stringify({ data }) }, true);
    }
    async updateRow(tableIdentifier, rowId, data) {
        if (!this.secretToken)
            throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
        return this.request(`/tables/${tableIdentifier}/rows/${rowId}`, { method: "PATCH", body: JSON.stringify({ data }) }, true);
    }
    async deleteRow(tableIdentifier, rowId) {
        if (!this.secretToken)
            throw new Error("PLASMIC_CMS_SECRET_TOKEN required for write operations.");
        await this.request(`/tables/${tableIdentifier}/rows/${rowId}`, { method: "DELETE" }, true);
    }
}
//# sourceMappingURL=cms.js.map