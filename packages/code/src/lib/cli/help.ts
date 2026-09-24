/**
 * Extended `devintern --help` examples appended after the option list.
 * Kept separate from `program.ts` so the command wiring stays readable.
 */
export const HELP_EXAMPLES = `
Examples (Jira):
  devintern PROJ-123 --create-pr
  devintern PROJ-123 PROJ-456 PROJ-789 --create-pr
  devintern --query "project = PROJ AND status = 'To Do'" --create-pr

Examples (Linear; set TASK_TRACKER=linear in .devintern-code/.env):
  devintern ENG-42 --create-pr
  devintern ENG-42 ENG-43 ENG-44 --create-pr
  devintern https://linear.app/acme/issue/ENG-42/issue-slug --create-pr
  devintern --query '{"state":{"name":{"eq":"Todo"}}}' --create-pr
  devintern --query "login bug" --create-pr

Examples (GitHub Issues; set TASK_TRACKER=github and GITHUB_REPO in .devintern-code/.env):
  devintern 123 --create-pr
  devintern https://github.com/acme/webapp/issues/123 --create-pr
  devintern --query "is:open label:bug" --create-pr

Examples (GitLab; set TASK_TRACKER=gitlab and GITLAB_PROJECT in .devintern-code/.env):
  devintern 123 --create-pr
  devintern https://gitlab.com/group/sub/repo/-/issues/123 --create-pr
  devintern --query "is:open label:bug" --create-pr

Examples (Azure DevOps; set TASK_TRACKER=azure-devops in .devintern-code/.env):
  devintern 4211 --create-pr
  devintern https://dev.azure.com/my-org/MyProject/_workitems/edit/4211 --create-pr
  devintern --query "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'New'" --create-pr

Examples (Asana; set TASK_TRACKER=asana in .devintern-code/.env):
  devintern 1200000000000001 --create-pr
  devintern https://app.asana.com/0/1200000000000000/1200000000000001 --create-pr
  devintern --query 'section:"To Do" completed:false' --create-pr

Examples (Trello; set TASK_TRACKER=trello in .devintern-code/.env):
  devintern 4uWKPOTv --create-pr
  devintern https://trello.com/c/4uWKPOTv/card-slug --create-pr
  devintern --query 'list:"To Do" is:open' --create-pr

Examples (Markdown; no PM credentials required for file paths):
  devintern ./tasks/feature-spec.md --no-git
  devintern /path/to/my-task.md --create-pr
  devintern ./epic.md ./subtask-a.md ./subtask-b.md --no-git

Examples (Markdown tracker; set TASK_TRACKER=markdown and MARKDOWN_TASKS_DIR in .devintern-code/.env):
  devintern 2025-01-01T12-00-00-abcd-my-feature --create-pr
  devintern --query "status=todo" --create-pr

Subcommands:
  init                 Initialize .devintern-code configuration in current directory
                       Interactive wizard in a terminal; pass --yes (or --no-interactive)
                       to write the config templates without prompts
  worker               Run the workspace worker daemon;
                        'worker init' writes a workspace, ready-tasks query,
                        relay pairing, and the GitHub App (@mentions)
  dashboard            Serve the local observability dashboard (run history and stats)
  webhook serve        Start the advanced repo-local direct-webhook server
  address-review       Address review feedback on an existing pull request
  resolve-conflicts    Merge a PR's base branch into it, resolving conflicts
  login [method]       Sign in (github | google | x | email; prompts if omitted)
  logout               Clear local auth session
  whoami               Show current authenticated user
   sandbox              Sandbox doctor: providers, remaining setup steps, and what
                        the next run will do (exit 1 if it would fail)
  doctor               Readiness check: runtime, git, agent CLI, tracker
                        credentials, sign-in, license (exit 1 if anything fails)

Run 'devintern <subcommand> --help' for subcommand-specific options.`;
