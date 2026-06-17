export const env = {
    studioHost: process.env.PLASMIC_STUDIO_HOST ?? "https://studio.aihe.dev",
    chromeDebugUrl: process.env.PLASMIC_CHROME_DEBUG_URL ?? "http://localhost:9222",
    projectId: process.env.PLASMIC_PROJECT_ID,
};
export function resolveProjectId(override) {
    const id = override ?? env.projectId;
    if (!id) {
        throw new Error("projectId is required — pass it as a tool parameter or set PLASMIC_PROJECT_ID.");
    }
    return id;
}
//# sourceMappingURL=env.js.map