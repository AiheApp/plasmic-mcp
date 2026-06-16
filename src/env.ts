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

export function requireStudioAuth(): void {
  if (!env.apiUser || !env.apiToken) {
    throw new Error(
      "PLASMIC_API_USER and PLASMIC_API_TOKEN are required. Set them in your .env file."
    );
  }
}

export function resolveProjectId(override?: string): string {
  const id = override ?? env.projectId;
  if (!id) {
    throw new Error(
      "A project ID is required. Pass projectId as a tool parameter or set PLASMIC_PROJECT_ID in your .env file."
    );
  }
  return id;
}

export function resolveProjectToken(override?: string): string {
  const token = override ?? env.projectToken;
  if (!token) {
    throw new Error(
      "A project token is required. Pass projectToken as a tool parameter or set PLASMIC_PROJECT_TOKEN in your .env file."
    );
  }
  return token;
}

export function resolveCmsCredentials(
  databaseIdOverride?: string,
  publicTokenOverride?: string
): { databaseId: string; publicToken: string } {
  const databaseId = databaseIdOverride ?? env.cmsDatabaseId;
  const publicToken = publicTokenOverride ?? env.cmsPublicToken;
  if (!databaseId || !publicToken) {
    throw new Error(
      "CMS database ID and public token are required. Pass databaseId/publicToken as tool parameters or set PLASMIC_CMS_DATABASE_ID and PLASMIC_CMS_PUBLIC_TOKEN in your .env file."
    );
  }
  return { databaseId, publicToken };
}
