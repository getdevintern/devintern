# @devintern/code Usage Guide

@devintern/code supports both single task processing and batch processing of multiple tasks from your configured tracker (Jira, Linear, Trello). Batch processing uses JQL for Jira, a JSON `IssueFilter` for Linear, or explicit task lists.

## Installation

### Global Installation

Requires [Bun](https://bun.sh) runtime. Install globally:

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Install @devintern/code globally
bun install -g @getdevintern/code

# Or use directly without installing
bunx @getdevintern/code PROJ-123
```

## Environment Setup

### Quick Setup with Init Command

The easiest way to set up @devintern/code for your project is using the `init` command:

```bash
# Initialize project-specific configuration
devintern init
```

This creates a `.devintern-code` folder in your current project with:

- `.env` - Your project-specific configuration file with JIRA credentials
- `.env.example` - Template with all configuration options
- `settings.json` - Per-project settings (status transitions, story points field, etc.)

**Automatic .gitignore Protection:** The `init` command automatically adds `.devintern-code/.env` to your `.gitignore` file (or creates one if it doesn't exist) to prevent accidentally committing credentials to version control.

After running `init`:

1. Edit `.devintern-code/.env` with your JIRA credentials
2. (Optional) Edit `.devintern-code/settings.json` to configure per-project status transitions for your task tracker

### Manual Environment File Setup

Alternatively, create an environment file manually in your project directory or globally:

```bash
cat > .env << EOF
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token-here
# Optional: only set if the agent CLI is not on your PATH
# AGENT_CLI_PATH=/custom/path/to/claude
# Optional: For automatic PR creation (see ENV_SETUP.md for details)
# Option 1: Personal access token
GITHUB_TOKEN=your-github-token-here
# Option 2: GitHub App (for organizations)
# GITHUB_APP_ID=123456
# GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
# Bitbucket
BITBUCKET_TOKEN=your-bitbucket-token-here
EOF
```

**Get JIRA API Token**:

- Go to https://id.atlassian.com/manage-profile/security/api-tokens
- Create a new token
- Copy it to your `.env` file

### Environment File Locations

The tool searches for `.env` files in the following order:

1. **Custom path** (if specified with `--env-file`)
2. **Project-specific** (`.devintern-code/.env` - recommended)
3. **Current working directory** (`.env`)
4. **User home directory** (`~/.env`)
5. **Tool installation directory**

## Project Settings Configuration

The `settings.json` file supports tracker-specific sections so you can prepare configurations for any supported task tracker, even before full client support lands in `@devintern/code`.

### Supported Trackers

- **Jira** (`jira`)
- **Linear** (`linear`)
- **Trello** (`trello`)
- **Azure DevOps** (`azure-devops`)
- **Asana** (`asana`)
- **GitHub Issues** (`github`)
- **Markdown** (`markdown`)

### Example `settings.json`

```json
{
  "jira": {
    "projects": {
      "PROJ": {
        "inProgressStatus": "In Progress",
        "todoStatus": "To Do",
        "prStatus": "In Review",
        "storyPointsField": "customfield_10016"
      }
    }
  },
  "linear": {
    "projects": {
      "ENG": {
        "inProgressStatus": "In Progress",
        "todoStatus": "Backlog",
        "prStatus": "In Review"
      }
    }
  },
  "trello": {
    "projects": {
      "BOARD": {
        "inProgressStatus": "Doing",
        "todoStatus": "To Do",
        "prStatus": "Code Review"
      }
    }
  },
  "github": {
    "projects": {
      "REPO": {
        "inProgressStatus": "in progress",
        "todoStatus": "todo",
        "prStatus": "in review"
      }
    }
  }
}
```

### Backward Compatibility

Existing Jira-only `settings.json` files using the legacy top-level `projects` key continue to work:

```json
{
  "projects": {
    "PROJ": {
      "inProgressStatus": "In Progress",
      "todoStatus": "To Do",
      "prStatus": "In Review"
    }
  }
}
```

The tool automatically resolves the correct configuration based on the `TASK_TRACKER` environment variable (default: `jira`).

### Global Environment Variables

You can also set variables in your shell profile:

```bash
# Add to ~/.zshrc or ~/.bashrc
export JIRA_BASE_URL="https://your-company.atlassian.net"
export JIRA_EMAIL="your-email@company.com"
export JIRA_API_TOKEN="your-api-token"
# Optional: only set if the agent CLI is not on your PATH
# export AGENT_CLI_PATH="/custom/path/to/claude"
# Optional: For PR creation (see ENV_SETUP.md for details)
export GITHUB_TOKEN="your-github-token"
export BITBUCKET_TOKEN="your-bitbucket-token"
```

## Usage Scenarios

### Scenario 1: Working in Your Project Repository

This is the most common use case - you're in your project's git repository and want to implement a JIRA task:

```bash
# Navigate to your project
cd /path/to/your/project

# Ensure you have a .env file with JIRA credentials
# (either in this directory or globally accessible)

# Run devintern - it will:
# 1. Fetch JIRA task details
# 2. Create feature branch (e.g., feature/proj-123)
# 3. Run Claude with the task details
devintern PROJ-123
```

### Scenario 2: Custom Output Location and Agent Options

```bash
# Save task artifacts to a custom directory (default: /tmp/devintern-tasks)
DEVINTERN_OUTPUT_DIR=~/tasks/devintern devintern PROJ-123

# Use custom agent CLI path
devintern PROJ-123 --agent-path /usr/local/bin/claude

# Override max turns for very complex tasks (default: 500)
devintern PROJ-123 --max-turns 1000
```

### Scenario 3: Debugging and Verbose Output

```bash
# Get detailed output for troubleshooting
devintern PROJ-123 --verbose

# Skip git operations if you have uncommitted changes
devintern PROJ-123 --no-git

# Increase max turns for very complex tasks (default: 500)
devintern PROJ-123 --max-turns 1000

# Skip automatic commit after Claude completes
devintern PROJ-123 --no-auto-commit

# Create pull request after implementation
devintern PROJ-123 --create-pr

# Create pull request targeting specific branch
devintern PROJ-123 --create-pr --pr-target-branch develop
```

### Scenario 4: Pull Request Integration

```bash
# Automatically create PR after implementation (GitHub or Bitbucket)
devintern PROJ-123 --create-pr

# Create PR targeting a specific branch instead of main
devintern PROJ-123 --create-pr --pr-target-branch develop

# Combine with other options
devintern PROJ-123 --create-pr --max-turns 1000 --verbose

# PR creation works with both platforms:
# - GitHub: Detects from git remote, uses GITHUB_TOKEN or GitHub App
# - Bitbucket: Detects workspace from git remote, uses BITBUCKET_TOKEN
```

## Batch Processing Scenarios

### Scenario 5: Multiple Specific Tasks

Process multiple tasks by specifying their keys explicitly:

```bash
# Process 3 specific tasks sequentially
devintern PROJ-123 PROJ-124 PROJ-125

# With additional options
devintern PROJ-123 PROJ-124 PROJ-125 --create-pr --max-turns 500

# Each task gets its own output directory under DEVINTERN_OUTPUT_DIR (default: /tmp/devintern-tasks):
# - /tmp/devintern-tasks/proj-123/task-details.md
# - /tmp/devintern-tasks/proj-124/task-details.md
# - /tmp/devintern-tasks/proj-125/task-details.md
```

### Scenario 6: JQL Query Processing

Use JIRA Query Language to dynamically select tasks:

```bash
# Process all "To Do" tasks in a project
devintern --jql "project = PROJ AND status = 'To Do'"

# Process tasks assigned to you
devintern --jql "assignee = currentUser() AND status = 'To Do'"

# Process frontend bugs with high priority
devintern --jql "labels = 'frontend' AND type = Bug AND priority = High"

# Complex query with custom fields
devintern --jql "project = \"My Project\" AND cf[10016] <= 3 AND labels IN (FrontEnd, MobileApp)"
```

### Scenario 6b: Linear IssueFilter Processing

When `TASK_TRACKER=linear`, `--query` accepts either a JSON-serialized Linear `IssueFilter` object (passed to Linear's GraphQL API) or a plain-text string matched against issue titles. The CLI flag is still `--query`; only the syntax differs from Jira JQL.

```bash
# Single Linear issue
devintern ENG-42 --create-pr

# Process all "In Progress" issues assigned to you
devintern --query '{"state":{"name":{"eq":"In Progress"}}}' --create-pr

# Process all issues with the "intern" label (great for cron automations)
devintern --query '{"labels":{"name":{"eq":"intern"}}}' --create-pr

# Process high-priority issues
devintern --query '{"priority":{"eq":1}}' --create-pr

# Combine filters — "intern" label AND "In Progress" state
devintern --query '{"labels":{"name":{"eq":"intern"}},"state":{"name":{"eq":"In Progress"}}}' --create-pr
```

The full `IssueFilter` schema is available at <https://studio.linear.app/graphql> (search for `IssueFilter`). For more examples, see the [Linear Integration guide](https://devintern.com/docs/code/linear-integration).

### Scenario 7: Advanced Batch Operations

```bash
# Process all tasks in current sprint assigned to you
devintern --jql "assignee = currentUser() AND sprint in openSprints()"

# Process all tasks in a specific epic
devintern --jql "\"Epic Link\" = PROJ-100" --create-pr --pr-target-branch develop

# Process backlog items with specific story points
devintern --jql "status = 'Backlog' AND \"Story Points\" <= 5" --max-turns 300

# Process recent bugs (created in last 7 days)
devintern --jql "type = Bug AND created >= -7d" --skip-clarity-check
```

### Scenario 8: Batch Processing with Error Handling

```bash
# Process tasks with verbose output to see progress
devintern --jql "project = PROJ AND status = 'To Do'" --verbose

# Skip clarity checks for faster batch processing
devintern PROJ-101 PROJ-102 PROJ-103 --skip-clarity-check

# Continue processing even if some tasks fail
# (This is the default behavior - failed tasks don't stop the batch)
devintern --jql "labels = 'refactoring'" --max-turns 500

# Batch summary will show:
# - Total tasks processed
# - Number of successful implementations
# - Number of failed tasks with error details
```

### Scenario 9: Batch Processing Output Management

```bash
# Custom output directory for batch processing
DEVINTERN_OUTPUT_DIR=/tmp/batch-tasks devintern PROJ-123 PROJ-124
# Creates:
# - /tmp/batch-tasks/proj-123/task-details.md
# - /tmp/batch-tasks/proj-124/task-details.md

# Faster batch processing — skip clarity check (agent still runs)
devintern --jql "sprint = 'Sprint 1'" --skip-clarity-check

# Batch without git branch creation or Jira comments
devintern --jql "status = 'To Do'" --no-git --skip-jira-comments
```

## Example Workflow

```bash
# 1. Go to your project directory
cd ~/projects/my-app

# 2. Check git status (should be clean)
git status

# 3. Run devintern
devintern MYAPP-456

# Expected output:
# 🔍 Fetching JIRA task: MYAPP-456
# 📋 Task Summary: Implement user authentication
# 💾 Saving formatted task details to: ./task-details.md
# 🌿 Creating feature branch...
# ✅ Created and switched to new branch 'feature/myapp-456'
# 🤖 Running Claude with task details...
# [Claude implements the task...]
# ✅ Claude execution completed successfully
# 📝 Committing changes...
# ✅ Successfully committed changes for MYAPP-456
```

## Git Integration Details

### Automatic Branch Creation

- Creates branches with format: `feature/task-id`
- Converts task keys to lowercase: `PROJ-123` → `feature/proj-123`
- Checks for uncommitted changes before creating branches
- Switches to existing branch if it already exists

### Automatic Commit

- Commits all changes after Claude successfully completes
- Uses descriptive commit message: `feat: implement TASK-123 - Task Summary`
- Can be disabled with `--no-auto-commit` flag

### Pull Request Creation

- Automatically creates PRs on GitHub or Bitbucket after successful implementation
- Detects repository platform from git remote URL
- PR title format: `[TASK-123] Task Summary`
- PR body includes Claude's implementation details and links back to JIRA
- GitHub: Requires `GITHUB_TOKEN` or GitHub App authentication (see ENV_SETUP.md)
- Bitbucket: Requires `BITBUCKET_TOKEN` (`Repositories: Write`), workspace auto-detected from git remote
- Can be enabled with `--create-pr` flag
- Target branch can be specified with `--pr-target-branch` (defaults to 'main')

### Git Requirements

- Must be in a git repository
- No uncommitted changes (commit or stash first)
- Git must be available in PATH

### Handling Git Issues

```bash
# If you have uncommitted changes:
git add . && git commit -m "WIP: saving progress"
# or
git stash

# Then run devintern
devintern PROJ-123

# If you don't want git integration:
devintern PROJ-123 --no-git
```

## Automated Processing with Cron

You can set up automated task processing using cron jobs. This is useful for continuously picking up new tasks labeled for the intern to work on:

```bash
# Example: Process tasks labeled "Intern" in open sprints every 10 minutes
# Add to crontab (run: crontab -e)
*/10 * * * * cd /path/to/your/project && devintern --jql 'statusCategory = "To Do" AND sprint in openSprints() AND labels IN (Intern) ORDER BY created DESC' --max-turns 500 --create-pr --pr-target-branch master >> /tmp/devintern-cron.log 2>&1

# Example: Process assigned tasks every hour
0 * * * * cd /path/to/your/project && devintern --jql 'assignee = currentUser() AND status = "To Do" AND labels IN (AutoImpl)' --create-pr >> /tmp/devintern-cron.log 2>&1

# Example: Process high-priority bugs twice daily
0 9,17 * * * cd /path/to/your/project && devintern --jql 'type = Bug AND priority = High AND status = "To Do" AND labels IN (Intern)' --max-turns 300 --create-pr >> /tmp/devintern-cron.log 2>&1
```

### Linear cron examples

The same idea works for Linear using a JSON `IssueFilter`. Wrap the JSON in single quotes so the shell passes it through unchanged:

```bash
# Example: Process "intern"-labeled Linear issues every 10 minutes
*/10 * * * * cd /path/to/your/project && devintern --query '{"labels":{"name":{"eq":"intern"}}}' --max-turns 500 --create-pr --pr-target-branch master >> /tmp/devintern-cron.log 2>&1

# Example: Process high-priority Linear issues assigned to you every hour
0 * * * * cd /path/to/your/project && devintern --query '{"assignee":{"isMe":{"eq":true}},"priority":{"lte":2}}' --create-pr >> /tmp/devintern-cron.log 2>&1
```

**Important notes for cron setup:**

- Always change to your project directory (`cd /path/to/your/project`) to ensure the correct `.devintern-code/.env` is loaded
- Use absolute paths or ensure PATH includes `devintern` and `claude` binaries
- Redirect output to a log file for monitoring (`>> /tmp/devintern-cron.log 2>&1`)
- For Jira, use the `ORDER BY created DESC` clause to process newest tasks first
- Consider using labels (e.g., Jira `labels = "Intern"`, Linear `{"labels":{"name":{"eq":"intern"}}}`) to mark tasks for automated processing
- Test your query manually before adding to cron to ensure it returns the expected tasks
- Monitor the log file regularly to ensure the cron job is running successfully

## Troubleshooting

### Common Issues

1. **"Missing required environment variables"**
   - Ensure `.env` file exists in current directory
   - Or set environment variables in your shell
   - Check that variable names match exactly

2. **"Not in a git repository"**
   - Run `git init` if starting a new project
   - Or use `--no-git` flag to skip git operations

3. **"There are uncommitted changes"**
   - Commit your changes: `git add . && git commit -m "message"`
   - Or stash them: `git stash`
   - Or use `--no-git` to skip branch creation

4. **"Claude CLI not found"**
   - Install Claude CLI
   - Or specify path: `--claude-path /path/to/claude`

5. **"Issue not found"**
   - Check JIRA credentials
   - Verify task key exists and you have access
   - Ensure JIRA_BASE_URL is correct

6. **"Agent reached maximum turns limit"**
   - Task is too complex for the current turn limit (default: 500)
   - Increase max turns: `--max-turns 1000`
   - Consider breaking the task into smaller subtasks
   - Review the task description for clarity

7. **"PR creation failed"**
   - Ensure you have the correct token configured:
     - GitHub: `GITHUB_TOKEN` or GitHub App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH`)
     - Bitbucket: `BITBUCKET_TOKEN`
   - Check token/App permissions:
     - GitHub classic token: needs `repo` scope
     - GitHub fine-grained token: needs `Pull requests: Read and write` + `Contents: Read`
     - GitHub App: needs `Contents: Read` + `Pull requests: Read and write`
     - Bitbucket: needs `Repositories: Write`
   - For GitHub App: Ensure the App is installed on the repository
   - Verify you're in a repository with a remote origin
   - Confirm the repository platform is detected correctly
   - Use `--verbose` flag to see detailed error messages

### Debug Mode

```bash
# Get detailed error information
devintern PROJ-123 --verbose
```

## Examples

### Complete Workflow Example

```bash
# 1. Navigate to your project
cd ~/projects/my-app

# 2. Ensure clean git state
git status
git add . && git commit -m "Current progress"

# 3. Run devintern
devintern MYAPP-456

# Output:
# 🔍 Fetching JIRA task: MYAPP-456
# 📋 Task Summary: [details...]
# 💾 Saving formatted task details to: ./task-details.md
# 🌿 Creating feature branch...
# ✅ Created and switched to new branch 'feature/myapp-456'
# 🤖 Running Claude with task details...
# [Claude implements the task...]
```

## Uninstalling

```bash
npm uninstall -g @getdevintern/code
```
