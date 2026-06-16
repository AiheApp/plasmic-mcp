export const env = {
  studioHost: process.env.PLASMIC_STUDIO_HOST ?? "https://studio.aihe.dev",
  apiUser: process.env.PLASMIC_API_USER,
  apiToken: process.env.PLASMIC_API_TOKEN,
  projectId: process.env.PLASMIC_PROJECT_ID,
  projectToken: process.env.PLASMIC_PROJECT_TOKEN,
  cmsDatabaseId: process.env.PLASMIC_CMS_DATABASE_ID,
  cmsPublicToken: process.env.PLASMIC_CMS_PUBLIC_TOKEN,
  cmsSecretToken: process.env.PLASMIC_CMS_SECRET_TOKEN,
};

export function requireStudioAuth() {
  if (!env.apiUser || !env.apiToken) {
    throw new Error(
      "PLASMIC_API_USER and PLASMIC_API_TOKEN are required. Set them in your .env file."
    );
  }
  if (!env.projectId) {
    throw new Error("PLASMIC_PROJECT_ID is required. Set it in your .env file.");
  }
}

export function requireProjectToken() {
  if (!env.projectToken) {
    throw new Error("PLASMIC_PROJECT_TOKEN is required for this tool.");
  }
  if (!env.projectId) {
    throw new Error("PLASMIC_PROJECT_ID is required. Set it in your .env file.");
  }
}

export function requireCmsConfig() {
  if (!env.cmsDatabaseId || !env.cmsPublicToken) {
    throw new Error(
      "PLASMIC_CMS_DATABASE_ID and PLASMIC_CMS_PUBLIC_TOKEN are required for CMS tools."
    );
  }
}
