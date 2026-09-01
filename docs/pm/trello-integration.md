---
title: "Create Trello Cards with @devintern/pm"
sidebarLabel: "Trello Integration"
description: "Create Trello cards from AI drafts on the boards your team already uses."
section: "PM"
order: 5
sidebarHidden: true
---

# Create Trello Cards with @devintern/pm

@devintern/pm creates Trello cards directly from AI-generated stories and tasks. Setup takes about a minute: you only need to generate an API token.

## How It Works

@devintern/pm ships with a built-in Trello Power-Up, so you don't need to register your own app. You just authorize your Trello account once and paste the token into your config.

Each story becomes a card. Subtasks become checklist items on the parent card. Issue type selection and epic linking are both skipped: Trello does not expose Jira-style issue types or a native parent hierarchy.

## Setup

### 1. Set the backend

In your `.devintern-pm/.env`:

```bash
TASK_TRACKER=trello
```

### 2. Generate your API token

Run `devpm`. If `TRELLO_API_TOKEN` is missing, it will print a direct authorization URL. Visit the URL, click **Allow**, and copy the token from the next page.

Alternatively, you can generate the token manually at any time:

```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=b2d5d1ced28b515c6eb66c40187400b0
```

> The `expiration=never` parameter creates a long-lived token so you don't need to re-authorize periodically. You can revoke it at any time from your [Trello account settings](https://trello.com/u/me/account).

### 3. Add the token to your config

```bash
TRELLO_API_TOKEN=your-generated-token
```

That's it. Run `devpm --interactive` to create your first card.

## Optional Configuration

### Default board and list

Without these set, @devintern/pm uses your first board and first list. To pin a specific destination:

```bash
TRELLO_DEFAULT_BOARD_ID=abc123
TRELLO_DEFAULT_LIST_NAME="To Do"
```

**Finding your board ID:** Open the board in Trello and look at the URL, `trello.com/b/{boardId}/{board-name}`. The short alphanumeric segment is the ID (e.g. `abc123` in `trello.com/b/abc123/My-Board`).

**List name:** Use the exact list title as shown on the board (e.g. `"To Do"`, `"Backlog"`). If the name doesn't match any list on the board, @devintern/pm falls back to the first list.

### Using your own Power-Up

If you need isolated rate limits (enterprise use, high-volume automation), register your own Power-Up:

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin) and create a new Power-Up
2. Navigate to **API Key** tab → **Generate a new API Key**
3. Add to your config:

```bash
TRELLO_API_KEY=your-own-api-key
TRELLO_API_TOKEN=your-api-token
```

When `TRELLO_API_KEY` is set, it overrides the bundled key.

## What Gets Created

| devpm concept      | Trello object                     |
| ------------------ | --------------------------------- |
| Story / Task / Bug | Card in the target list           |
| Subtask            | Checklist item on the parent card |
| Epic link          | Not supported (step is skipped)   |

## Troubleshooting

**"Trello backend requires TRELLO_API_TOKEN"**

Visit the authorization URL printed in the error, click Allow, and add the resulting token to your `.devintern-pm/.env`.

**"No Trello boards found"**

Your token authorized successfully but the account has no boards. Create at least one board in Trello first.

**"No lists found on Trello board"**

The target board exists but has no lists. Trello boards need at least one list before cards can be created.

**API 401 errors after working previously**

Your token was revoked. Go to [Trello account settings → Applications](https://trello.com/u/me/account) to check. Re-run the authorization flow to generate a new token.

**Rate limit errors (429)**

@devintern/pm uses the shared Power-Up key, which allows 300 requests per 10 seconds across all users. For a typical `devpm` run (3–5 API calls), this limit is never reached in practice. If you hit it under heavy automation, switch to your own Power-Up key via `TRELLO_API_KEY`.
