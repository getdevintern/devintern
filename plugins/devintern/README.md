# DevIntern plugin for Claude Code

Agent Skills that teach Claude Code to set up a self-hosted [DevIntern](https://devintern.com) worker, configure its workspace, delegate implementation tasks, and file redacted bug reports.

```text
/plugin marketplace add getdevintern/devintern
/plugin install devintern@devintern
```

| Skill                                                      | Purpose                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [devintern-setup](skills/devintern-setup/SKILL.md)         | Install DevIntern Code, connect code-host and tracker accounts, start a worker. |
| [devintern-workspace](skills/devintern-workspace/SKILL.md) | Change repositories, routing, schedules, monitors, and policies of a worker.    |
| [devintern-delegate](skills/devintern-delegate/SKILL.md)   | Queue agreed work as an ad-hoc task on a registered worker repository.          |
| [devintern-report](skills/devintern-report/SKILL.md)       | Diagnose a DevIntern failure and file a redacted bug report.                    |

The skills are instructions only. They contain no scripts, hooks, MCP servers, or connectors, and they act by running the `devintern` CLI with your approval. See the [agent skills guide](https://devintern.com/docs/code/agent-skills).

## Data handling

The plugin itself stores nothing. The `devintern` commands the skills run read and write local configuration (`workspace.toml` and owner-only `.env` files holding the credentials you provide) and may contact these services:

- **Your code host and task tracker** (for example GitHub, GitLab, Jira, Linear) using the credentials you configure, to read tickets and open pull requests.
- **Your coding agent's provider** (for example Anthropic or OpenAI), when the worker runs a task.
- **DevIntern services at devintern.com**: account sign-in and license checks; the optional hosted webhook relay, which forwards provider webhook events to your worker; and bug reports from `devintern report`.
- **Sentry error tracking**: the CLI sends scrubbed crash and failure reports (identifiers such as task key and stage, never task content, code, or credentials) to DevIntern's Sentry project. Set `SENTRY_DISABLED=1` to opt out. See [error reporting](https://devintern.com/docs/code/configuration).

Bug reports are redacted before upload, previewed, and sent only after you approve. Anonymous reports include the contact email you give. Task descriptions, prompts, diffs, and repository identifiers are excluded unless you opt in. See the [Privacy policy](https://devintern.com/privacy/) and [security overview](https://devintern.com/security/).
