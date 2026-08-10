import { Paperclip, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { isImageAttachmentName, mergeAttachments } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { orderIssueTypes } from "@/lib/issue-types";
import { LabelsField } from "./LabelsField.tsx";
import type {
  AttachmentRef,
  LabelRef,
  ProjectStatus,
  PromptStyle,
  SourceType,
} from "../../../shared/ipc-contract.ts";

export interface ComposerValues {
  sourceType: SourceType;
  sourceContent: Record<SourceType, string>;
  extraInstructions: string;
  promptStyle: PromptStyle;
  projectKey: string;
  issueType: string;
  epicKey: string;
  /** Selected tracker label ids ({@link LabelRef.id}). */
  labels: string[];
  /** Local files for agent context + optional tracker upload. */
  attachments: AttachmentRef[];
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
  labels: [],
  attachments: [],
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
  labels: LabelRef[];
  loadingLabels: boolean;
  labelsError: string | null;
  labelsTruncated?: boolean;
  onRetryLabels?: () => void;
}

export function ComposerForm({
  status,
  values,
  onChange,
  onGenerate,
  busy,
  issueTypes,
  loadingIssueTypes,
  labels,
  loadingLabels,
  labelsError,
  labelsTruncated = false,
  onRetryLabels,
}: ComposerFormProps) {
  const activeTab = SOURCE_TABS.find((t) => t.type === values.sourceType)!;
  const content = values.sourceContent[values.sourceType];
  const canGenerate = status.configured && content.trim().length > 0 && !busy;
  const orderedIssueTypes = orderIssueTypes(issueTypes);
  const showAttachments = values.sourceType === "prompt" || values.sourceType === "log";
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const applyIncomingAttachments = (incoming: AttachmentRef[]) => {
    const { next, error } = mergeAttachments(values.attachments, incoming);
    onChange({ attachments: next });
    setAttachError(error);
  };

  const chooseFiles = async () => {
    const result = await window.pm.chooseAttachmentFiles();
    if (!result.ok) {
      setAttachError(result.error.message);
      return;
    }
    applyIncomingAttachments(result.value);
  };

  const pasteScreenshot = async () => {
    const result = await window.pm.saveClipboardImage();
    if (!result.ok) {
      setAttachError(result.error.message);
      return;
    }
    if (!result.value) {
      setAttachError("Clipboard has no image");
      return;
    }
    applyIncomingAttachments([result.value]);
  };

  const onDropFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const refs = window.pm.resolveDroppedFiles(Array.from(fileList));
    applyIncomingAttachments(refs);
  };

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
        <div
          className={cn("rounded-md", dragOver && "ring-2 ring-ring")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onDropFiles(e.dataTransfer.files);
          }}
        >
          <Textarea
            className="min-h-36 font-mono text-xs/relaxed"
            placeholder={activeTab.placeholder}
            value={content}
            onChange={(e) =>
              onChange({
                sourceContent: { ...values.sourceContent, [values.sourceType]: e.target.value },
              })
            }
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.type.startsWith("image/")) {
                  e.preventDefault();
                  void pasteScreenshot();
                  return;
                }
              }
            }}
          />
        </div>
      )}

      {showAttachments && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void chooseFiles()}
              disabled={busy}
            >
              <Paperclip data-icon="inline-start" />
              Attach…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void pasteScreenshot()}
              disabled={busy}
            >
              Paste screenshot
            </Button>
            {!status.supportsAttachments && values.attachments.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                Used for drafting only (this tracker cannot upload files)
              </span>
            )}
          </div>
          {values.attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {values.attachments.map((file) => (
                <li
                  key={file.path}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px]"
                >
                  <span className="truncate" title={file.path}>
                    <span className="text-muted-foreground">
                      {isImageAttachmentName(file.name) ? "Image · " : "File · "}
                    </span>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      onChange({
                        attachments: values.attachments.filter((a) => a.path !== file.path),
                      })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attachError && <p className="text-[11px] text-destructive">{attachError}</p>}
        </div>
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
        {status.supportsLabels && (
          <LabelsField
            available={labels}
            selected={values.labels}
            onChange={(next) => onChange({ labels: next })}
            loading={loadingLabels}
            error={labelsError}
            truncated={labelsTruncated}
            allowCreate={Boolean(status.supportsFreeformLabels)}
            onRetry={onRetryLabels}
            disabled={busy}
          />
        )}{" "}
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
