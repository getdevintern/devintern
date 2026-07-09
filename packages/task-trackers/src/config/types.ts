export type TrackerType =
  | "jira"
  | "markdown"
  | "linear"
  | "trello"
  | "azure-devops"
  | "asana"
  | "github";

export interface TrackerConfig {
  backend: {
    type: TrackerType;
    directory?: string;
  };
  verbose?: boolean;
  jira?: {
    domain: string;
    email: string;
    apiToken: string;
    defaultProjectKey: string;
    verbose?: boolean;
  };
  linear?: {
    apiKey: string;
    defaultTeamKey?: string;
  };
  trello?: {
    apiKey: string;
    apiToken: string;
    defaultBoardId?: string;
    defaultListName?: string;
  };
  azureDevOps?: {
    organization: string;
    pat: string;
    defaultProject: string;
  };
  asana?: {
    apiToken: string;
    defaultProjectGid?: string;
  };
  github?: {
    token: string;
    owner: string;
    repo: string;
    repository: string;
  };
}
