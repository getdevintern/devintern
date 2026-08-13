/**
 * Slack app manifest for the devpm bot.
 *
 * Users create their own Slack app from this manifest (pre-filled URL), so
 * all credentials stay in their workspace and their `.devintern-pm/.env`.
 */

export const SLACK_APP_MANIFEST = {
  display_information: {
    name: "DevIntern PM",
    description: "Draft and file tracker tasks from chat with AI",
    background_color: "#1a1a2e",
  },
  features: {
    bot_user: {
      display_name: "devpm",
      always_online: true,
    },
    slash_commands: [
      {
        command: "/devpm",
        description: "Draft a task from a rough idea",
        usage_hint: "users should be able to reset their password",
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "chat:write",
        "commands",
        "reactions:read",
        "reactions:write",
        "channels:history",
        "groups:history",
        "im:history",
        "im:write",
        "im:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "reaction_added",
      ],
    },
    interactivity: {
      is_enabled: true,
    },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
} as const;

/** Slack's "create app from manifest" URL with the manifest pre-filled. */
export function buildSlackManifestUrl(): string {
  const manifest = encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${manifest}`;
}
