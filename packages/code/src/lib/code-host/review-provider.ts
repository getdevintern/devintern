import type { ProcessedReviewFeedback } from "../../types/github-webhooks";

export interface ReviewAdapter {
  change: { title: string; state: string; head: { ref: string; sha: string } };
  gitAuthor?: { name: string; email: string };
  loadFeedback(): Promise<{
    feedback: ProcessedReviewFeedback;
    stageSummary: string;
    stageDetail: Record<string, unknown>;
  } | null>;
  beforePush(): Promise<void>;
  acknowledge(agentOutput: string): Promise<void>;
}
