export const env = {
  get studioHost() { return process.env.PLASMIC_STUDIO_HOST ?? "https://studio.aihe.dev"; },
  get chromeDebugUrl() { return process.env.PLASMIC_CHROME_DEBUG_URL ?? "http://localhost:9222"; },
  get projectId() { return process.env.PLASMIC_PROJECT_ID; },
};

export function resolveProjectId(override?: string): string {
  const id = override ?? env.projectId;
  if (!id) {
    throw new Error(
      "projectId is required — pass it as a tool parameter or set PLASMIC_PROJECT_ID."
    );
  }
  return id;
}
