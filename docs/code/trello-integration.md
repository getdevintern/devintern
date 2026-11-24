---
title: "Implement Trello Cards with DevIntern Code"
sidebarLabel: "Trello Integration"
description: "Fetch Trello cards, move lists, implement with your coding agent, and post results back to the card."
section: "Automation"
order: 5
sidebarHidden: true
dateModified: 2026-11-18
---

# Implement Trello Cards with DevIntern Code

DevIntern Code reads a Trello card (description, labels, comments), checks that it is clear enough to implement, moves it between lists, runs your coding agent, opens a pull request, and posts the result back on the card.

## Prerequisites

- `@getdevintern/code` installed and a Git repository for your project
- A Trello Power-Up API key and a user token with read/write access

## Setup

1. **API key:** create or open a Power-Up at [trello.com/power-ups/admin](https://trello.com/power-ups/admin) and copy the key from the **API Key** tab.
2. **Token:** open this URL with your key, click **Allow**, and copy the token:
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=DevIntern&key=YOUR_API_KEY`

Then set in this repository's env file (`~/.devintern/env/<repo>.env`, created by `devintern init`):

| Variable                  | Required    | Description                                                                                    |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `TASK_TRACKER`            | Yes         | `trello`                                                                                       |
| `TRELLO_API_KEY`          | Yes         | Power-Up API key                                                                               |
| `TRELLO_API_TOKEN`        | Yes         | User token                                                                                     |
| `TRELLO_DEFAULT_BOARD_ID` | For worker  | Board short ID from `trello.com/b/{boardId}/...`. Scopes `--query`, is the settings fallback, and is required for worker polling and relay |

## Run a task

Pass a card short link, full URL, or 24-character card ID:

```bash
devintern 4uWKPOTv --create-pr
devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr
```

Batch runs use [Trello search operators](https://support.atlassian.com/trello/docs/searching-for-cards-all-boards/), scoped to `TRELLO_DEFAULT_BOARD_ID` when set. The first 100 matches run in sequence:

```bash
devintern --query 'list:"To Do" is:open' --create-pr
```

Use `--skip-clarity-check` to skip the feasibility check. `--skip-comments` skips comments **and** list moves. `--estimate` is not supported for Trello.

## Status mapping

Configure lists under `[trackers]` in `~/.devintern/workspace.toml`, keyed by the board short ID (from the board URL, not the 24-character internal ID). List names are matched case-insensitively.

```toml
[trackers.trello.projects.abc123]
in_progress_status = "Doing"
todo_status = "To Do"
pr_status = "Review"
```

| Field              | When it is applied                                   |
| ------------------ | ---------------------------------------------------- |
| `in_progress_status` | Implementation starts (after the feasibility check)  |
| `pr_status`         | A pull request is created                            |
| `todo_status`       | The run is incomplete, fails, or hits the turn limit |

## Worker notes

- [Worker polling](./worker.md#polling-mode) reads the board's activity feed and refuses to start without `TRELLO_DEFAULT_BOARD_ID`. PR'd cards are marked actioned and not re-implemented until they change; see [Tickets already actioned after a PR](./worker-troubleshooting.md#tickets-already-actioned-after-a-pr).
- For instant pickup, run `devintern worker connect trello` to register a board webhook through the [relay](./relay.md).

## Troubleshooting

| Symptom                                         | Fix                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Missing required Trello environment variables` | Set `TRELLO_API_KEY` and `TRELLO_API_TOKEN`.                                                            |
| Card does not move between lists                | Check list names and that the `[trackers]` key is the board short ID. Do not pass `--skip-comments`. |
| `List "Doing" not found on board`               | Fix the spelling; the error lists the board's lists.                                                    |
| `Could not initialize the trello change detector` | Set `TRELLO_DEFAULT_BOARD_ID` for the worker.                                                        |
