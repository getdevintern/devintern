/**
 * Workspace relay pairing primitives.
 *
 * Connect is the interactive step: the CLI authenticates with the signed-in
 * Supabase session, the control plane confirms automation entitlement, and
 * (for GitHub / tracker sources) registers the callback. Pairing metadata and
 * the minted relay token persist under the workspace's `state/code`
 * directory. The worker then long-polls with that durable relay token;
 * `LICENSE_KEY` remains the local unattended license gate for
 * `devintern worker`.
 */

import { createDefaultSupabaseAuthConfig, requireAuthenticatedUser } from "@devintern/auth";
import { saveGitHubAppRecord } from "../code-host/github/app-setup";
import { GitLabWebhookAdminClient } from "../code-host/gitlab/webhook-admin";
import type { GitLabProjectHook, GitLabWebhookProject } from "../code-host/gitlab/webhook-admin";
import { resolveGitLabCodeHostConfig } from "../code-host/index";
import { isWorkspaceHome } from "../workspace/paths";
import {
  authSessionPath,
  connectRequest,
  ensureRelayToken,
  gitLabRelayRepository,
  loadRelayState,
  mergeConnectState,
  resolveRelayUrl,
  saveRelayState,
  verifiedGitHubRelayRepositories,
} from "./state";
import type {
  ConnectResponse,
  RelayConnectDeps,
  RelayConnectState,
  RelayRegistration,
  VerifiedGitLabRelayRepository,
} from "./state";
import {
  clearPendingGitHubPairing,
  connectGitHubRepo,
  describeGitHubPairingFailure,
  describePairingInstructions,
  loadPendingGitHubPairing,
  pollGitHubPairing,
  startGitHubRepoPairing,
} from "./github-pairing";
import type { PendingGitHubPairing } from "./github-pairing";

export {
  DEFAULT_RELAY_URL,
  RELAY_BOT_LOGIN,
  ensureRelayToken,
  gitLabRelayRepository,
  hasGitHubRelayRegistration,
  hasGitHubRelayRouting,
  hasGitLabRelayRegistration,
  issueRelayToken,
  loadRelayState,
  resolveRelayUrl,
  saveRelayState,
  verifiedGitHubRelayRepositories,
} from "./state";
export type {
  RelayConnectDeps,
  RelayConnectState,
  RelayRegistration,
  VerifiedGitHubRelayRepository,
  VerifiedGitLabRelayRepository,
} from "./state";
export {
  clearPendingGitHubPairing,
  connectGitHubRepo,
  loadPendingGitHubPairing,
  pollGitHubPairing,
  savePendingGitHubPairing,
  startGitHubRepoPairing,
  verifyGitHubReposWithRelayToken,
  verifyGitHubReposWithSession,
} from "./github-pairing";
export type {
  GitHubPairingPoll,
  GitHubPairingStart,
  GitHubRepoPairingOptions,
  GitHubRepoVerificationResult,
  PendingGitHubPairing,
  UnverifiedGitHubRelayRepository,
} from "./github-pairing";

export type RelayConnectTarget =
  | "github"
  | "gitlab"
  | "linear"
  | "asana"
  | "trello"
  | "azure-devops"
  | "jira"
  | "status";

export interface WorkspaceRelayConnectDeps extends RelayConnectDeps {
  workingDir: string;
  /** Single GitHub repository selected from workspace.toml (legacy callers). */
  repo?: string;
  /**
   * GitHub repositories from the same account to verify with one App
   * installation, so a workspace with several repositories needs one install
   * instead of one per repository.
   */
  repos?: string[];
  /** Stable workspace team slug for tracker registration. */
  team?: string;
  /** GitLab project selected from workspace.toml by the fleet orchestrator. */
  gitlabProject?: { instanceUrl: string; projectPath: string };
  /** Remove the exact remembered GitLab hook and relay route instead of connecting it. */
  disconnectGitLab?: boolean;
  /** Injectable local project-hook administrator for tests. */
  gitlabAdmin?: {
    resolveMaintainedProject(projectPath: string): Promise<GitLabWebhookProject>;
    upsertRelayHook(
      projectId: number,
      config: { ingestUrl: string; legacySecret: string; signingToken?: string },
      existingHookId?: number,
    ): Promise<{ hook: GitLabProjectHook; standardSigning: boolean }>;
    testHook(projectId: number, hookId: number): Promise<void>;
    deleteHook(projectId: number, hookId: number): Promise<boolean>;
  };
  /** Explicit tracker credentials for a selected workspace team. */
  env?: Record<string, string | undefined>;
  /** GitHub: begin the App pairing, record it, and return without waiting for the browser. */
  noWait?: boolean;
  /** GitHub: check (once) the pairing recorded by an earlier `--no-wait`/interrupted run. */
  githubStatus?: boolean;
  /** Structured result of the connect attempt (the `--json` output is built from it). */
  onOutcome?: (outcome: ConnectOutcome) => void;
}

/** Structured result of one relay connect attempt. */
export type ConnectOutcome =
  | { kind: "connected"; target: string; repos?: string[]; relayUrl?: string }
  | { kind: "pending"; target: "github"; pairing: PendingGitHubPairing }
  | { kind: "not_signed_in"; target: string; error: string }
  | { kind: "failed"; target: string; error: string; code?: string };

const RELAY_CONNECT_TARGETS = new Set<RelayConnectTarget>([
  "github",
  "gitlab",
  "linear",
  "asana",
  "trello",
  "azure-devops",
  "jira",
  "status",
]);

async function resolveAccessToken(deps: RelayConnectDeps = {}): Promise<string> {
  if (deps.getAccessToken) {
    return deps.getAccessToken();
  }
  const primaryDir = deps.workingDir ?? process.cwd();
  const isWorkspace = isWorkspaceHome(primaryDir);
  const workingDirs = isWorkspace ? [primaryDir] : [...new Set([primaryDir, process.cwd()])];
  let lastError: unknown;
  for (const workingDir of workingDirs) {
    try {
      const user = await requireAuthenticatedUser(
        createDefaultSupabaseAuthConfig(authSessionPath(workingDir)),
        isWorkspace ? "devintern worker login" : "devintern login",
      );
      return user.accessToken;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export interface GitLabRelayRegistrationBegin {
  registrationId: string;
  ingestUrl: string;
  signingToken: string;
  legacySecret: string;
  expiresAt: number;
}

/** Create a short-lived GitLab route. Its signing material is returned only to the caller. */
export async function beginGitLabRelayRegistration(options: {
  instanceUrl: string;
  projectId: string;
  projectPath: string;
  accessToken: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitLabRelayRegistrationBegin> {
  const deps: RelayConnectDeps = options;
  await ensureRelayToken(options.accessToken, deps);
  const response = await connectRequest(
    options.accessToken,
    {
      action: "begin-gitlab-registration",
      instanceUrl: options.instanceUrl,
      projectId: options.projectId,
      projectPath: options.projectPath,
    },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as GitLabRelayRegistrationBegin;
  if (
    !data.registrationId ||
    !data.ingestUrl ||
    !data.signingToken ||
    !data.legacySecret ||
    !Number.isFinite(data.expiresAt)
  ) {
    throw new Error("relay returned an invalid GitLab registration");
  }
  return data;
}

/** Activate a provisioned GitLab route and persist only its non-secret identity. */
export async function completeGitLabRelayRegistration(options: {
  registrationId: string;
  hookId: number;
  instanceUrl: string;
  projectId: string;
  projectPath: string;
  accessToken: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<RelayConnectState> {
  const workingDir = options.workingDir ?? process.cwd();
  const previous = loadRelayState(workingDir);
  if (!previous?.relayToken) throw new Error("relay token is missing; begin registration again");
  const response = await connectRequest(
    options.accessToken,
    {
      action: "complete-gitlab-registration",
      registrationId: options.registrationId,
      hookId: options.hookId,
    },
    options,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    registration?: {
      provider?: string;
      instanceUrl?: string;
      projectId?: string;
      projectPath?: string;
      registrationId?: string;
      status?: string;
      hookId?: number;
      activatedAt?: number;
    };
  };
  if (!data.registration || data.registration.registrationId !== options.registrationId) {
    throw new Error("relay returned an invalid completed GitLab registration");
  }
  const repository: VerifiedGitLabRelayRepository = {
    instanceUrl: options.instanceUrl.replace(/\/+$/, ""),
    projectId: options.projectId,
    projectPath: options.projectPath,
    hookId: options.hookId,
    registrationId: options.registrationId,
    connectedAt: new Date().toISOString(),
  };
  const gitlabRepositories = [...(previous.gitlabRepositories ?? [])];
  const existingIndex = gitlabRepositories.findIndex(
    (item) =>
      item.instanceUrl.toLowerCase() === repository.instanceUrl.toLowerCase() &&
      item.projectId === repository.projectId,
  );
  if (existingIndex === -1) gitlabRepositories.push(repository);
  else gitlabRepositories[existingIndex] = repository;
  const registrations = previous.registrations.filter(
    (registration) =>
      !(
        registration.kind === "code-host" &&
        registration.provider === "gitlab" &&
        registration.instanceUrl?.toLowerCase() === repository.instanceUrl.toLowerCase() &&
        registration.projectId === repository.projectId
      ),
  );
  registrations.push({
    kind: "code-host",
    key: `gitlab:${repository.instanceUrl}:${repository.projectId}`,
    createdAt: data.registration.activatedAt ?? Date.now(),
    lastEventAt: null,
    ...data.registration,
  });
  const state = { ...previous, registrations, gitlabRepositories };
  saveRelayState(state, workingDir);
  return state;
}

/** Remove a GitLab route from the relay and local safe state. */
export async function removeGitLabRelayRegistration(options: {
  registrationId: string;
  accessToken: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const response = await connectRequest(
    options.accessToken,
    { action: "remove-gitlab-registration", registrationId: options.registrationId },
    options,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as { removed?: boolean };
  const workingDir = options.workingDir ?? process.cwd();
  const previous = loadRelayState(workingDir);
  if (previous) {
    saveRelayState(
      {
        ...previous,
        registrations: previous.registrations.filter(
          (registration) => registration.registrationId !== options.registrationId,
        ),
        gitlabRepositories: previous.gitlabRepositories?.filter(
          (repository) => repository.registrationId !== options.registrationId,
        ),
      },
      workingDir,
    );
  }
  return data.removed === true;
}

/**
 * Register a tracker source with the relay, returning its ingest URL.
 *
 * @param options - Source name, optional client-generated signing secret
 */
export async function registerRelaySource(options: {
  source: string;
  team?: string;
  accessToken: string;
  secret?: string;
  workingDir?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ingestUrl: string; state: RelayConnectState }> {
  const deps: RelayConnectDeps = {
    workingDir: options.workingDir,
    relayUrl: options.relayUrl,
    fetchImpl: options.fetchImpl,
  };
  const { relayToken } = await ensureRelayToken(options.accessToken, deps);
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const workingDir = options.workingDir ?? process.cwd();

  const response = await connectRequest(
    options.accessToken,
    {
      action: "register-source",
      source: options.source,
      team: options.team,
      secret: options.secret,
    },
    deps,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as ConnectResponse & { ingestUrl: string };
  if (options.team) {
    const registration = data.registrations.find(
      (candidate) =>
        candidate.kind === "source" &&
        (candidate.team === options.team || candidate.key === `${options.source}:${options.team}`),
    );
    if (!registration) {
      throw new Error(
        "relay does not support team-scoped tracker registrations; " +
          "upgrade the relay control plane before using this CLI",
      );
    }
    // Accept the transitional compound-key representation while always
    // persisting an explicit team dimension for current state readers.
    registration.team = options.team;
  }
  const state = mergeConnectState(workingDir, relayUrl, data, relayToken);
  return { ingestUrl: data.ingestUrl, state };
}

/** Random 32-byte hex secret for webhook signing (Linear). */
function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatTimestamp(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}

/** Relay connection options threaded to the low-level registration helpers. */
interface RelayConnectOptions {
  accessToken: string;
  workingDir: string;
  /** Stable workspace team slug for team-scoped tracker registration. */
  team?: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Tracker sources whose connect flow shares the register-source + webhook shape. */
type TrackerRelayTarget = Exclude<RelayConnectTarget, "github" | "gitlab" | "status">;

interface TrackerConnectContext {
  env: Record<string, string | undefined>;
  connectOpts: RelayConnectOptions;
}

/** Print relay status and the registrations currently routed for this customer. */
async function connectStatusTarget(
  resolvedDeps: RelayConnectDeps,
  accessToken: string,
): Promise<number> {
  try {
    const { relayToken } = await ensureRelayToken(accessToken, resolvedDeps);
    const status = await fetchRelayStatus({ relayToken, ...resolvedDeps });
    console.log(`📡 Relay: ${resolveRelayUrl()}`);
    console.log(`   Customer: ${status.customerId} (${status.licenseSource})`);
    console.log(`   Buffered envelopes: ${status.buffered}`);
    if (status.registrations.length === 0) {
      console.log("   No registrations yet. Run: devintern worker connect");
    }
    for (const reg of status.registrations) {
      const team = reg.team ? ` (team: ${reg.team})` : "";
      const buffered = reg.buffered === undefined ? "" : `, buffered: ${reg.buffered}`;
      console.log(
        `   - ${reg.kind}:${reg.key}${team} (last event: ${formatTimestamp(reg.lastEventAt)}${buffered})`,
      );
    }
    return 0;
  } catch (error) {
    console.error(`❌ Relay status failed: ${(error as Error).message}`);
    return 1;
  }
}

/** Install or remove the managed GitLab project hook that feeds the relay. */
async function connectGitLabTarget(
  deps: WorkspaceRelayConnectDeps,
  env: Record<string, string | undefined>,
  connectOpts: RelayConnectOptions,
): Promise<number> {
  const identity = deps.gitlabProject;
  if (!identity) {
    console.error("❌ GitLab relay connection requires a workspace repository.");
    return 1;
  }
  const codeHost = resolveGitLabCodeHostConfig(identity.instanceUrl, env);
  const adminToken = env.GITLAB_WEBHOOK_ADMIN_TOKEN || (codeHost.ok ? codeHost.token : undefined);
  if (!adminToken) {
    console.error(
      "❌ GITLAB_WEBHOOK_ADMIN_TOKEN is required to install project hooks; polling remains enabled.",
    );
    return 1;
  }
  try {
    const admin =
      deps.gitlabAdmin ??
      new GitLabWebhookAdminClient(adminToken, identity.instanceUrl, {
        caFile: codeHost.ok ? codeHost.caFile : env.GITLAB_CODE_HOST_CA_FILE,
        proxy: codeHost.ok ? codeHost.proxy : env.GITLAB_CODE_HOST_PROXY,
      });
    const project = await admin.resolveMaintainedProject(identity.projectPath);
    const projectId = String(project.id);
    const previous = gitLabRelayRepository(
      loadRelayState(connectOpts.workingDir),
      identity.instanceUrl,
      projectId,
    );
    if (deps.disconnectGitLab) {
      if (!previous) {
        console.log(`✅ ${project.path} has no remembered GitLab relay hook; polling remains on.`);
        return 0;
      }
      await admin.deleteHook(project.id, previous.hookId);
      await removeGitLabRelayRegistration({
        registrationId: previous.registrationId,
        ...connectOpts,
      });
      console.log(`✅ Disconnected ${project.path} from the relay; polling remains enabled.`);
      return 0;
    }
    const begun = await beginGitLabRelayRegistration({
      instanceUrl: identity.instanceUrl,
      projectId,
      projectPath: project.path,
      ...connectOpts,
    });
    const { hook, standardSigning } = await admin.upsertRelayHook(
      project.id,
      {
        ingestUrl: begun.ingestUrl,
        signingToken: begun.signingToken,
        legacySecret: begun.legacySecret,
      },
      previous?.hookId,
    );
    await admin.testHook(project.id, hook.id);
    const state = await completeGitLabRelayRegistration({
      registrationId: begun.registrationId,
      hookId: hook.id,
      instanceUrl: identity.instanceUrl,
      projectId,
      projectPath: project.path,
      ...connectOpts,
    });
    console.log(`✅ Connected ${project.path} to the relay (${state.relayUrl})`);
    console.log(
      `   GitLab hook ${hook.id} verified with ${standardSigning ? "Standard Webhook signing" : "legacy secret-token authentication"}.`,
    );
    console.log("   Polling remains enabled as a fallback.");
    return 0;
  } catch (error) {
    console.error(`❌ GitLab relay connect failed: ${(error as Error).message}`);
    console.error("   Polling remains enabled; fix access or connectivity and retry.");
    return 1;
  }
}

async function connectLinearTarget({ env, connectOpts }: TrackerConnectContext): Promise<number> {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("❌ LINEAR_API_KEY is required to register a Linear webhook.");
    return 1;
  }
  try {
    const secret = generateWebhookSecret();
    const { ingestUrl } = await registerRelaySource({ source: "linear", secret, ...connectOpts });
    const { LinearClient } = await import("@devintern/task-trackers");
    const webhook = await new LinearClient({ apiKey }).createWebhook(ingestUrl, secret);
    console.log(`✅ Linear webhook registered (${webhook.id}); Issue events now relay instantly.`);
    console.log("   Undo in Linear: Settings > API > Webhooks.");
    return 0;
  } catch (error) {
    console.error(`❌ Linear connect failed: ${(error as Error).message}`);
    return 1;
  }
}

async function connectAsanaTarget({ env, connectOpts }: TrackerConnectContext): Promise<number> {
  const apiToken = env.ASANA_API_TOKEN;
  const projectGid = env.ASANA_DEFAULT_PROJECT_GID;
  if (!apiToken || !projectGid) {
    console.error(
      "❌ ASANA_API_TOKEN and ASANA_DEFAULT_PROJECT_GID are required to register an Asana webhook.",
    );
    return 1;
  }
  try {
    const { ingestUrl } = await registerRelaySource({ source: "asana", ...connectOpts });
    const { AsanaClient } = await import("@devintern/task-trackers");
    // Asana handshakes with the relay during creation (X-Hook-Secret).
    const webhook = await new AsanaClient({ apiToken }).createWebhook(projectGid, ingestUrl);
    console.log(
      `✅ Asana webhook registered (${webhook.gid}); task events on project ${projectGid} now relay instantly.`,
    );
    console.log("   Undo via the Asana API: DELETE /webhooks/" + webhook.gid);
    return 0;
  } catch (error) {
    console.error(`❌ Asana connect failed: ${(error as Error).message}`);
    return 1;
  }
}

async function connectTrelloTarget({ env, connectOpts }: TrackerConnectContext): Promise<number> {
  const apiKey = env.TRELLO_API_KEY;
  const apiToken = env.TRELLO_API_TOKEN;
  const boardId = env.TRELLO_DEFAULT_BOARD_ID;
  if (!apiKey || !apiToken || !boardId) {
    console.error(
      "❌ TRELLO_API_KEY, TRELLO_API_TOKEN, and TRELLO_DEFAULT_BOARD_ID are required to register a Trello webhook.",
    );
    return 1;
  }
  try {
    const { ingestUrl } = await registerRelaySource({ source: "trello", ...connectOpts });
    const { TrelloClient } = await import("@devintern/task-trackers");
    const trello = new TrelloClient({ apiKey, apiToken });
    // Webhooks need the 24-character id; TRELLO_DEFAULT_BOARD_ID may be the short URL id.
    const webhook = await trello.createWebhook(ingestUrl, await trello.resolveBoardId(boardId));
    console.log(
      `✅ Trello webhook registered (${webhook.id}); card events on board ${boardId} now relay instantly.`,
    );
    console.log("   Delivery auth relies on the private ingest URL; keep it secret.");
    return 0;
  } catch (error) {
    console.error(`❌ Trello connect failed: ${(error as Error).message}`);
    return 1;
  }
}

async function connectAzureDevOpsTarget({
  env,
  connectOpts,
}: TrackerConnectContext): Promise<number> {
  const organization = env.AZURE_DEVOPS_ORG;
  const pat = env.AZURE_DEVOPS_PAT;
  const project = env.AZURE_DEVOPS_PROJECT;
  if (!organization || !pat || !project) {
    console.error(
      "❌ AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT, and AZURE_DEVOPS_PROJECT are required to register Azure DevOps service hooks.",
    );
    return 1;
  }
  try {
    const { ingestUrl } = await registerRelaySource({ source: "azure-devops", ...connectOpts });
    const { AzureDevOpsClient } = await import("@devintern/task-trackers");
    const client = new AzureDevOpsClient({ organization, pat, defaultProject: project });
    const { ids } = await client.createWorkItemWebhooks(ingestUrl);
    console.log(
      `✅ Azure DevOps service hooks registered (${ids.join(", ")}); work item events on ${project} now relay instantly.`,
    );
    console.log("   Undo in Azure DevOps: Project settings > Service hooks.");
    return 0;
  } catch (error) {
    console.error(`❌ Azure DevOps connect failed: ${(error as Error).message}`);
    return 1;
  }
}

async function connectJiraTarget({ connectOpts }: TrackerConnectContext): Promise<number> {
  try {
    const { ingestUrl } = await registerRelaySource({ source: "jira", ...connectOpts });
    console.log("✅ Jira ingest URL registered. Jira webhooks need one-time admin setup:");
    console.log("");
    console.log("   1. Open Jira: Settings (gear) > System > WebHooks > Create a WebHook");
    console.log(`   2. URL: ${ingestUrl}`);
    console.log("   3. Events: Issue - created, updated (optionally scope with a JQL filter)");
    console.log("   4. Save. Issue events now relay instantly.");
    console.log("");
    console.log("   Keep the URL secret; it authenticates deliveries for your account.");
    return 0;
  } catch (error) {
    console.error(`❌ Jira connect failed: ${(error as Error).message}`);
    return 1;
  }
}

/** Tracker connect flows keyed by target; every entry shares the same signature. */
const TRACKER_CONNECT_HANDLERS: Record<
  TrackerRelayTarget,
  (ctx: TrackerConnectContext) => Promise<number>
> = {
  linear: connectLinearTarget,
  asana: connectAsanaTarget,
  trello: connectTrelloTarget,
  "azure-devops": connectAzureDevOpsTarget,
  jira: connectJiraTarget,
};

/** Pair workspace repositories from one account with the central DevIntern GitHub App. */
async function connectGitHubTarget(
  repos: string[] | undefined,
  deps: WorkspaceRelayConnectDeps,
  connectOpts: RelayConnectOptions,
): Promise<number> {
  if (!repos || repos.length === 0) {
    console.error("❌ GitHub relay connection requires a workspace repository.");
    return 1;
  }
  const requested = [...new Set(repos.map((repo) => repo.toLowerCase()))];
  try {
    let installUrl = "";
    const pairingOptions = {
      repos: requested,
      ...connectOpts,
      sleep: deps.sleep,
      onVerified(verified: string[]) {
        console.log(
          `✅ Verified ${verified.join(", ")} through the existing DevIntern GitHub App installation.`,
        );
      },
    };
    if (deps.noWait) {
      const start = await startGitHubRepoPairing(pairingOptions);
      if (start.kind === "pending") {
        deps.onGitHubInstallUrl?.(start.pairing.installUrl);
        for (const line of describePairingInstructions(start.pairing)) console.log(line);
        console.log("Then check the result with: devintern worker connect github --status");
        deps.onOutcome?.({ kind: "pending", target: "github", pairing: start.pairing });
        return 0;
      }
      console.log(`✅ Connected ${requested.join(", ")} to the relay (${start.state.relayUrl})`);
      deps.onOutcome?.({
        kind: "connected",
        target: "github",
        repos: requested,
        relayUrl: start.state.relayUrl,
      });
      return 0;
    }
    const state = await connectGitHubRepo({
      ...pairingOptions,
      onInstallUrl(url, pairing) {
        installUrl = url;
        deps.onGitHubInstallUrl?.(url);
        for (const line of describePairingInstructions(pairing)) console.log(line);
        console.log("Waiting for GitHub verification...");
      },
    });
    const connected = verifiedGitHubRelayRepositories(state).filter((repository) =>
      requested.includes(repository.repo),
    );
    console.log(
      `✅ Connected ${connected.map((repository) => repository.repo).join(", ") || requested.join(", ")} ` +
        `to the relay (${state.relayUrl})`,
    );
    console.log(`   Customer: ${state.customerId}`);
    console.log(`   GitHub App authorization verified${installUrl ? "." : ""}`);
    for (const repository of connected) {
      saveGitHubAppRecord(
        {
          repo: repository.repo,
          enabled: true,
          connectedAt: new Date().toISOString(),
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
        },
        connectOpts.workingDir,
      );
    }
    const missing = requested.filter(
      (repo) => !connected.some((repository) => repository.repo === repo),
    );
    if (missing.length > 0) {
      console.warn(`⚠️  The installation did not grant: ${missing.join(", ")}`);
      console.warn(
        "   Add them to the App installation, then run `devintern worker connect github` again.",
      );
    }
    console.log("   Keep GITHUB_TOKEN configured locally for GitHub API reads/writes.");
    console.log("   Run the worker as usual: devintern worker");
    if (missing.length > 0) {
      deps.onOutcome?.({
        kind: "failed",
        target: "github",
        code: "repositories_not_granted",
        error: `The installation did not grant: ${missing.join(", ")}`,
      });
    } else {
      deps.onOutcome?.({
        kind: "connected",
        target: "github",
        repos: connected.map((repository) => repository.repo),
        relayUrl: state.relayUrl,
      });
    }
    return missing.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`❌ Relay connect failed: ${(error as Error).message}`);
    deps.onOutcome?.({ kind: "failed", target: "github", error: (error as Error).message });
    return 1;
  }
}

/** Check the pairing a previous `--no-wait` (or interrupted) run recorded, once. */
async function connectGitHubStatus(
  deps: WorkspaceRelayConnectDeps,
  connectOpts: RelayConnectOptions,
): Promise<number> {
  const fail = (error: string, code: string): number => {
    console.error(`❌ ${error}`);
    deps.onOutcome?.({ kind: "failed", target: "github", error, code });
    return 1;
  };
  const pairing = loadPendingGitHubPairing(connectOpts.workingDir);
  if (!pairing) {
    return fail(
      "No pending GitHub pairing. Start one with `devintern worker connect github --no-wait`.",
      "no_pending_pairing",
    );
  }
  try {
    const relayUrl = (connectOpts.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
    const polled = await pollGitHubPairing({
      pairing,
      accessToken: connectOpts.accessToken,
      relayToken: loadRelayState(connectOpts.workingDir)?.relayToken,
      workingDir: connectOpts.workingDir,
      relayUrl,
      fetchImpl: connectOpts.fetchImpl,
    });
    if (polled.kind === "complete") {
      clearPendingGitHubPairing(connectOpts.workingDir);
      const verified = new Set(
        verifiedGitHubRelayRepositories(polled.state).map((repository) => repository.repo),
      );
      const connected = pairing.repos.filter((repo) => verified.has(repo));
      const missing = pairing.repos.filter((repo) => !verified.has(repo));
      if (missing.length > 0) {
        return fail(
          `The installation did not grant: ${missing.join(", ")}. Add them to the App installation, then run \`devintern worker connect github\` again.`,
          "repositories_not_granted",
        );
      }
      console.log(`✅ Connected ${connected.join(", ")} to the relay.`);
      deps.onOutcome?.({
        kind: "connected",
        target: "github",
        repos: connected,
        relayUrl: polled.state.relayUrl,
      });
      return 0;
    }
    if (polled.kind === "expired" || Date.now() >= pairing.expiresAt) {
      clearPendingGitHubPairing(connectOpts.workingDir);
      return fail(
        "The GitHub pairing expired. Start again with `devintern worker connect github --no-wait`.",
        "pairing_expired",
      );
    }
    if (polled.kind === "failure") {
      return fail(describeGitHubPairingFailure(polled), polled.code);
    }
    console.log("⏳ Waiting for the GitHub App authorization.");
    for (const line of describePairingInstructions(pairing)) console.log(line);
    if (!pairing.authorizeUrl) {
      console.log(
        "   If GitHub showed the App's settings page instead of an install, saving there won't finish pairing.",
      );
    }
    console.log("   Re-run `devintern worker connect github` to verify without a browser.");
    deps.onOutcome?.({ kind: "pending", target: "github", pairing });
    return 0;
  } catch (error) {
    return fail((error as Error).message, "relay_error");
  }
}

/**
 * Connect one relay target using workspace-scoped state.
 *
 * @param target - Relay source to connect
 * @param deps - Optional injectables for tests
 * @returns Process exit code
 */
export async function connectRelayTarget(
  target: string,
  deps: WorkspaceRelayConnectDeps,
): Promise<number> {
  if (!RELAY_CONNECT_TARGETS.has(target as RelayConnectTarget)) {
    console.error(
      `❌ Unsupported connect target '${target}'. ` +
        "Available: github, gitlab, linear, asana, trello, azure-devops, jira, status.",
    );
    return 1;
  }
  const repos =
    target === "github" ? (deps.repos ?? (deps.repo ? [deps.repo] : undefined)) : undefined;
  const env = deps.env ?? process.env;
  const workingDir = deps.workingDir;
  const resolvedDeps: RelayConnectDeps = { ...deps, workingDir };

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(resolvedDeps);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`❌ ${message}`);
    deps.onOutcome?.(
      message.startsWith("Not authenticated")
        ? { kind: "not_signed_in", target, error: message }
        : { kind: "failed", target, error: message },
    );
    return 1;
  }

  const connectOpts: RelayConnectOptions = {
    accessToken,
    workingDir,
    team: deps.team,
    relayUrl: deps.relayUrl,
    fetchImpl: deps.fetchImpl,
  };

  if (target === "status") {
    return connectStatusTarget(resolvedDeps, accessToken);
  }
  if (target === "gitlab") {
    return connectGitLabTarget(deps, env, connectOpts);
  }
  if (target === "github") {
    return deps.githubStatus
      ? connectGitHubStatus(deps, connectOpts)
      : connectGitHubTarget(repos, deps, connectOpts);
  }
  return TRACKER_CONNECT_HANDLERS[target as TrackerRelayTarget]({ env, connectOpts });
}

interface StatusResponse {
  customerId: string;
  licenseSource: string;
  buffered: number;
  registrations: RelayRegistration[];
}

/**
 * Fetch live relay status for this customer (data plane: relay token).
 *
 * @param options - Relay token and optional relay URL / fetch override
 */
export async function fetchRelayStatus(options: {
  relayToken: string;
  relayUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<StatusResponse> {
  const relayUrl = (options.relayUrl ?? resolveRelayUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${relayUrl}/v1/status`, {
    headers: { Authorization: `Bearer ${options.relayToken}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `relay returned HTTP ${response.status}`);
  }
  return (await response.json()) as StatusResponse;
}
