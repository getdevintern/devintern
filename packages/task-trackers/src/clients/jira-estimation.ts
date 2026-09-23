/**
 * Story-point estimation helpers for the Jira Cloud REST API v3 client.
 *
 * Extracted from `./jira.ts` to keep the client under the `max-lines` budget.
 * Every helper takes a {@link JiraEstimationContext} (the live client) so
 * `jiraApiCall` is dispatched dynamically — callers and tests mock it at the
 * HTTP layer by reassigning the method on the client instance.
 */

export interface JiraEstimationResult {
  storyPoints: number;
  confidence: "high" | "medium" | "low";
  implementationConfidence?: number;
  reasoning: string;
  risks: string[];
  unclearAreas: string[];
  summary: string;
}

export interface JiraEstimationContext {
  readonly verbose: boolean;
  jiraApiCall(method: string, url: string, body?: any): Promise<any>;
}

/** Per-client cache of candidate story-points custom fields. */
const storyPointsCandidatesCache = new WeakMap<
  JiraEstimationContext,
  Array<{ id: string; name: string }>
>();

/**
 * Find an existing automated story-points estimation comment on an issue.
 *
 * @param ctx - Jira client context
 * @param issueKey - Issue key
 * @returns Comment id and created timestamp, or `null`
 */
export async function findEstimationComment(
  ctx: JiraEstimationContext,
  issueKey: string,
): Promise<{ commentId: string; created: string } | null> {
  try {
    const response = await ctx.jiraApiCall(
      "GET",
      `/rest/api/3/issue/${issueKey}/comment?expand=renderedBody`,
    );

    if (!response || typeof response !== "object") {
      return null;
    }

    const allComments = response.comments || [];
    for (const comment of allComments) {
      let commentText = "";
      if (comment.renderedBody) {
        commentText = comment.renderedBody;
      } else if (typeof comment.body === "string" && comment.body.length > 0) {
        commentText = comment.body;
      } else if (comment.body && typeof comment.body === "object" && "content" in comment.body) {
        commentText = JSON.stringify(comment.body);
      }
      if (commentText.includes("Automated Story Points Estimation")) {
        return { commentId: comment.id, created: comment.created };
      }
    }
    return null;
  } catch (error) {
    if (ctx.verbose) {
      console.warn(`⚠️  Failed to check for estimation comment on ${issueKey}: ${error}`);
    }
    return null;
  }
}

/**
 * Discover candidate custom fields that may store story points.
 *
 * @param ctx - Jira client context
 * @returns Cached list of `{ id, name }` field descriptors
 */
async function discoverStoryPointsCandidates(
  ctx: JiraEstimationContext,
): Promise<Array<{ id: string; name: string }>> {
  const cached = storyPointsCandidatesCache.get(ctx);
  if (cached) {
    return cached;
  }

  const fields = await ctx.jiraApiCall("GET", "/rest/api/3/field");
  const storyPointsNames = [
    "story point", // "Story Points", "Story Point Estimate", "Story point estimate"
    "story_point", // "story_points", "story_point_estimate"
    "estimation", // "Estimation" (JIRA Software board estimation field)
    "effort point", // "Effort Points"
    "sp (fibonacci", // "SP (Fibonacci)" — common custom naming
  ];

  const candidates = fields
    .filter((field: any) => {
      const fieldName = (field.name || "").toLowerCase();
      return storyPointsNames.some((name) => fieldName.includes(name));
    })
    .map((field: any) => ({ id: field.id, name: field.name }));

  storyPointsCandidatesCache.set(ctx, candidates);
  return candidates;
}

/**
 * Resolve the editable story points field for an issue (via editmeta when possible).
 *
 * @param ctx - Jira client context
 * @param issueKey - Optional issue key to inspect edit screen fields
 * @returns Custom field id, or `null` when none found
 */
export async function discoverStoryPointsField(
  ctx: JiraEstimationContext,
  issueKey?: string,
): Promise<string | null> {
  try {
    if (ctx.verbose) {
      console.log("🔍 Discovering story points field...");
    }
    const candidates = await discoverStoryPointsCandidates(ctx);

    if (candidates.length === 0) {
      if (ctx.verbose) {
        console.warn("⚠️  Could not find any story points field in JIRA");
      }
      return null;
    }

    // If we have an issue key, check editmeta to find which field is actually editable
    if (issueKey) {
      try {
        const editMeta = await ctx.jiraApiCall("GET", `/rest/api/3/issue/${issueKey}/editmeta`);
        const editableFieldIds = new Set(Object.keys(editMeta.fields || {}));

        for (const candidate of candidates) {
          if (editableFieldIds.has(candidate.id)) {
            if (ctx.verbose) {
              console.log(
                `✅ Found editable story points field: "${candidate.name}" (${candidate.id})`,
              );
            }
            return candidate.id;
          }
        }
        if (ctx.verbose) {
          console.log("   No story points field on edit screen, will try all candidates");
        }
      } catch {
        // editmeta failed, fall through to returning first candidate
      }
    }

    // Fallback: return first candidate
    const firstCandidate = candidates[0];
    if (!firstCandidate) {
      return null;
    }
    if (ctx.verbose) {
      console.log(`✅ Found story points field: "${firstCandidate.name}" (${firstCandidate.id})`);
    }
    return firstCandidate.id;
  } catch (error) {
    if (ctx.verbose) {
      console.warn(`⚠️  Failed to discover story points field: ${error}`);
    }
    return null;
  }
}

/**
 * Set story points on an issue, trying alternate candidate fields on failure.
 *
 * @param ctx - Jira client context
 * @param issueKey - Issue key
 * @param fieldId - Primary custom field id
 * @param points - Story point value
 * @throws When no candidate field is editable for the issue
 */
export async function updateStoryPoints(
  ctx: JiraEstimationContext,
  issueKey: string,
  fieldId: string,
  points: number,
): Promise<void> {
  if (ctx.verbose) {
    console.log(`📊 Setting story points for ${issueKey} to ${points} (field: ${fieldId})...`);
  }

  // Try the provided field first
  try {
    await ctx.jiraApiCall("PUT", `/rest/api/3/issue/${issueKey}`, {
      fields: { [fieldId]: points },
    });
    if (ctx.verbose) {
      console.log(`✅ Successfully set story points for ${issueKey} to ${points}`);
    }
    return;
  } catch (error) {
    const errorMsg = String(error);
    if (
      !errorMsg.includes("not on the appropriate screen") &&
      !errorMsg.includes("cannot be set")
    ) {
      throw error;
    }
    if (ctx.verbose) {
      console.log(`   Field ${fieldId} not editable, trying other candidates...`);
    }
  }

  // Try remaining candidate fields
  const candidates = await discoverStoryPointsCandidates(ctx);
  for (const candidate of candidates) {
    if (candidate.id === fieldId) continue;
    try {
      await ctx.jiraApiCall("PUT", `/rest/api/3/issue/${issueKey}`, {
        fields: { [candidate.id]: points },
      });
      if (ctx.verbose) {
        console.log(
          `✅ Successfully set story points for ${issueKey} to ${points} (field: "${candidate.name}" / ${candidate.id})`,
        );
      }
      return;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Could not set story points for ${issueKey} — none of the story points fields are editable for this issue type`,
  );
}

/** Build ADF block nodes for a story-points estimation comment body. */
export function buildEstimationCommentADF(result: JiraEstimationResult): any[] {
  const confidenceEmoji =
    result.confidence === "high" ? "🟢" : result.confidence === "medium" ? "🟡" : "🔴";

  const content: any[] = [
    {
      type: "heading",
      attrs: { level: 3 },
      content: [
        {
          type: "text",
          text: "🤖 Automated Story Points Estimation",
          marks: [{ type: "strong" }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Story Points: ",
          marks: [{ type: "strong" }],
        },
        { type: "text", text: `${result.storyPoints}` },
        { type: "text", text: "  |  " },
        {
          type: "text",
          text: "Confidence: ",
          marks: [{ type: "strong" }],
        },
        {
          type: "text",
          text: `${confidenceEmoji} ${result.confidence}`,
        },
      ],
    },
  ];

  if (typeof result.implementationConfidence === "number") {
    const score = result.implementationConfidence;
    const filled = "🟩".repeat(score);
    const empty = "⬜".repeat(10 - score);
    const label =
      score >= 9
        ? "Almost certain"
        : score >= 7
          ? "High chance"
          : score >= 5
            ? "May need guidance"
            : score >= 3
              ? "Significant ambiguity"
              : "Needs human judgment";
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "AI Implementation Confidence: ",
          marks: [{ type: "strong" }],
        },
        {
          type: "text",
          text: `${filled}${empty} ${score}/10 — ${label}`,
        },
      ],
    });
  }

  content.push(
    {
      type: "heading",
      attrs: { level: 4 },
      content: [{ type: "text", text: "Reasoning" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: result.reasoning }],
    },
  );

  if (result.risks.length > 0) {
    content.push({
      type: "heading",
      attrs: { level: 4 },
      content: [{ type: "text", text: "Risks" }],
    });
    content.push({
      type: "bulletList",
      content: result.risks.map((risk) => ({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: risk }],
          },
        ],
      })),
    });
  }

  if (result.unclearAreas.length > 0) {
    content.push({
      type: "heading",
      attrs: { level: 4 },
      content: [{ type: "text", text: "Unclear Areas" }],
    });
    content.push({
      type: "bulletList",
      content: result.unclearAreas.map((area) => ({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: area }],
          },
        ],
      })),
    });
  }

  if (result.confidence === "low") {
    content.push({
      type: "panel",
      attrs: { panelType: "warning" },
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "⚠️ Low confidence estimate — ",
              marks: [{ type: "strong" }],
            },
            {
              type: "text",
              text: "Please provide more details on the task scope and requirements for a more accurate estimate.",
            },
          ],
        },
      ],
    });
  }

  return content;
}

/**
 * Post a new automated story-points estimation comment.
 *
 * @param ctx - Jira client context
 * @param issueKey - Issue key
 * @param result - Estimation payload from the agent
 * @throws When the API request fails
 */
export async function postEstimationComment(
  ctx: JiraEstimationContext,
  issueKey: string,
  result: JiraEstimationResult,
): Promise<void> {
  try {
    if (ctx.verbose) {
      console.log(`💬 Posting estimation comment to ${issueKey}...`);
    }

    const commentBody = {
      body: {
        type: "doc",
        version: 1,
        content: buildEstimationCommentADF(result),
      },
    };

    await ctx.jiraApiCall("POST", `/rest/api/3/issue/${issueKey}/comment`, commentBody);
    if (ctx.verbose) {
      console.log(`✅ Successfully posted estimation comment to ${issueKey}`);
    }
  } catch (error) {
    if (ctx.verbose) {
      console.warn(`⚠️  Failed to post estimation comment to ${issueKey}: ${error}`);
    }
    throw error;
  }
}

/**
 * Update an existing automated story-points estimation comment in place.
 *
 * @param ctx - Jira client context
 * @param issueKey - Issue key
 * @param commentId - Existing comment id
 * @param result - Updated estimation payload
 * @throws When the API request fails
 */
export async function updateEstimationComment(
  ctx: JiraEstimationContext,
  issueKey: string,
  commentId: string,
  result: JiraEstimationResult,
): Promise<void> {
  try {
    if (ctx.verbose) {
      console.log(`💬 Updating estimation comment ${commentId} on ${issueKey}...`);
    }

    const commentBody = {
      body: {
        type: "doc",
        version: 1,
        content: buildEstimationCommentADF(result),
      },
    };

    await ctx.jiraApiCall("PUT", `/rest/api/3/issue/${issueKey}/comment/${commentId}`, commentBody);
    if (ctx.verbose) {
      console.log(`✅ Successfully updated estimation comment on ${issueKey}`);
    }
  } catch (error) {
    if (ctx.verbose) {
      console.warn(`⚠️  Failed to update estimation comment on ${issueKey}: ${error}`);
    }
    throw error;
  }
}
