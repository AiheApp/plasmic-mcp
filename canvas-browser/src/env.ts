export const env = {
  get studioHost() { return process.env.PLASMIC_STUDIO_HOST ?? "https://studio.aihe.dev"; },
  get chromeDebugUrl() { return process.env.PLASMIC_CHROME_DEBUG_URL ?? "http://localhost:9222"; },
  get projectId() { return process.env.PLASMIC_PROJECT_ID; },
  // Optional: when set, a cold-launched Chrome that lands on the Studio login
  // page will be authenticated automatically (API login + session-cookie inject).
  get email() { return process.env.PLASMIC_EMAIL ?? process.env.PLASMIC_API_USER; },
  get password() { return process.env.PLASMIC_PASSWORD; },
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
