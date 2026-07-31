import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ComposerForm,
  initialComposerValues,
  type ComposerValues,
} from "./components/ComposerForm.tsx";
import { OutputPanel } from "./components/OutputPanel.tsx";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { SetupBanner, Welcome } from "./components/SetupEmptyState.tsx";
import { initialOutputState, isBusy, outputReducer } from "./state/app-store.ts";
import type { IpcError, ProjectStatus } from "../../shared/ipc-contract.ts";

let requestCounter = 0;
const nextRequestId = () => `req-${++requestCounter}`;

const FALLBACK_ISSUE_TYPES = ["Task", "Story", "Bug", "Epic"];

function toError(error: IpcError | undefined): IpcError {
  return error ?? { code: "error", message: "Unknown error" };
}

export function App() {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);

  const [values, setValues] = useState<ComposerValues>(initialComposerValues);
  const [issueTypes, setIssueTypes] = useState<string[]>(FALLBACK_ISSUE_TYPES);
  const [loadingIssueTypes, setLoadingIssueTypes] = useState(false);
  const issueTypesCache = useRef(new Map<string, string[]>());

  const [output, dispatch] = useReducer(outputReducer, initialOutputState);
  const busy = isBusy(output.phase);

  const patchValues = useCallback((patch: Partial<ComposerValues>) => {
    setValues((prev) => ({ ...prev, ...patch }));
  }, []);

  // Stream agent output into the reducer (stale requestIds are ignored there).
  useEffect(() => {
    return window.pm.onAgentChunk((event) => {
      dispatch({ type: "agent-chunk", requestId: event.requestId, chunk: event.chunk });
    });
  }, []);

  const loadProject = useCallback(async (dir: string) => {
    setLoadingProject(true);
    try {
      const result = await window.pm.getProjectStatus(dir);
      if (!result.ok) return;
      const next = result.value;
      setStatus(next);
      issueTypesCache.current.clear();
      setValues((prev) => ({ ...prev, projectKey: next.defaultProjectKey ?? "" }));
      const types =
        next.issueTypes && next.issueTypes.length > 0 ? next.issueTypes : FALLBACK_ISSUE_TYPES;
      setIssueTypes(types);
      if (next.defaultProjectKey) {
        issueTypesCache.current.set(next.defaultProjectKey, types);
      }
      setValues((prev) =>
        types.includes(prev.issueType) ? prev : { ...prev, issueType: types[0] ?? "Task" },
      );
      dispatch({ type: "restarted" });
    } finally {
      setLoadingProject(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const last = await window.pm.getLastProjectDir();
      if (last.ok && last.value) {
        await loadProject(last.value);
      }
    })();
  }, [loadProject]);

  // Refetch issue types when the selected project changes.
  useEffect(() => {
    if (!status?.supportsIssueTypes || !values.projectKey) return;
    const cached = issueTypesCache.current.get(values.projectKey);
    if (cached) {
      setIssueTypes(cached);
      return;
    }
    let cancelled = false;
    setLoadingIssueTypes(true);
    void window.pm.listIssueTypes(values.projectKey).then((result) => {
      if (cancelled) return;
      setLoadingIssueTypes(false);
      const types = result.ok && result.value.length > 0 ? result.value : FALLBACK_ISSUE_TYPES;
      issueTypesCache.current.set(values.projectKey, types);
      setIssueTypes(types);
      setValues((prev) =>
        types.includes(prev.issueType) ? prev : { ...prev, issueType: types[0] ?? "Task" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [status?.supportsIssueTypes, values.projectKey]);

  const chooseProject = async () => {
    const result = await window.pm.chooseProjectDir();
    if (result.ok && result.value) {
      await loadProject(result.value);
    }
  };

  const generate = async () => {
    const content = values.sourceContent[values.sourceType];
    if (!content.trim() || busy) return;
    const requestId = nextRequestId();
    dispatch({ type: "generate-started", requestId });
    const result = await window.pm.generateStory(requestId, {
      source: { type: values.sourceType, content },
      promptStyle: values.promptStyle,
      epicKey: values.epicKey || undefined,
      extraInstructions: values.extraInstructions || undefined,
    });
    if (result.ok) {
      dispatch({ type: "generate-succeeded", draft: result.value });
    } else {
      dispatch({ type: "request-failed", error: toError(result.error) });
    }
  };

  const edit = async (editPrompt: string) => {
    if (!output.draft) return;
    const requestId = nextRequestId();
    dispatch({ type: "edit-started", requestId });
    const result = await window.pm.editStory(requestId, {
      current: output.draft,
      editPrompt,
      issueType: values.issueType,
    });
    if (result.ok) {
      dispatch({ type: "edit-succeeded", draft: result.value });
    } else {
      dispatch({ type: "request-failed", error: toError(result.error) });
    }
  };

  const create = async () => {
    if (!output.draft) return;
    dispatch({ type: "create-started" });
    const result = await window.pm.createTask({
      draft: output.draft,
      issueType: values.issueType,
      projectKey: values.projectKey || undefined,
      epicKey: values.epicKey || undefined,
    });
    if (!result.ok) {
      dispatch({ type: "request-failed", error: toError(result.error) });
      return;
    }
    dispatch({ type: "create-succeeded", created: result.value });

    if (values.decompose) {
      const requestId = nextRequestId();
      dispatch({ type: "decompose-started", requestId });
      const decomposed = await window.pm.decomposeStory(requestId, {
        story: output.draft,
        sourceType: values.sourceType,
        promptStyle: values.promptStyle,
      });
      if (decomposed.ok) {
        dispatch({ type: "decompose-succeeded", subtasks: decomposed.value });
      } else {
        dispatch({ type: "request-failed", error: toError(decomposed.error) });
      }
    }
  };

  const createSubtasks = async () => {
    if (!output.created) return;
    const selected = output.subtasks.filter((_, i) => output.selectedSubtasks.has(i));
    dispatch({ type: "create-subtasks-started" });
    const result = await window.pm.createSubtasks(
      output.created.key,
      selected,
      values.projectKey || undefined,
    );
    if (result.ok) {
      dispatch({ type: "create-subtasks-finished", outcomes: result.value });
    } else {
      dispatch({ type: "request-failed", error: toError(result.error) });
    }
  };

  if (!status) {
    return <Welcome onChooseProject={chooseProject} loading={loadingProject} />;
  }

  return (
    <div className="flex h-screen flex-col">
      <ProjectBar status={status} onChangeProject={chooseProject} />
      {!status.configured && <SetupBanner configError={status.configError} />}

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(320px,5fr)_7fr]">
        <ComposerForm
          status={status}
          values={values}
          onChange={patchValues}
          onGenerate={generate}
          busy={busy}
          issueTypes={issueTypes}
          loadingIssueTypes={loadingIssueTypes}
        />
        <OutputPanel
          output={output}
          issueType={values.issueType}
          decompose={values.decompose}
          onTitleChange={(summary) => dispatch({ type: "draft-title-changed", summary })}
          onEdit={edit}
          onCreate={create}
          onToggleSubtask={(index) => dispatch({ type: "subtask-toggled", index })}
          onCreateSubtasks={createSubtasks}
          onSkipSubtasks={() => dispatch({ type: "subtasks-skipped" })}
          onRestart={() => dispatch({ type: "restarted" })}
          onDismissError={() => dispatch({ type: "error-dismissed" })}
          onOpenUrl={(url) => void window.pm.openExternal(url)}
        />
      </main>
    </div>
  );
}
