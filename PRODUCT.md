# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a developer or software team with a backlog in an existing tracker and repositories where human reviewers approve pull requests. They want coding work to continue without supervising every agent session. DevIntern PM also serves people preparing tasks for engineers or coding agents from rough ideas, logs, or designs. The site addresses engineers, product managers, engineering managers, founders, and consultants; these are audience paths, not separate products.

## Product Purpose

DevIntern's core product is a self-hosted worker that picks up ready tickets, routes them to the right repository, runs the user's coding agent locally, and opens pull requests for human review. Interactive `devintern` runs let someone try that loop one task at a time. Unattended automation keeps the loop running and brings review comments back to the same branch. DevIntern PM and its `devpm` CLI are optional intake: they turn rough input into project-grounded tickets that people and coding agents can act on, with user review before a task reaches the tracker.

## Positioning

DevIntern is a neutral layer around the user's existing tracker, coding agent, model contract, repositories, CI, and review process. The worker runs on the user's machines with their keys; switching agents does not require changing the tracker wiring or review workflow. Its value is the unattended task-to-PR and review-feedback loop, including the queue, routing, feasibility gate, run record, and recovery from interruptions. DevIntern PM improves the quality of the task entering that loop but is optional.

## Operating Context

- The product family also includes terminal CLIs and an Electron desktop app. The dashboard is a local web interface; the marketing site and its server code live in a separate repository.
- Work starts from a ready tracker ticket or local Markdown task. PM can draft a task from a prompt, error log, Figma frame, or attachment; the user can edit its scope and acceptance criteria before creating it.
- Supported tracker workflows include Jira, Linear, GitHub Issues, Trello, Asana, Azure DevOps, and Markdown files. The CLIs use installed coding-agent tools such as Claude Code, Codex, Cursor, and OpenCode.
- The worker runs on a user's laptop, devbox, or VM. Its local dashboard shows runs, logs, transcripts, artifacts, failures, and retries. A pull request and its diff are checkpoints for human reviewers, who decide what merges.
- DevIntern PM is an Electron desktop app for multi-ticket drafting. It requires Git and an installed supported agent CLI.

## Capabilities and Constraints

- Interactive `devintern` use is free without signup or a time limit. Unattended worker use is the paid line, with a no-card Worker Pilot described on the site. DevIntern PM desktop is free without signup. Check the live pricing page before repeating specific prices or license terms.
- Before implementation, the worker checks whether a task is clear enough to execute and can return questions to the tracker. Optional auto-review checks and revises the agent's diff before human review.
- The worker can poll for ready tasks, route work across repositories, run scheduled work, process review feedback on the same branch, and recover from crashes or provider rate limits.
- The dashboard and its data stay on the worker machine and bind to loopback by default.
- Source code, diffs, ticket contents, and credentials are not sent to DevIntern services as part of the worker workflow. Optional services and anonymous product analytics have narrower data flows; describe those using the current security and privacy pages rather than claiming that no data ever leaves the machine.
- The source is available under FSL-1.1-ALv2, with each release converting to Apache-2.0 after two years.
- The public repository contains the CLIs, desktop app, dashboard, shared packages, and product docs. The marketing site and server code are maintained elsewhere.
- This monorepo uses Bun for development. The `devintern` CLI requires Bun; `devpm` also supports Node.js 20+.

## Brand Commitments

- Product name: DevIntern. Product names in this repository include DevIntern PM, `devintern`, and `devpm`.
- Lead with the worker and the outcome of ready tickets becoming pull requests. The site's recurring language emphasizes the user's machines, keys, tracker, and coding agent; async work; and reviewing diffs instead of supervising agent sessions.
- Present PM as optional planning intake and keep the user's edit-and-approve step explicit. Do not imply that agents merge code or that vague tickets should be implemented without clarification.
- The DevIntern name and logo are trademarks of Daniil Pokrovsky; the repository license grants no trademark rights.

## Evidence on Hand

- [DevIntern homepage](https://devintern.com/) is the primary source for worker positioning, the task-to-PR loop, supported trackers and agents, interactive versus unattended use, and human review.
- [DevIntern PM page](https://devintern.com/pm-desktop/) is the primary source for PM purpose, inputs, review-before-create workflow, and desktop availability.
- [Privacy policy](https://devintern.com/privacy/) distinguishes local product data from anonymous analytics and optional service data flows. The homepage links to [public agent-authored pull requests](https://github.com/getdevintern/devintern/pulls?q=is%3Apr+label%3Adevintern-authored) as product proof.
- [README.md](README.md) states the product family, worker workflow, pricing summary, and repository boundaries.
- [packages/pm/README.md](packages/pm/README.md) describes PM inputs, tracker support, and its relationship to the worker.
- [packages/pm-desktop/README.md](packages/pm-desktop/README.md) documents the desktop app, including prerequisites and multi-ticket workflows.
- [docs/code/dashboard.md](docs/code/dashboard.md) documents dashboard behavior and local operation. The desktop app icon is at `packages/pm-desktop/build/icon.png`.
- No user research, customer testimonials, performance benchmarks, or visual design specification were supplied for this product record.

## Product Principles

1. Fit into the user's existing tracker, repository, agent, model contract, CI, and review workflow.
2. Move human attention to clear decisions and pull-request review while work continues asynchronously.
3. Return unclear tasks for clarification and make each run inspectable and recoverable.
4. Keep code execution and credentials under the user's control, with precise claims about optional data flows.
5. Let users prove the loop with one task before adopting unattended automation.
