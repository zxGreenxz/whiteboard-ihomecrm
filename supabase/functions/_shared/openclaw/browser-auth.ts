import { OpenClawHttpError } from "./errors.ts";

interface BrowserAuthClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
}

export async function requireBrowserUser(
  client: BrowserAuthClient,
): Promise<{ id: string }> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) {
    throw new OpenClawHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Browser authentication is required.",
    );
  }
  return { id: data.user.id };
}
