import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  channelAvailability,
  desktopCommand,
  runCommand,
  sendToChannel,
  slackPayload,
  webhookPayload,
} from "../src/lib/notifications/delivery/channels";
import type { ChannelDeps } from "../src/lib/notifications/delivery/channels";
import {
  DEFAULT_SLACK_URL_ENV,
  parseNotificationsSection,
} from "../src/lib/notifications/delivery/config";
import type {
  NotificationChannelConfig,
  NotificationsSettings,
} from "../src/lib/notifications/delivery/config";
import { NotificationDispatcher } from "../src/lib/notifications/delivery/dispatcher";
import { notificationDeliveryCheck } from "../src/lib/notifications/delivery/doctor";
import {
  buildDigest,
  buildNotificationMessage,
  resolveDashboardBaseUrl,
} from "../src/lib/notifications/delivery/message";
import {
  decideImmediate,
  isDigestItem,
  rateLimitAllows,
} from "../src/lib/notifications/delivery/policy";
import { NotificationEmitter } from "../src/lib/notifications/emitter";
import type { Notification, NotificationInput } from "../src/lib/notifications/types";
import { collectWorkerDoctorChecks } from "../src/lib/observability/worker-readiness";
import { parseWorkspaceConfig } from "../src/lib/workspace/config";

const MINUTE = 60_000;
const SLACK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";

function parse(table: Record<string, unknown>): {
  settings: NotificationsSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const settings = parseNotificationsSection(table, errors);
  return { settings, errors };
}

function channel(overrides: Partial<NotificationChannelConfig> = {}): NotificationChannelConfig {
  return {
    type: "webhook",
    minSeverity: "high",
    excludeKinds: [],
    rateLimitMinutes: 60,
    notifyResolved: false,
    url: "https://hooks.example.com/devintern",
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 7,
    kind: "internal_error",
    severity: "high",
    groupKey: "internal_error:verify:boom",
    count: 1,
    runId: 953,
    repo: "acme/web",
    title: "Likely DevIntern bug: verify failed",
    body: "verify: worktree vanished\nWork discarded",
    links: [{ label: "Run #953", runId: 953 }],
    createdAt: 1,
    updatedAt: 1,
    muted: false,
    ...overrides,
  };
}

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeDeps(overrides: Partial<ChannelDeps> = {}): ChannelDeps & {
  sent: Sent[];
  commands: string[][];
} {
  const sent: Sent[] = [];
  const commands: string[][] = [];
  return {
    env: { [DEFAULT_SLACK_URL_ENV]: SLACK_URL },
    fetch: async (url, init) => {
      sent.push({
        url,
        body: String(init.body),
        headers: init.headers as Record<string, string>,
      });
      return new Response("ok", { status: 200 });
    },
    platform: "linux",
    which: (command) => `/usr/bin/${command}`,
    run: async (argv) => {
      commands.push(argv);
      return { exitCode: 0, stderr: "" };
    },
    sleep: async () => {},
    retryDelaysMs: [0, 0],
    ...overrides,
    sent,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("[notifications] config", () => {
  test("no section means no channels (opt-in)", () => {
    expect(parse({}).settings).toEqual({ channels: [] });
  });

  test("a channel table enables it with defaults", () => {
    const { settings, errors } = parse({ slack: {}, desktop: {} });
    expect(errors).toEqual([]);
    expect(settings.channels.map((c) => c.type)).toEqual(["desktop", "slack"]);
    expect(settings.channels[1]).toEqual({
      type: "slack",
      minSeverity: "high",
      excludeKinds: [],
      rateLimitMinutes: 60,
      notifyResolved: false,
      urlEnv: DEFAULT_SLACK_URL_ENV,
    });
  });

  test("parses every option", () => {
    const { settings, errors } = parse({
      dashboard_url: "https://box.tailnet.ts.net/",
      timezone: "Europe/Berlin",
      webhook: {
        url_env: "MY_HOOK",
        secret_env: "MY_SECRET",
        min_severity: "normal",
        kinds: ["internal_error", "escalated"],
        exclude_kinds: ["escalated"],
        rate_limit_minutes: 15,
        notify_resolved: true,
        digest_time: "08:30",
      },
    });
    expect(errors).toEqual([]);
    expect(settings.dashboardUrl).toBe("https://box.tailnet.ts.net");
    expect(settings.timezone).toBe("Europe/Berlin");
    expect(settings.channels[0]).toEqual({
      type: "webhook",
      minSeverity: "normal",
      kinds: ["internal_error", "escalated"],
      excludeKinds: ["escalated"],
      rateLimitMinutes: 15,
      notifyResolved: true,
      digestTime: { spec: "08:30", minutes: 510 },
      urlEnv: "MY_HOOK",
      secretEnv: "MY_SECRET",
    });
  });

  test("enabled = false drops a channel", () => {
    expect(parse({ desktop: { enabled: false } }).settings.channels).toEqual([]);
  });

  test("rejects an inline Slack URL, pointing at the .env convention", () => {
    const { errors } = parse({ slack: { url: SLACK_URL } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("keep the Slack webhook URL out of workspace.toml");
  });

  test("collects every validation problem", () => {
    const { errors } = parse({
      sms: {},
      timezone: "Mars/Olympus",
      desktop: { min_severity: "urgent", kinds: ["nope"], digest_time: "25:00", color: "red" },
      webhook: { url: "ftp://example.com", rate_limit_minutes: -1, url_env: "bad name" },
    });
    expect(errors.join("\n")).toContain("[notifications].sms is not supported");
    expect(errors.join("\n")).toContain("not a valid IANA timezone");
    expect(errors.join("\n")).toContain('min_severity must be "high" or "normal"');
    expect(errors.join("\n")).toContain('unknown kind "nope"');
    expect(errors.join("\n")).toContain("digest_time must be");
    expect(errors.join("\n")).toContain("[notifications.desktop].color is not supported");
    expect(errors.join("\n")).toContain("rate_limit_minutes must be");
    expect(errors.join("\n")).toContain("url_env must be an environment variable name");
  });

  test("webhook accepts an inline url but not url and url_env together", () => {
    expect(
      parse({ webhook: { url: "http://localhost:9000/hook" } }).settings.channels[0]?.url,
    ).toBe("http://localhost:9000/hook");
    expect(parse({ webhook: { url: "http://x/", url_env: "X" } }).errors[0]).toContain("both");
  });

  test("workspace.toml parsing carries the section and reports its errors", () => {
    const base = `
[defaults]
tracker = "jira"
task_query = "labels = devintern"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"
`;
    const config = parseWorkspaceConfig(
      `${base}\n[notifications.desktop]\nmin_severity = "normal"\n`,
    );
    expect(config.notifications?.channels[0]?.minSeverity).toBe("normal");
    expect(() =>
      parseWorkspaceConfig(`${base}\n[notifications.slack]\nurl = "${SLACK_URL}"\n`),
    ).toThrow(/Slack webhook URL/);
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe("delivery policy", () => {
  test("min severity high drops normal items; normal lets them through", () => {
    const normal = { notification: notification({ severity: "normal", kind: "pr_opened" }) };
    expect(decideImmediate(channel(), normal)).toBe("skip");
    expect(decideImmediate(channel({ minSeverity: "normal" }), normal)).toBe("send");
    expect(decideImmediate(channel(), { notification: notification() })).toBe("send");
  });

  test("kind include and exclude lists", () => {
    const item = { notification: notification({ kind: "escalated" }) };
    expect(decideImmediate(channel({ kinds: ["internal_error"] }), item)).toBe("skip");
    expect(decideImmediate(channel({ excludeKinds: ["escalated"] }), item)).toBe("skip");
    expect(decideImmediate(channel({ kinds: ["escalated"] }), item)).toBe("send");
  });

  test("with a digest, routine items go to the digest instead", () => {
    const digest = channel({ digestTime: { spec: "09:00", minutes: 540 } });
    const reviewHold = {
      notification: notification({ kind: "escalated" }),
      runOutcomeClass: "review_hold",
    };
    const agentEscalation = {
      notification: notification({ kind: "escalated" }),
      runOutcomeClass: "agent",
    };
    expect(isDigestItem(reviewHold)).toBe(true);
    expect(decideImmediate(digest, reviewHold)).toBe("digest");
    expect(decideImmediate(channel(), reviewHold)).toBe("send");
    expect(decideImmediate(digest, agentEscalation)).toBe("send");
    expect(decideImmediate(digest, { notification: notification({ severity: "normal" }) })).toBe(
      "digest",
    );
  });

  test("rate limit window", () => {
    expect(rateLimitAllows(channel(), undefined, 0)).toBe(true);
    expect(rateLimitAllows(channel(), 0, 59 * MINUTE)).toBe(false);
    expect(rateLimitAllows(channel(), 0, 60 * MINUTE)).toBe(true);
    expect(rateLimitAllows(channel({ rateLimitMinutes: 0 }), 0, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Messages and payloads
// ---------------------------------------------------------------------------

describe("messages", () => {
  test("dashboard base: explicit setting, then allowed origin, then localhost port", () => {
    const workspace = { dashboardPort: 4555 } as never;
    const noOrigins = { allowedOrigins: [], tailscaleAutodetect: true };
    expect(resolveDashboardBaseUrl({ workspace, dashboard: noOrigins }, {})).toBe(
      "http://localhost:4555",
    );
    expect(
      resolveDashboardBaseUrl(
        {
          workspace,
          dashboard: {
            allowedOrigins: [
              {
                origin: "https://box.ts.net",
                host: "box.ts.net",
                scheme: "https:",
                source: "explicit",
              },
            ],
            tailscaleAutodetect: true,
          },
        },
        {},
      ),
    ).toBe("https://box.ts.net");
    expect(
      resolveDashboardBaseUrl(
        {
          workspace,
          dashboard: noOrigins,
          notifications: { channels: [], dashboardUrl: "http://x:1" },
        },
        {},
      ),
    ).toBe("http://x:1");
  });

  test("a message links the run, shows the short cause, and redacts secrets", () => {
    const message = buildNotificationMessage(
      notification({ body: "push failed: token ghp_abcdefghijklmnopqrstuvwxyz0123456789\nmore" }),
      "created",
      "http://localhost:4400",
    );
    expect(message.dashboardUrl).toBe("http://localhost:4400/#/runs/953");
    expect(message.cause).toStartWith("push failed: token ");
    expect(message.cause).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(webhookPayload(message))).not.toContain("ghp_abcdefghijkl");
    const noRun = buildNotificationMessage(
      notification({ runId: undefined }),
      "created",
      "http://h",
    );
    expect(noRun.dashboardUrl).toBe("http://h/#/inbox");
  });

  test("Slack payload: title, cause, repo, dashboard link, escaped text", () => {
    const message = buildNotificationMessage(
      notification({ title: "a <b> & c", count: 3 }),
      "resurfaced",
      "http://localhost:4400",
    );
    expect(slackPayload(message).text).toBe(
      [
        "🔴 *a &lt;b&gt; &amp; c (×3)*",
        "verify: worktree vanished",
        "internal error · repo acme/web · <http://localhost:4400/#/runs/953|Open in dashboard>",
      ].join("\n"),
    );
  });

  test("webhook payload carries the notification domain type", () => {
    const message = buildNotificationMessage(notification(), "created", "http://h");
    expect(webhookPayload(message)).toMatchObject({
      source: "devintern",
      version: 1,
      type: "notification",
      event: "created",
      cause: "verify: worktree vanished",
      dashboardUrl: "http://h/#/runs/953",
      notification: { id: 7, kind: "internal_error", severity: "high", count: 1, repo: "acme/web" },
    });
  });

  test("desktop commands per platform, no shell", () => {
    const message = buildNotificationMessage(
      notification({ title: 'say "hi"' }),
      "created",
      "http://h",
    );
    expect(desktopCommand(message, "linux")).toEqual([
      "notify-send",
      "--app-name=DevIntern",
      "--urgency=critical",
      "--",
      'say "hi"',
      "verify: worktree vanished\nacme/web\nhttp://h/#/runs/953",
    ]);
    const mac = desktopCommand(message, "darwin");
    expect(mac?.[0]).toBe("osascript");
    expect(mac?.[2]).toContain('subtitle "say \\"hi\\""');
    expect(desktopCommand(message, "win32")).toBeNull();
  });

  test("digest: counts per kind, top items by count, links", () => {
    const items = [
      {
        notification: notification({
          id: 1,
          kind: "pr_opened",
          severity: "normal",
          count: 2,
          title: "2 PRs",
        }),
      },
      {
        notification: notification({
          id: 2,
          kind: "pr_opened",
          severity: "normal",
          count: 1,
          title: "1 PR",
        }),
      },
      {
        notification: notification({ id: 3, kind: "escalated", count: 9, title: "Held", runId: 5 }),
        runOutcomeClass: "review_hold",
      },
    ];
    const digest = buildDigest(items, { since: 0, until: 1 }, "http://h");
    expect(digest).toMatchObject({
      total: 3,
      countsByKind: [
        { kind: "pr_opened", count: 2 },
        { kind: "escalated", count: 1 },
      ],
      dashboardUrl: "http://h/#/inbox",
    });
    expect(digest?.top.map((item) => item.title)).toEqual(["Held", "2 PRs", "1 PR"]);
    expect(digest?.top[0]?.dashboardUrl).toBe("http://h/#/runs/5");
    expect(slackPayload(digest!).text).toContain("*DevIntern daily digest: 3 items*");
    expect(webhookPayload(digest!)).toMatchObject({ type: "digest", digest: { total: 3 } });
    expect(buildDigest([], { since: 0, until: 1 }, "http://h")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Channels: availability, retry, signing
// ---------------------------------------------------------------------------

describe("channels", () => {
  test("availability reports missing env vars and platforms without a notifier", () => {
    const deps = fakeDeps({ env: {} });
    expect(
      channelAvailability(
        channel({ type: "slack", url: undefined, urlEnv: "SLACK_WEBHOOK_URL" }),
        deps,
      ),
    ).toEqual({
      available: false,
      detail: "SLACK_WEBHOOK_URL is not set",
    });
    expect(
      channelAvailability(channel({ type: "desktop" }), { ...deps, platform: "win32" }),
    ).toEqual({
      available: false,
      detail: "not available on win32",
    });
    expect(
      channelAvailability(channel({ type: "desktop" }), { ...deps, which: () => null }).detail,
    ).toBe("notify-send not found on PATH");
  });

  test("webhook signs the body when secret_env is set", async () => {
    const deps = fakeDeps({ env: { HOOK_SECRET: "s3cret" } });
    const message = buildNotificationMessage(notification(), "created", "http://h");
    await sendToChannel(channel({ secretEnv: "HOOK_SECRET" }), message, deps);
    const [request] = deps.sent;
    const expected = createHmac("sha256", "s3cret").update(request!.body).digest("hex");
    expect(request?.headers["X-DevIntern-Signature"]).toBe(`sha256=${expected}`);
  });

  test("retries transient failures a bounded number of times", async () => {
    let calls = 0;
    const deps = fakeDeps({
      fetch: async () => {
        calls++;
        return new Response("", { status: 503 });
      },
    });
    const message = buildNotificationMessage(notification(), "created", "http://h");
    await expect(sendToChannel(channel(), message, deps)).rejects.toThrow("HTTP 503");
    expect(calls).toBe(3);
  });

  test("does not retry a 4xx and never puts the URL in the error", async () => {
    let calls = 0;
    const deps = fakeDeps({
      fetch: async () => {
        calls++;
        throw new TypeError(`connect failed ${SLACK_URL}`);
      },
    });
    const message = buildNotificationMessage(notification(), "created", "http://h");
    const slack = channel({ type: "slack", url: undefined, urlEnv: DEFAULT_SLACK_URL_ENV });
    const error = await sendToChannel(slack, message, deps).catch((e: Error) => e);
    expect(String(error)).not.toContain("hooks.slack.com");
    expect(calls).toBe(3);

    calls = 0;
    const notFound = fakeDeps({
      fetch: async () => {
        calls++;
        return new Response("", { status: 404 });
      },
    });
    await expect(sendToChannel(slack, message, notFound)).rejects.toThrow(
      "Slack answered HTTP 404",
    );
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher (real SQLite)
// ---------------------------------------------------------------------------

describe("NotificationDispatcher", () => {
  let dir: string;
  let db: Database;
  let clock: number;
  let emitter: NotificationEmitter;
  let settings: NotificationsSettings;
  let deps: ReturnType<typeof fakeDeps>;
  let warnings: string[];

  const config = () => ({
    workspace: { dashboardPort: 4400 } as never,
    dashboard: { allowedOrigins: [], tailscaleAutodetect: true },
    notifications: settings,
  });

  function dispatcher(): NotificationDispatcher {
    return new NotificationDispatcher(db, {
      config,
      deps,
      now: () => clock,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    });
  }

  function emit(overrides: Partial<NotificationInput> = {}) {
    return emitter.emit({
      kind: "internal_error",
      severity: "high",
      groupKey: "internal_error:verify:boom",
      title: "Likely DevIntern bug: verify failed",
      body: "verify: boom",
      ...overrides,
    });
  }

  function sentBodies(): Array<Record<string, unknown>> {
    return deps.sent.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notification-delivery-"));
    db = new Database(join(dir, "queue.db"));
    db.run("CREATE TABLE runs (id INTEGER PRIMARY KEY, outcome_class TEXT)");
    clock = Date.UTC(2026, 10, 26, 12, 0);
    emitter = new NotificationEmitter(db, () => clock);
    settings = { channels: [channel()] };
    deps = fakeDeps();
    warnings = [];
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("never sends the backlog from before delivery started", async () => {
    emit();
    clock += 1_000;
    const d = dispatcher();
    expect((await d.tick()).sent).toBe(0);
    expect(deps.sent).toEqual([]);
  });

  test("sends a new notification once, then a resurfaced group after the window", async () => {
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    expect((await d.tick()).sent).toBe(1);
    expect(sentBodies()[0]).toMatchObject({ event: "created" });
    expect((await d.tick()).sent).toBe(0);

    // A flood of the same cause inside the window is held...
    for (let run = 2; run <= 20; run++) {
      clock += MINUTE;
      emit({ runId: run });
      const summary = await d.tick();
      expect(summary.sent).toBe(0);
    }
    expect(deps.sent).toHaveLength(1);

    // ...and goes out once, with the latest count, when the window ends.
    clock += 60 * MINUTE;
    expect((await d.tick()).sent).toBe(1);
    expect(sentBodies()[1]).toMatchObject({ event: "resurfaced", notification: { count: 20 } });
    expect((await d.tick()).sent).toBe(0);
  });

  test("held groups never crowd new notifications out of a tick", async () => {
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    // More held groups than one tick reads (CANDIDATE_LIMIT = 100).
    for (let group = 0; group < 120; group++) emit({ groupKey: `flood:${group}`, runId: group });
    expect((await d.tick()).sent).toBe(100);
    expect((await d.tick()).sent).toBe(20);
    clock += MINUTE;
    for (let group = 0; group < 120; group++) {
      emit({ groupKey: `flood:${group}`, runId: 1_000 + group });
    }
    emit({ groupKey: "brand-new", runId: 999 });
    const summary = await d.tick();
    expect(summary.sent).toBe(1);
    expect(sentBodies().at(-1)).toMatchObject({ notification: { groupKey: "brand-new" } });

    // The held groups still go out, with their latest count, after the window.
    clock += 60 * MINUTE;
    expect((await d.tick()).sent).toBe(100);
    expect((await d.tick()).sent).toBe(20);
    expect(sentBodies().at(-1)).toMatchObject({ event: "resurfaced", notification: { count: 2 } });
  });

  test("a channel turned back on does not send what it missed while off", async () => {
    const d = dispatcher();
    await d.tick();
    settings = { channels: [] };
    clock += MINUTE;
    await d.tick();
    for (let group = 0; group < 5; group++) emit({ groupKey: `off:${group}`, runId: group });
    clock += 60 * MINUTE;
    await d.tick();
    settings = { channels: [channel()] };
    clock += MINUTE;
    expect((await d.tick()).sent).toBe(0);
    clock += 1_000;
    emit({ groupKey: "after", runId: 99 });
    expect((await d.tick()).sent).toBe(1);
  });

  test("a worker restart still catches up on what it missed while stopped", async () => {
    await dispatcher().tick();
    clock += 1_000;
    emit({ runId: 1 });
    clock += 30 * MINUTE;
    expect((await dispatcher().tick()).sent).toBe(1);
  });

  test("a worker stopped mid-tick keeps later channels' catch-up and digest state", async () => {
    let hang = false;
    const base = fakeDeps();
    deps = {
      ...base,
      fetch: (url, init) =>
        hang && url === SLACK_URL ? new Promise<Response>(() => {}) : base.fetch(url, init),
    };
    const webhookUrl = "https://hooks.example.com/devintern";
    settings = {
      timezone: "UTC",
      channels: [
        channel({ type: "slack", url: undefined, urlEnv: DEFAULT_SLACK_URL_ENV }),
        channel({ url: webhookUrl, digestTime: { spec: "23:00", minutes: 23 * 60 } }),
      ],
    };
    await dispatcher().tick();
    const webhookRow = () =>
      db
        .query(
          "SELECT since, last_digest_at FROM notification_delivery_channels WHERE channel = 'webhook'",
        )
        .get() as { since: number; last_digest_at: number | null };
    const before = webhookRow();
    expect(before.last_digest_at).toBe(clock);
    clock += 1_000;
    emit({ runId: 1 });
    clock += 30 * MINUTE;
    hang = true;
    // The Slack send never returns: the worker is stopped before webhook runs.
    void dispatcher().tick();
    await Bun.sleep(0);
    hang = false;
    clock += MINUTE;
    await dispatcher().tick();
    expect(webhookRow()).toEqual(before);
    expect(base.sent.filter((request) => request.url === webhookUrl)).toHaveLength(1);
  });

  test("filters by severity and kind, and never sends on auto-resolve by default", async () => {
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr_opened:acme:day" });
    const result = emit({ groupKey: "g1", runId: 1 });
    await d.tick();
    expect(deps.sent).toHaveLength(1);
    emitter.resolve({ kinds: ["internal_error"], groupKey: "g1" });
    clock += 1_000;
    await d.tick();
    expect(deps.sent).toHaveLength(1);
    expect(result.notification?.id).toBeGreaterThan(0);
  });

  test("notify_resolved sends one resolve message for delivered rows", async () => {
    settings = { channels: [channel({ notifyResolved: true })] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ groupKey: "g1", runId: 1 });
    await d.tick();
    clock += 1_000;
    emitter.resolve({ kinds: ["internal_error"], groupKey: "g1" });
    expect((await d.tick()).resolved).toBe(1);
    expect((await d.tick()).resolved).toBe(0);
    expect(sentBodies().map((body) => body.event)).toEqual(["created", "resolved"]);
  });

  test("a failing channel is logged, marked handled, and never throws", async () => {
    deps = fakeDeps({
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    const summary = await d.tick();
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(
      warnings.some((line) => line.includes("delivery of notification") && line.includes("failed")),
    ).toBe(true);
    expect((await d.tick()).failed).toBe(0);
    // The notification itself is untouched.
    expect(emitter.store.list().notifications).toHaveLength(1);
  });

  test("an unavailable channel warns once and skips", async () => {
    settings = { channels: [channel({ type: "slack", url: undefined, urlEnv: "MISSING_URL" })] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    await d.tick();
    await d.tick();
    expect(deps.sent).toEqual([]);
    expect(warnings.filter((line) => line.includes("MISSING_URL is not set"))).toHaveLength(1);
  });

  test("tick resolves even when delivery state reads fail", async () => {
    const d = dispatcher();
    await d.tick();
    // A malformed state row makes lastTickAt() throw inside tick().
    db.run("DROP TABLE notification_delivery_ticks");
    db.run("CREATE TABLE notification_delivery_ticks (id INTEGER PRIMARY KEY, last_tick_at TEXT)");
    db.run("INSERT INTO notification_delivery_ticks (id, last_tick_at) VALUES (1, 'junk')");
    clock += 1_000;
    expect(await d.tick()).toMatchObject({ sent: 0, failed: 0 });
    expect(warnings.some((line) => line.includes("delivery tick failed"))).toBe(true);
  });

  test("a repeat held by a window longer than a day still goes out", async () => {
    settings = { channels: [channel({ rateLimitMinutes: 2 * 24 * 60 })] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    expect((await d.tick()).sent).toBe(1);
    clock += MINUTE;
    emit({ runId: 2 });
    expect((await d.tick()).sent).toBe(0);
    clock += 49 * 60 * MINUTE;
    expect((await d.tick()).sent).toBe(1);
    expect(sentBodies()[1]).toMatchObject({ event: "resurfaced", notification: { count: 2 } });
  });

  test("a group held by a window longer than the prune age keeps its send time", async () => {
    settings = { channels: [channel({ rateLimitMinutes: 10 * 24 * 60 })] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    expect((await d.tick()).sent).toBe(1);
    clock += MINUTE;
    emit({ runId: 2 });
    // Past the 7-day prune age (prune runs hourly), still inside the window.
    clock += 8 * 24 * 60 * MINUTE;
    expect((await d.tick()).sent).toBe(0);
    clock += 2 * 24 * 60 * MINUTE;
    expect((await d.tick()).sent).toBe(1);
  });

  test("a digest that could not go out is sent once the channel is back", async () => {
    settings = {
      timezone: "UTC",
      channels: [
        channel({
          type: "slack",
          url: undefined,
          urlEnv: DEFAULT_SLACK_URL_ENV,
          digestTime: { spec: "13:00", minutes: 13 * 60 },
        }),
      ],
    };
    const d = dispatcher();
    await d.tick();
    clock += MINUTE;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:day", title: "1 PR opened" });
    await d.tick();
    const env = deps.env as Record<string, string | undefined>;
    delete env[DEFAULT_SLACK_URL_ENV];
    clock = Date.UTC(2026, 10, 26, 13, 1);
    expect((await d.tick()).digests).toBe(0);
    env[DEFAULT_SLACK_URL_ENV] = SLACK_URL;
    clock = Date.UTC(2026, 10, 26, 13, 6);
    expect((await d.tick()).digests).toBe(1);
    expect(deps.sent).toHaveLength(1);
    expect((await d.tick()).digests).toBe(0);
  });

  test("a failed digest send is retried later, not every tick", async () => {
    let fail = true;
    const base = fakeDeps();
    deps = {
      ...base,
      fetch: async (url, init) => {
        if (fail) throw new TypeError("network down");
        return base.fetch(url, init);
      },
    };
    settings = {
      timezone: "UTC",
      channels: [channel({ digestTime: { spec: "13:00", minutes: 13 * 60 } })],
    };
    const d = dispatcher();
    await d.tick();
    clock += MINUTE;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:day", title: "1 PR opened" });
    await d.tick();
    clock = Date.UTC(2026, 10, 26, 13, 1);
    expect((await d.tick()).digests).toBe(0);
    fail = false;
    clock += MINUTE;
    expect((await d.tick()).digests).toBe(0);
    expect(base.sent).toHaveLength(0);
    clock += 15 * MINUTE;
    expect((await d.tick()).digests).toBe(1);
    expect(base.sent).toHaveLength(1);
  });

  test("daily digest: routine items once a day after the configured time", async () => {
    // 12:00 UTC; digest at 13:00 UTC.
    settings = {
      timezone: "UTC",
      channels: [channel({ digestTime: { spec: "13:00", minutes: 13 * 60 } })],
    };
    const d = dispatcher();
    await d.tick();
    clock += MINUTE;
    db.run("INSERT INTO runs (id, outcome_class) VALUES (10, 'review_hold'), (11, 'internal')");
    emit({ kind: "escalated", groupKey: "esc:hold", runId: 10, title: "PR held for review" });
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:day", title: "1 PR opened" });
    emit({ groupKey: "internal", runId: 11, title: "Likely DevIntern bug" });
    await d.tick();
    // Only the internal error went out right away.
    expect(sentBodies().map((body) => (body.notification as Notification).title)).toEqual([
      "Likely DevIntern bug",
    ]);

    clock = Date.UTC(2026, 10, 26, 13, 5);
    expect((await d.tick()).digests).toBe(1);
    const digest = sentBodies()[1] as {
      type: string;
      digest: { total: number; top: Array<{ title: string }> };
    };
    expect(digest.type).toBe("digest");
    expect(digest.digest.total).toBe(2);
    expect(digest.digest.top.map((item) => item.title).sort()).toEqual([
      "1 PR opened",
      "PR held for review",
    ]);

    // Not again the same day.
    clock += 60 * MINUTE;
    expect((await d.tick()).digests).toBe(0);
    // Next day with nothing new: no empty digest.
    clock = Date.UTC(2026, 10, 27, 13, 5);
    expect((await d.tick()).digests).toBe(0);
  });

  test("a digest channel turned back on does not digest what it missed while off", async () => {
    const digestChannel = channel({ digestTime: { spec: "13:00", minutes: 13 * 60 } });
    settings = { timezone: "UTC", channels: [digestChannel] };
    const d = dispatcher();
    await d.tick();
    settings = { timezone: "UTC", channels: [] };
    clock += MINUTE;
    await d.tick();
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:off", title: "While off" });
    clock += MINUTE;
    await d.tick();
    settings = { timezone: "UTC", channels: [digestChannel] };
    clock += MINUTE;
    await d.tick();
    clock += MINUTE;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:on", title: "After" });
    clock = Date.UTC(2026, 10, 26, 13, 5);
    expect((await d.tick()).digests).toBe(1);
    const digest = sentBodies().find((body) => body.type === "digest") as {
      digest: { top: Array<{ title: string }> };
    };
    expect(digest.digest.top.map((item) => item.title)).toEqual(["After"]);
  });

  test("digest_time removed and added back does not digest the gap", async () => {
    const plain = channel();
    const withDigest = channel({ digestTime: { spec: "13:00", minutes: 13 * 60 } });
    settings = { timezone: "UTC", channels: [withDigest] };
    const d = dispatcher();
    await d.tick();
    settings = { timezone: "UTC", channels: [plain] };
    clock += MINUTE;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:gap", title: "Gap" });
    await d.tick();
    settings = { timezone: "UTC", channels: [withDigest] };
    clock += MINUTE;
    await d.tick();
    clock += MINUTE;
    emit({ kind: "pr_opened", severity: "normal", groupKey: "pr:on", title: "After" });
    clock = Date.UTC(2026, 10, 26, 13, 5);
    expect((await d.tick()).digests).toBe(1);
    const digest = sentBodies().find((body) => body.type === "digest") as {
      digest: { top: Array<{ title: string }> };
    };
    expect(digest.digest.top.map((item) => item.title)).toEqual(["After"]);
  });

  test("a failed resolve message is retried on a later tick, not marked sent", async () => {
    let down = false;
    let fetches = 0;
    const base = fakeDeps();
    deps = fakeDeps({
      fetch: async (url, init) => {
        fetches++;
        if (down) return new Response("", { status: 503 });
        return base.fetch(url, init);
      },
    });
    settings = { channels: [channel({ notifyResolved: true })] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ groupKey: "g1", runId: 1 });
    expect((await d.tick()).sent).toBe(1);
    clock += 1_000;
    emitter.resolve({ kinds: ["internal_error"], groupKey: "g1" });
    down = true;
    expect(await d.tick()).toMatchObject({ resolved: 0, failed: 1 });
    expect(fetches).toBe(1 + 3);
    down = false;
    clock += 1_000;
    expect((await d.tick()).resolved).toBe(1);
    expect((await d.tick()).resolved).toBe(0);
    const events = base.sent.map(
      (request) => (JSON.parse(request.body) as { event: string }).event,
    );
    expect(events).toEqual(["created", "resolved"]);
  });

  test("a dead endpoint costs one retry budget per tick; the rest go out later", async () => {
    let down = true;
    let fetches = 0;
    let sleeps = 0;
    const delivered = new Set<number>();
    deps = fakeDeps({
      fetch: async (_url, init) => {
        fetches++;
        if (down) return new Response("", { status: 503 });
        const body = JSON.parse(String(init.body)) as { notification: { id: number } };
        delivered.add(body.notification.id);
        return new Response("ok", { status: 200 });
      },
      sleep: async () => {
        sleeps++;
      },
    });
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    for (let group = 0; group < 100; group++) emit({ groupKey: `dead:${group}`, runId: group });
    expect(await d.tick()).toMatchObject({ sent: 0, failed: 1 });
    expect({ fetches, sleeps }).toEqual({ fetches: 3, sleeps: 2 });
    down = false;
    clock += 1_000;
    expect(await d.tick()).toMatchObject({ sent: 99, failed: 0 });
    expect(delivered.size).toBe(99);
  });

  test("a hanging channel does not delay the other channels", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps = fakeDeps({
      run: async () => {
        await gate;
        return { exitCode: 0, stderr: "" };
      },
    });
    settings = { channels: [channel({ type: "desktop", url: undefined }), channel()] };
    const d = dispatcher();
    await d.tick();
    clock += 1_000;
    emit({ runId: 1 });
    const pending = d.tick();
    await Bun.sleep(20);
    // The webhook (listed after desktop) sent while desktop is still blocked.
    expect(deps.sent).toHaveLength(1);
    release();
    expect(await pending).toMatchObject({ sent: 2, failed: 0 });
  });
});

describe("runCommand", () => {
  test("returns the exit code and stderr", async () => {
    expect(await runCommand(["sh", "-c", "echo oops >&2; exit 3"], 5_000)).toEqual({
      exitCode: 3,
      stderr: "oops\n",
    });
  });

  test("kills a command that hangs and throws a transient error", async () => {
    const started = Date.now();
    await expect(runCommand(["sleep", "30"], 200)).rejects.toThrow("sleep timed out after 200ms");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("does not wait on a grandchild that keeps stderr open", async () => {
    const started = Date.now();
    await expect(runCommand(["sh", "-c", "sleep 3 & wait"], 200)).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

describe("worker doctor notification check", () => {
  const base = {
    workspace: { dashboardPort: 4400 } as never,
    dashboard: { allowedOrigins: [], tailscaleAutodetect: true },
  };

  test("no channels is ok", async () => {
    const check = await notificationDeliveryCheck(
      { ...base, notifications: { channels: [] } },
      fakeDeps(),
      { test: false, offline: false },
    );
    expect(check).toMatchObject({ id: "notifications", status: "ok" });
    expect(check.detail).toContain("no channels configured");
  });

  test("lists channels and warns about one that cannot send", async () => {
    const check = await notificationDeliveryCheck(
      {
        ...base,
        notifications: {
          channels: [
            channel({ type: "desktop", url: undefined }),
            channel({ type: "slack", url: undefined, urlEnv: "NOPE" }),
          ],
        },
      },
      fakeDeps(),
      { test: false, offline: false },
    );
    expect(check.status).toBe("warn");
    expect(check.hint).toBeTruthy();
    expect(check.items?.[0]).toStartWith("✓ desktop: via notify-send; high severity");
    expect(check.items?.[1]).toStartWith("✗ slack: NOPE is not set");
  });

  test("--test-notifications sends through each channel and fails on a broken one", async () => {
    const deps = fakeDeps({
      fetch: async () => new Response("", { status: 403 }),
    });
    const check = await notificationDeliveryCheck(
      {
        ...base,
        notifications: { channels: [channel({ type: "desktop", url: undefined }), channel()] },
      },
      deps,
      { test: true, offline: false },
    );
    expect(deps.commands).toHaveLength(1);
    expect(deps.commands[0]?.[4]).toBe("DevIntern test notification");
    expect(check.status).toBe("fail");
    expect(check.items).toContain("  test message sent");
    expect(check.items).toContain("  test failed: webhook answered HTTP 403");
  });

  test("collectWorkerDoctorChecks reads the URL from the workspace .env", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "notification-doctor-"));
    try {
      const workspacePath = join(workspaceDir, "workspace.toml");
      writeFileSync(
        workspacePath,
        `
[defaults]
tracker = "jira"
task_query = "labels = devintern"

[[repos]]
name = "web"
remote = "git@github.com:acme/web.git"

[notifications.slack]
`,
      );
      writeFileSync(
        join(workspaceDir, ".env"),
        `JIRA_BASE_URL=https://acme.atlassian.net\nJIRA_EMAIL=a@b.c\nJIRA_API_TOKEN=x\nSLACK_WEBHOOK_URL=${SLACK_URL}\n`,
      );
      const deps = fakeDeps();
      const checks = await collectWorkerDoctorChecks(
        { workspacePath, testNotifications: true },
        {
          processEnv: {},
          probeCredentials: async () => {},
          dryRunQuery: async () => 1,
          checkRepoAccess: async () => ({ ok: true }),
          checkEntitlement: async () => ({ valid: true, source: "entitlement", message: "" }),
          checkHarness: async () => ({ id: "harness", label: "h", status: "ok" }),
          checkSandbox: async () => ({ id: "sandbox", label: "s", status: "ok" }),
          isPortInUse: async () => false,
          workerStatus: () => ({ status: "stopped" }),
          notificationChannelDeps: deps,
        },
      );
      const check = checks.find((entry) => entry.id === "notifications");
      expect(check?.status).toBe("ok");
      expect(deps.sent.map((request) => request.url)).toEqual([SLACK_URL]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
