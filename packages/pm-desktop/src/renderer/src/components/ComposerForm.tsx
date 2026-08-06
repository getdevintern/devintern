import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { orderIssueTypes } from "@/lib/issue-types";
import type { ProjectStatus, PromptStyle, SourceType } from "../../../shared/ipc-contract.ts";

export interface ComposerValues {
  sourceType: SourceType;
  sourceContent: Record<SourceType, string>;
  extraInstructions: string;
  promptStyle: PromptStyle;
  projectKey: string;
  issueType: string;
  epicKey: string;
  decompose: boolean;
}

export const initialComposerValues: ComposerValues = {
  sourceType: "prompt",
  sourceContent: { figma: "", log: "", prompt: "" },
  extraInstructions: "",
  promptStyle: "pm",
  projectKey: "",
  issueType: "Task",
  epicKey: "",
  decompose: false,
};

const SOURCE_TABS: Array<{ type: SourceType; label: string; placeholder: string }> = [
  {
    type: "prompt",
    label: "Prompt",
    placeholder: "Describe the feature or requirements…",
  },
  {
    type: "figma",
    label: "Figma URL",
    placeholder: "https://www.figma.com/design/…?node-id=…",
  },
  {
    type: "log",
    label: "Error log",
    placeholder: "Paste the error log or stack trace…",
  },
];

interface ComposerFormProps {
  status: ProjectStatus;
  values: ComposerValues;
  onChange: (patch: Partial<ComposerValues>) => void;
  onGenerate: () => void;
  busy: boolean;
  issueTypes: string[];
  loadingIssueTypes: boolean;
}

export function ComposerForm({
  status,
  values,
  onChange,
  onGenerate,
  busy,
  issueTypes,
  loadingIssueTypes,
}: ComposerFormProps) {
  const activeTab = SOURCE_TABS.find((t) => t.type === values.sourceType)!;
  const content = values.sourceContent[values.sourceType];
  const canGenerate = status.configured && content.trim().length > 0 && !busy;
  const orderedIssueTypes = orderIssueTypes(issueTypes);

  return (
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r bg-card/50 p-4">
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {SOURCE_TABS.map((tab) => (
          <button
            key={tab.type}
            onClick={() => onChange({ sourceType: tab.type })}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              values.sourceType === tab.type
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {values.sourceType === "figma" ? (
        <Input
          placeholder={activeTab.placeholder}
          value={content}
          onChange={(e) =>
            onChange({ sourceContent: { ...values.sourceContent, figma: e.target.value } })
          }
        />
      ) : (
        <Textarea
          className="min-h-36 font-mono text-xs/relaxed"
          placeholder={activeTab.placeholder}
          value={content}
          onChange={(e) =>
            onChange({
              sourceContent: { ...values.sourceContent, [values.sourceType]: e.target.value },
            })
          }
        />
      )}

      <Label>
        Custom instructions (optional)
        <Textarea
          className="min-h-16"
          placeholder="e.g. Focus on accessibility; target the mobile app"
          value={values.extraInstructions}
          onChange={(e) => onChange({ extraInstructions: e.target.value })}
        />
      </Label>

      <div className="grid grid-cols-2 gap-3">
        {status.projects && status.projects.length > 0 && (
          <Label>
            Project
            <NativeSelect
              value={values.projectKey}
              onChange={(e) => onChange({ projectKey: e.target.value })}
            >
              {status.projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </NativeSelect>
          </Label>
        )}

        {status.supportsIssueTypes && (
          <Label>
            Issue type{loadingIssueTypes ? " …" : ""}
            <NativeSelect
              value={values.issueType}
              disabled={loadingIssueTypes}
              onChange={(e) => onChange({ issueType: e.target.value })}
            >
              {orderedIssueTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </NativeSelect>
          </Label>
        )}

        {status.supportsEpicLinking && (
          <Label>
            Epic key (optional)
            <Input
              placeholder="PROJ-100"
              value={values.epicKey}
              onChange={(e) => onChange({ epicKey: e.target.value })}
            />
          </Label>
        )}

        <Label>
          Style
          <NativeSelect
            value={values.promptStyle}
            onChange={(e) => onChange({ promptStyle: e.target.value as PromptStyle })}
          >
            <option value="pm">PM (user stories)</option>
            <option value="technical">Technical</option>
          </NativeSelect>
        </Label>
      </div>

      <label className="flex items-center justify-between rounded-md border px-3 py-2">
        <span className="text-xs font-medium">Decompose into subtasks after creating</span>
        <Switch
          checked={values.decompose}
          onCheckedChange={(decompose) => onChange({ decompose })}
        />
      </label>

      <Button size="lg" onClick={onGenerate} disabled={!canGenerate}>
        <Sparkles data-icon="inline-start" />
        {busy ? "Working…" : "Generate"}
      </Button>
    </section>
  );
}
