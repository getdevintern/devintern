import { randomUUID } from "node:crypto";
import type { EngineCallEvents } from "@getdevintern/pm/engine";
import { IPC_CHANNELS } from "../../shared/ipc-contract.ts";
import type {
  CreateTaskRequest,
  DecomposeStoryRequest,
  EditStoryRequest,
  GenerateStoryRequest,
  SubtaskDraft,
  SubtaskOutcome,
} from "../../shared/ipc-contract.ts";
import { track } from "../analytics.ts";
import { toEngineCreateTaskOptions } from "../create-task-options.ts";
import { beginAgentRequest, endAgentRequest, requireSession } from "../session.ts";
import { handle } from "./register.ts";

/** Per-request streaming bridge: engine chunks → renderer push events. */
function chunkEvents(event: Electron.IpcMainInvokeEvent, requestId: string): EngineCallEvents {
  return {
    onAgentChunk: (chunk, stream) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.agentChunk, { requestId, stream, chunk });
      }
    },
  };
}

/** Run an agent IPC call while marking its request id as in flight. */
async function withAgentRequest<T>(requestId: string, run: () => Promise<T>): Promise<T> {
  beginAgentRequest(requestId);
  try {
    return await run();
  } finally {
    endAgentRequest(requestId);
  }
}

/** Story/task generation and agent-request IPC handlers. */
export function registerAgentIpcHandlers(): void {
  handle(IPC_CHANNELS.listIssueTypes, async (_event, projectKey?: string) => {
    return requireSession().engine.listIssueTypes(projectKey);
  });

  handle(IPC_CHANNELS.listLabels, async (_event, projectKey?: string) => {
    return requireSession().engine.listLabels(projectKey);
  });

  handle(
    IPC_CHANNELS.generateStory,
    async (event, requestId: string, input: GenerateStoryRequest) => {
      return withAgentRequest(requestId, async () => {
        try {
          const draft = await requireSession().engine.generateStory(
            input,
            chunkEvents(event, requestId),
          );
          void track("story_generated", {
            source_type: input.source.type,
            ok: true,
            attachment_count: input.attachments?.length ?? 0,
            has_images: Boolean(
              input.attachments?.some((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.name)),
            ),
          });
          return draft;
        } catch (error) {
          void track("story_generated", {
            source_type: input.source.type,
            ok: false,
            attachment_count: input.attachments?.length ?? 0,
          });
          throw error;
        }
      });
    },
  );

  handle(IPC_CHANNELS.editStory, async (event, requestId: string, input: EditStoryRequest) => {
    return withAgentRequest(requestId, async () => {
      try {
        const draft = await requireSession().engine.editStory(input, chunkEvents(event, requestId));
        void track("story_edited", { ok: true });
        return draft;
      } catch (error) {
        void track("story_edited", { ok: false });
        throw error;
      }
    });
  });

  handle(
    IPC_CHANNELS.decomposeStory,
    async (event, requestId: string, input: DecomposeStoryRequest) => {
      return withAgentRequest(requestId, async () => {
        try {
          const subtasks = await requireSession().engine.decomposeStory(
            input,
            chunkEvents(event, requestId),
          );
          void track("story_decomposed", { ok: true });
          return subtasks;
        } catch (error) {
          void track("story_decomposed", { ok: false });
          throw error;
        }
      });
    },
  );

  handle(IPC_CHANNELS.createTask, async (_event, input: CreateTaskRequest) => {
    // Non-streaming, but still holds the session engine — guard like generate/edit.
    return withAgentRequest(`create-task:${randomUUID()}`, async () => {
      try {
        // Never forward labelsPrevalidated — Jira/GitHub apply can auto-create
        // names; main always re-validates against getLabels.
        const result = await requireSession().engine.createTask(
          input.draft,
          toEngineCreateTaskOptions(input),
        );
        void track("task_created", {
          ok: true,
          epic_linked: result.epicLinked,
          labels_applied: result.labelsApplied,
          attachments_uploaded: result.attachmentsUploaded,
          attachment_errors: result.attachmentErrors?.length ?? 0,
        });
        return {
          key: result.task.key,
          url: result.task.url,
          epicLinked: result.epicLinked,
          epicLinkError: result.epicLinkError,
          labelsApplied: result.labelsApplied,
          labelsApplyError: result.labelsApplyError,
          attachmentsUploaded: result.attachmentsUploaded,
          attachmentErrors: result.attachmentErrors,
        };
      } catch (error) {
        void track("task_created", { ok: false });
        throw error;
      }
    });
  });

  handle(
    IPC_CHANNELS.createSubtasks,
    async (_event, parentKey: string, subtasks: SubtaskDraft[], projectKey?: string) => {
      // Non-streaming, but still holds the session engine — guard like generate/edit.
      return withAgentRequest(`create-subtasks:${randomUUID()}`, async () => {
        const session = requireSession();
        const outcomes: SubtaskOutcome[] = [];
        for (const subtask of subtasks) {
          try {
            const created = await session.engine.createSubtask(parentKey, subtask, projectKey);
            outcomes.push({ subtask, key: created.key, url: created.url });
          } catch (error) {
            outcomes.push({
              subtask,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return outcomes;
      });
    },
  );

  handle(IPC_CHANNELS.beginAgentRequest, async (_event, requestId: string) => {
    beginAgentRequest(requestId);
    return null;
  });

  handle(IPC_CHANNELS.endAgentRequest, async (_event, requestId: string) => {
    endAgentRequest(requestId);
    return null;
  });
}
