---
title: "Create Trello Cards with DevIntern PM"
sidebarLabel: "Trello Integration"
description: "Create Trello cards from AI drafts on the boards your team already uses."
section: "Create Tasks"
order: 5
dateModified: 2026-11-18
sidebarHidden: true
---

# Create Trello Cards with DevIntern PM

DevIntern PM creates Trello cards from AI-drafted stories. It ships with a built-in Power-Up key, so you only need to authorize your account once.

## Prerequisites

- A Trello account with at least one board that has at least one list.

## Setup

1. Set `TASK_TRACKER=trello` in `.devintern-pm/.env` (or run `devpm init`).
2. Run `devpm`. It prints an authorization URL; open it, click **Allow**, and copy the token. You can also open the URL directly:

   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=b2d5d1ced28b515c6eb66c40187400b0
   ```

3. Add the token:

   ```bash
   TRELLO_API_TOKEN=your-generated-token
   ```

The token does not expire; revoke it any time from your [Trello account settings](https://trello.com/u/me/account).

| Variable                   | Required | Purpose                                                                                                   |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `TRELLO_API_TOKEN`         | yes      | Token from the authorization URL above.                                                                   |
| `TRELLO_DEFAULT_BOARD_ID`  | no       | Board ID from the URL (`abc123` in `trello.com/b/abc123/My-Board`). Defaults to your first board.          |
| `TRELLO_DEFAULT_LIST_NAME` | no       | Exact list title, e.g. `"To Do"`. Defaults to the first list (also used if the name doesn't match).        |
| `TRELLO_API_KEY`           | no       | Your own Power-Up key, from [trello.com/power-ups/admin](https://trello.com/power-ups/admin) → **API Key**, if you need separate rate limits for heavy automation. |

## Usage

```bash
devpm --interactive
```

| devpm concept      | Trello object                     |
| ------------------ | --------------------------------- |
| Story / Task / Bug | Card in the target list           |
| Subtask            | Checklist item on the parent card |
| Epic link          | Not supported (step is skipped)   |

Issue type selection is also skipped.

## Troubleshooting

**"Trello backend requires TRELLO_API_TOKEN"**: open the URL printed in the error, click **Allow**, and add the token.

**"No Trello boards found" / "No lists found on Trello board"**: create a board, and at least one list on it.

**401 errors after it worked before**: the token was revoked. Check [account settings](https://trello.com/u/me/account) and authorize again.

**Rate limit errors (429)**: the shared key allows 300 requests per 10 seconds across all users, far above a normal run. Under heavy automation, set your own `TRELLO_API_KEY`.
