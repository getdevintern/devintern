import { checkLicense } from "@devintern/license-check";
import { enforceLicenseOrExit, loadEnvironment, loadSupabaseConfig } from "../cli/bootstrap";

function printWebhookHelp(): void {
  console.log("Usage: devintern webhook <command>");
  console.log("");
  console.log("Run advanced direct-webhook services. Relay is recommended for normal workers.");
  console.log("");
  console.log("Commands:");
  console.log("  serve               Start the repo-local GitHub/GitLab webhook server");
  console.log("");
  console.log("Run 'devintern webhook serve --help' for command-specific options.");
}

function printWebhookServeHelp(): void {
  console.log("Usage: devintern webhook serve [options]");
  console.log("");
  console.log("Start the repo-local webhook server for GitHub PR and GitLab MR events.");
  console.log("");
  console.log("Options:");
  console.log("  --port <port>  Port to listen on (default: 3000, or WEBHOOK_PORT env var)");
  console.log("  --host <host>  Host to bind to (default: 0.0.0.0, or WEBHOOK_HOST env var)");
  console.log("  -h, --help     Display this help message");
  console.log("");
  console.log("Environment variables:");
  console.log("  WEBHOOK_SECRET      (required) Secret for verifying GitHub webhook signatures");
  console.log("  GITLAB_WEBHOOK_SECRET  Secret token for GitLab project webhooks");
  console.log("  GITLAB_WEBHOOK_SIGNING_TOKEN  Standard Webhooks signing token (GitLab 19+)");
  console.log("  At least one provider webhook secret is required.");
  console.log("  WEBHOOK_PORT        Port to listen on (default: 3000)");
  console.log("  WEBHOOK_HOST        Host to bind to (default: 0.0.0.0)");
  console.log("  WEBHOOK_AUTO_REPLY  Set to 'true' to automatically reply to review comments");
  console.log("  WEBHOOK_VALIDATE_IP Set to 'true' to only accept requests from GitHub IPs");
  console.log("  WEBHOOK_DEBUG       Set to 'true' for verbose logging");
}

async function runWebhookServeCommand(args: string[]): Promise<void> {
  let portOverride: number | undefined;
  let hostOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      portOverride = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      hostOverride = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printWebhookServeHelp();
      return;
    } else {
      console.error(`❌ Unknown webhook serve option: ${args[i]}`);
      console.error("   Run 'devintern webhook serve --help' for usage.");
      process.exitCode = 1;
      return;
    }
  }

  loadEnvironment();
  const port = portOverride ?? parseInt(process.env.WEBHOOK_PORT || "3000", 10);
  const host = hostOverride ?? (process.env.WEBHOOK_HOST || "0.0.0.0");
  const licenseResult = await checkLicense({
    productKey: "devintern/code",
    supabaseConfig: loadSupabaseConfig(),
    requireAutomation: true,
  });
  await enforceLicenseOrExit(licenseResult);

  const { startWebhookServer } = await import("../../webhook-server");
  await startWebhookServer({ port, host });
}

/** Dispatch `devintern webhook <command>`. */
export async function runWebhookCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printWebhookHelp();
    return;
  }
  if (command !== "serve") {
    console.error(`❌ Unknown webhook command: ${command}`);
    console.error("   Run 'devintern webhook --help' for usage.");
    process.exitCode = 1;
    return;
  }
  await runWebhookServeCommand(args.slice(1));
}
