# Environment Setup Guide

## Overview

@devintern/code needs JIRA credentials to fetch task details. You can provide these credentials in several ways, giving you maximum flexibility for different use cases.

## Required Environment Variables

### Jira (default)

```bash
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token-here
# Optional: AGENT_CLI_PATH only needed if the agent CLI is not on your PATH
# AGENT_CLI_PATH=/custom/path/to/claude
```

### Trello

Set `TASK_TRACKER=trello` and provide the following credentials:

```bash
TASK_TRACKER=trello
TRELLO_API_KEY=your-power-up-api-key      # Required
TRELLO_API_TOKEN=your-user-token          # Required
TRELLO_DEFAULT_BOARD_ID=your-board-id     # Optional — used for settings lookup and status transitions
```

To obtain credentials:
1. **API key**: Visit https://trello.com/power-ups/admin and create or select a Power-Up to get its API key.
2. **API token**: Generate a token at `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_API_KEY`.

Card IDs can be passed as a short link (e.g. `4uWKPOTv`), a full card URL (e.g. `https://trello.com/c/4uWKPOTv/card-slug`), or a 24-character hex ID. The short link appears in the card URL: `https://trello.com/c/4uWKPOTv/...`.

Configure status transitions in `.devintern-code/settings.json` using the board ID as the project key:

```json
{
  "trello": {
    "projects": {
      "your-board-id": {
        "inProgressStatus": "Doing",
        "todoStatus": "To Do",
        "prStatus": "In Review"
      }
    }
  }
}
```

## Optional Environment Variables (GitHub / PR Integration)

### Standard setup: token + hosted relay

Use a `GITHUB_TOKEN` for interactive runs and workspace automation. In a relay-backed workspace, the central [DevIntern AI App](https://github.com/apps/devintern-ai/installations/new) delivers events while the token stays on your machine and performs GitHub API reads/writes. Do not create a GitHub App or copy an App private key into the workspace.

Unattended runs also need a `LICENSE_KEY`. See [Pricing](https://devintern.com/pricing/).

| What you want | Need |
| --- | --- |
| Implement tickets and open PRs from the CLI (personal) | `GITHUB_TOKEN` |
| Use GitHub Issues as the task tracker (`TASK_TRACKER=github`) | `GITHUB_TOKEN` (the App cannot substitute) |
| Worker review polling and replies | `GITHUB_TOKEN` |
| `@devintern-ai` on any PR (standard workspace) | `GITHUB_TOKEN` + relay pairing + central DevIntern AI App installation |
| Air-gapped mention handling or `webhook serve` | Customer-owned GitHub App (advanced) |
| Custom `slug[bot]` attribution | Customer-owned GitHub App (advanced) |

```bash
GITHUB_TOKEN=your-github-token-here
```

**Authentication split:**

- Relay-backed workspace: only `GITHUB_TOKEN` is used locally; custom App credentials are ignored.
- No-relay workspace: a complete customer-owned App configuration is preferred for mention identity, with `GITHUB_TOKEN` as fallback.
- Interactive CLI and PR creation: `GITHUB_TOKEN` is preferred.
- `devintern webhook serve`: the customer-owned App is preferred.

Do not set `GITHUB_APP_ID` by itself. The advanced path requires `GITHUB_APP_PRIVATE_KEY_PATH` or `GITHUB_APP_PRIVATE_KEY_BASE64` too.

**Note:** Task tracker status transitions are configured per-project in `settings.json`. The file supports tracker-specific sections (e.g., `jira`, `linear`, `trello`) based on the `TASK_TRACKER` environment variable.

### GitHub Personal Access Token

For interactive CLI use and the standard workspace path. When creating a GitHub personal access token, you need the following permissions:

**Classic Personal Access Token:**

- `repo` scope (Full control of private repositories)
- Or `public_repo` if you only work with public repositories

**Fine-grained Personal Access Token (recommended):**

- **Pull requests**: Read and write
- **Contents**: Read and write (needed for HTTPS branch pushes; SSH remotes may use your SSH key instead)
- **Issues**: Read and write (only when `TASK_TRACKER=github`)
- **Checks**: Read (when `[workspace].ci_failure_fix = true`)
- **Actions**: Read (when `[workspace].ci_failure_fix = true`)
- **Commit statuses**: Read (when `[workspace].ci_failure_fix = true`)

To create a GitHub token:

1. Go to https://github.com/settings/tokens
2. Choose "Fine-grained tokens" (recommended) or "Tokens (classic)"
3. For fine-grained tokens, select the specific repositories you need access to
4. Grant the permissions listed above
5. Set the token as `GITHUB_TOKEN` in your `.env` file

### Advanced: customer-owned GitHub App without the relay

Only create a GitHub App when the hosted relay cannot be used—for example an air-gapped installation—or when operating `devintern webhook serve` against your own public endpoint. This mode keeps webhook delivery and App authentication entirely under your control.

**Required App permissions (PR creation):**

- **Contents**: Read (to check branches)
- **Pull requests**: Read and write (to create PRs)
- **Checks**: Read (when automatic CI failure fixes are enabled)
- **Actions**: Read (when automatic CI failure fixes are enabled)
- **Commit statuses**: Read (when automatic CI failure fixes are enabled)

Mention matching and the webhook server also need **Pull request review comments** and **Issue comments**. See [GitHub Integration](https://devintern.com/docs/code/github-integration).

**Setup steps:**

1. Go to your organization's Settings → Developer settings → GitHub Apps → New GitHub App
2. Set repository permissions: Contents (Read), Pull requests (Read and write)
3. Disable webhooks for polling-only air-gapped workers; configure them when running `devintern webhook serve`
4. Generate a private key after creating the App
5. Install the App on your repositories
6. Configure **both** the ID and the key in your `.env`:
   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
   ```

**For CI/CD environments**, use base64-encoded key:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi4uLg==
```

To encode: `base64 -i your-key.pem` (macOS) or `base64 -w 0 your-key.pem` (Linux)

### Bitbucket Token Permissions

When creating a Bitbucket app password:

- **Repositories**: Write permission

To create a Bitbucket app password:

1. Go to https://bitbucket.org/account/settings/app-passwords/
2. Click "Create app password"
3. Grant "Repositories: Write" permission
4. Set the token as `BITBUCKET_TOKEN` in your `.env` file

## Setup Methods (in order of precedence)

### 1. Custom .env File (--env-file option)

**Use case**: Different JIRA instances, shared configs, custom locations

```bash
# Create a custom env file anywhere
cat > ~/configs/work-jira.env << EOF
JIRA_BASE_URL=https://work-company.atlassian.net
JIRA_EMAIL=work-email@company.com
JIRA_API_TOKEN=work-api-token
GITHUB_TOKEN=work-github-token
EOF

cat > ~/configs/personal-jira.env << EOF
JIRA_BASE_URL=https://personal-company.atlassian.net
JIRA_EMAIL=personal-email@company.com
JIRA_API_TOKEN=personal-api-token
BITBUCKET_TOKEN=personal-bitbucket-token
EOF

# Use specific config
devintern WORK-123 --env-file ~/configs/work-jira.env
devintern PERSONAL-456 --env-file ~/configs/personal-jira.env
```

### 2. Project-Specific .env File

**Use case**: Different credentials per project

```bash
# In project A directory
cd ~/projects/project-a
cat > .env << EOF
JIRA_BASE_URL=https://projecta.atlassian.net
JIRA_EMAIL=projecta@company.com
JIRA_API_TOKEN=projecta-token
EOF

# In project B directory
cd ~/projects/project-b
cat > .env << EOF
JIRA_BASE_URL=https://projectb.atlassian.net
JIRA_EMAIL=projectb@company.com
JIRA_API_TOKEN=projectb-token
EOF

# Use from respective directories
cd ~/projects/project-a && devintern PROJA-123
cd ~/projects/project-b && devintern PROJB-456
```

### 3. Global .env File in Home Directory

**Use case**: Same JIRA instance for all projects

```bash
# Create global config
cat > ~/.env << EOF
JIRA_BASE_URL=https://company.atlassian.net
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-api-token
EOF

# Works from any directory
cd anywhere && devintern PROJ-123
```

### 4. Shell Environment Variables

**Use case**: System-wide configuration, CI/CD environments

```bash
# Add to ~/.zshrc, ~/.bashrc, or ~/.profile
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_EMAIL="your-email@company.com"
export JIRA_API_TOKEN="your-api-token"
# Optional: only set if the agent CLI is not on your PATH
# export AGENT_CLI_PATH="/custom/path/to/claude"

# Reload shell or source the file
source ~/.zshrc

# Works from any directory without any .env files
devintern PROJ-123
```

## Getting Your JIRA API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Give it a descriptive name (e.g., "@devintern/code CLI")
4. Copy the generated token
5. Use it in your environment configuration

## Common Scenarios

### Scenario 1: Multiple JIRA Instances

```bash
# Work JIRA
cat > ~/work.env << EOF
JIRA_BASE_URL=https://work.atlassian.net
JIRA_EMAIL=work@company.com
JIRA_API_TOKEN=work-token
EOF

# Personal JIRA
cat > ~/personal.env << EOF
JIRA_BASE_URL=https://personal.atlassian.net
JIRA_EMAIL=personal@company.com
JIRA_API_TOKEN=personal-token
EOF

# Usage
devintern WORK-123 --env-file ~/work.env
devintern PERSONAL-456 --env-file ~/personal.env
```

### Scenario 2: Team Shared Configuration

```bash
# Team shared location
sudo mkdir -p /etc/devintern
sudo cat > /etc/devintern/team.env << EOF
JIRA_BASE_URL=https://team.atlassian.net
JIRA_EMAIL=team-account@company.com
JIRA_API_TOKEN=team-token
EOF

# Team members use
devintern TEAM-123 --env-file /etc/devintern/team.env
```

### Scenario 3: CI/CD Environment

```bash
# In your CI/CD pipeline
export JIRA_BASE_URL="https://company.atlassian.net"
export JIRA_EMAIL="ci-bot@company.com"
export JIRA_API_TOKEN="$CI_JIRA_TOKEN"  # From CI secrets

# No .env file needed — skip git in CI if not working in a repo checkout
devintern BUILD-123 --no-git --skip-jira-comments
```

## Troubleshooting

### Debug Environment Loading

```bash
# See which .env file is being loaded (runs full workflow after fetch)
devintern PROJ-123 --verbose

# Output will show:
# 📁 Loaded environment from: /path/to/env/file
```

### Common Issues

1. **"Missing required environment variables"**

   ```bash
   # Check what's loaded
   devintern PROJ-123 --verbose

   # Verify file exists and has correct variables
   cat .env
   ```

2. **"Specified .env file not found"**

   ```bash
   # Check path is correct
   ls -la /path/to/your/env/file

   # Use absolute path
   devintern PROJ-123 --env-file /absolute/path/to/file.env
   ```

3. **Wrong JIRA instance being used**

   ```bash
   # Check which env file is loaded
   devintern PROJ-123 --verbose

   # Override with specific file
   devintern PROJ-123 --env-file /path/to/correct.env
   ```

## Security Best Practices

1. **Never commit .env files to git**

   ```bash
   echo ".env" >> .gitignore
   echo "*.env" >> .gitignore
   ```

2. **Use restrictive file permissions**

   ```bash
   chmod 600 ~/.env
   chmod 600 ~/configs/*.env
   ```

3. **Use different tokens for different purposes**
   - Development: Personal token with limited scope
   - Production: Service account token
   - CI/CD: Dedicated automation token

4. **Regularly rotate API tokens**
   - Set calendar reminders to rotate tokens
   - Use descriptive names to track token usage
   - Revoke unused tokens

## Examples

### Quick Start Example

```bash
# 1. Create config
cat > ~/.env << EOF
JIRA_BASE_URL=https://mycompany.atlassian.net
JIRA_EMAIL=me@mycompany.com
JIRA_API_TOKEN=my-secret-token
EOF

# 2. Use from anywhere
cd ~/my-project
devintern MYPROJ-123
```

### Multi-Environment Example

```bash
# 1. Create environment configs
mkdir -p ~/.config/devintern

cat > ~/.config/devintern/staging.env << EOF
JIRA_BASE_URL=https://staging.atlassian.net
JIRA_EMAIL=staging@company.com
JIRA_API_TOKEN=staging-token
EOF

cat > ~/.config/devintern/prod.env << EOF
JIRA_BASE_URL=https://prod.atlassian.net
JIRA_EMAIL=prod@company.com
JIRA_API_TOKEN=prod-token
EOF

# 2. Use with specific environments
devintern STAGE-123 --env-file ~/.config/devintern/staging.env
devintern PROD-456 --env-file ~/.config/devintern/prod.env
```
