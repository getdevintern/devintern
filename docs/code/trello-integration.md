---
title: "Implement Trello Cards with @devintern/code"
sidebarLabel: "Trello Integration"
description: "Fetch Trello cards, move lists, implement with your coding agent, and post results back to the card."
section: "Code"
order: 5
dateModified: 2026-07-23
---

# Implement Trello Cards with @devintern/code

@devintern/code can implement work directly from Trello cards: fetch card details and comments, run a feasibility check, move the card between lists, execute your AI agent, commit changes, open a pull request, and post results back to the card.

## Prerequisites

- [Bun](https://bun.sh) and `@getdevintern/code` installed globally
- Trello Power-Up API key and user token with read/write access
- Git repository for your project

## Setup

### 1. Set the task tracker

In `.devintern-code/.env`:

```bash
TASK_TRACKER=trello
```

### 2. Add Trello credentials

Both variables are required for @devintern/code:

```bash
TRELLO_API_KEY=your-power-up-api-key
TRELLO_API_TOKEN=your-user-token
```

**API key:** Create or open a Power-Up at [trello.com/power-ups/admin](https://trello.com/power-ups/admin), then copy the API key from the **API Key** tab.

**API token:** Generate a token by visiting (replace `YOUR_API_KEY` with your key):

```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=YOUR_API_KEY
```

Click **Allow**, then copy the token from the page.

Optionally pin a default board:

```bash
TRELLO_DEFAULT_BOARD_ID=abc123       # board short ID from trello.com/b/{boardId}/board-name
```

`TRELLO_DEFAULT_BOARD_ID` is used for settings lookup when the board cannot be inferred from the card. Status transitions are driven entirely by the list names you configure in `settings.json` (see below), not by an environment variable.

### 3. Configure list transitions

Edit `.devintern-code/settings.json` using the board short ID as the project key:

```json
{
  "trello": {
    "projects": {
      "abc123": {
        "inProgressStatus": "Doing",
        "todoStatus": "To Do",
        "prStatus": "Review"
      }
    }
  }
}
```

List names must match your board exactly (case-insensitive). @devintern/code moves cards to:

- **inProgressStatus** when implementation starts (after the clarity check)
- **prStatus** after a pull request is created
- **todoStatus** when implementation is incomplete or max turns are reached

See [Configuration](./configuration.md) for all settings fields.

## Running a card

Pass a card short link, full URL, or 24-character card ID:

```bash
# Short link
devintern 4uWKPOTv --create-pr

# Full card URL
devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr
```

This workflow:

1. Fetches card description, labels, and comments
2. Runs a feasibility assessment (skippable with `--skip-clarity-check`)
3. Moves the card to `inProgressStatus` (unless `--skip-comments` is set)
4. Creates a feature branch, runs your agent, commits, and optionally opens a PR
5. Moves the card to `prStatus` after PR creation
6. Posts implementation or assessment comments on the card

## Batch processing with --query

Select multiple cards with [Trello search operators](https://support.atlassian.com/trello/docs/searching-for-cards-all-boards/), scoped to `TRELLO_DEFAULT_BOARD_ID` when set:

```bash
devintern --query 'list:"To Do" is:open' --create-pr
devintern --query 'label:bug login' --create-pr
```

The first 100 matching cards are processed in sequence.

## Limitations

- **Story points:** Estimation mode (`--estimate`) is not supported for Trello (no estimation concept). Estimation works with Jira, Linear, Azure DevOps, and Asana.
- **Comments:** Use `--skip-comments` to skip Trello comments and list transitions for a run.

## Troubleshooting

**"Missing required Trello environment variables"**

Ensure `TRELLO_API_KEY` and `TRELLO_API_TOKEN` are set in `.devintern-code/.env`.

**Card does not move between lists**

Confirm list names in `settings.json` match your board, and that the project key is the board short ID (from the board URL, not the 24-character internal ID). Set `TRELLO_DEFAULT_BOARD_ID` to the same short ID if needed.

**"List \"Doing\" not found on board"**

Check spelling and capitalization against the lists on your Trello board. Available lists are shown in the error message.

**Transitions skipped entirely**

List moves are tied to comment posting. Do not pass `--skip-comments` if you expect cards to move.
