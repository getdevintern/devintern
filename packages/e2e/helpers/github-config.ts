export const DEFAULT_GITHUB_REPOSITORY = "getdevintern/devintern-e2e";

async function localGitHubToken(): Promise<string> {
  try {
    const child = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [token, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode === 0 && token.trim()) return token.trim();
  } catch {
    // Report setup instructions below without exposing credential output.
  }
  throw new Error(
    "Set E2E_GITHUB_TOKEN or log in locally with gh auth login --hostname github.com",
  );
}

export async function resolveGitHubConfig(
  env: Record<string, string | undefined> = process.env,
  readLocalToken: () => Promise<string> = localGitHubToken,
): Promise<{ repository: string; token: string }> {
  const ci =
    Boolean(env.CI && env.CI !== "0" && env.CI !== "false") || env.GITHUB_ACTIONS === "true";
  const repository = env.E2E_GITHUB_REPOSITORY?.trim() || (ci ? "" : DEFAULT_GITHUB_REPOSITORY);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Set E2E_GITHUB_REPOSITORY=owner/repo for a dedicated test repository");
  }
  let token = env.E2E_GITHUB_TOKEN?.trim();
  if (!token) {
    if (ci)
      throw new Error(
        "Set the E2E_GITHUB_TOKEN CI secret; local gh authentication is disabled in CI",
      );
    token = await readLocalToken();
  }
  if (!token.trim()) throw new Error("GitHub authentication returned an empty token");
  return { repository, token: token.trim() };
}
