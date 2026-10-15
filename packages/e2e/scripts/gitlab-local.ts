import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gitlabCredentialsPath } from "../helpers/gitlab-config";
import { GitLab } from "../providers/gitlab";

const composeFile = resolve(import.meta.dir, "../infrastructure/gitlab/compose.yml");
const baseUrl = "http://127.0.0.1:8929";

async function compose(...args: string[]): Promise<void> {
  const child = Bun.spawn(["docker", "compose", "-f", composeFile, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error("Docker Compose failed; check Docker daemon access and container logs");
}

async function waitForGitLab(): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  console.log("Waiting for the GitLab sign-in page (the first boot can take several minutes)...");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/users/sign_in`, {
        signal: AbortSignal.timeout(5000),
      });
      // Monitoring endpoints only accept container-local requests by default.
      if (response.status === 200) return;
    } catch {
      // GitLab is configuring or starting its services.
    }
    console.log("GitLab is still starting...");
    await Bun.sleep(15_000);
  }
  throw new Error(
    `GitLab did not become ready; inspect docker compose -f ${composeFile} logs --tail 100`,
  );
}

async function bootstrap(): Promise<void> {
  if (existsSync(gitlabCredentialsPath)) {
    try {
      const config = JSON.parse(readFileSync(gitlabCredentialsPath, "utf8"));
      if (config.baseUrl === baseUrl) {
        await new GitLab(baseUrl, config.token).request("/user");
        chmodSync(gitlabCredentialsPath, 0o600);
        return;
      }
    } catch {
      // Regenerate credentials after a volume reset or token expiration.
    }
  }
  const child = Bun.spawn(
    ["docker", "compose", "-f", composeFile, "exec", "-T", "gitlab", "gitlab-rails", "runner", "-"],
    {
      stdin: Bun.file(resolve(import.meta.dir, "../infrastructure/gitlab/bootstrap.rb")),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error("Local GitLab token bootstrap failed; check container service health");
  const marker = "DEVINTERN_E2E_CREDENTIALS=";
  const line = stdout.split("\n").find((item) => item.startsWith(marker));
  if (!line) throw new Error("GitLab bootstrap did not return test credentials");
  const config = JSON.parse(line.slice(marker.length));
  await new GitLab(baseUrl, config.token).request("/user");
  mkdirSync(dirname(gitlabCredentialsPath), { recursive: true, mode: 0o700 });
  writeFileSync(gitlabCredentialsPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(gitlabCredentialsPath, 0o600);
}

switch (process.argv[2]) {
  case "up":
    await compose("up", "-d");
    await waitForGitLab();
    await bootstrap();
    console.log(
      `GitLab is ready at ${baseUrl}. Test credentials are stored in ignored .local/gitlab.json (mode 0600).`,
    );
    console.log("Run: bun run --filter @devintern/e2e test:e2e:gitlab");
    break;
  case "down":
    await compose("down");
    console.log("GitLab stopped. Named volumes and credentials were preserved.");
    break;
  case "status":
    await compose("ps");
    break;
  default:
    throw new Error("Usage: bun run scripts/gitlab-local.ts up|down|status");
}
