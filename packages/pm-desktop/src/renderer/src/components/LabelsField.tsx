import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import type { LabelRef } from "../../../shared/ipc-contract.ts";

interface LabelsFieldProps {
  available: LabelRef[];
  selected: string[];
  onChange: (labelIds: string[]) => void;
  loading: boolean;
  error: string | null;
  /** Soft-capped catalog — show incomplete-list affordance. */
  truncated?: boolean;
  /**
   * When true, the chips input can invent label names (markdown).
   * Catalog entries remain selectable suggestions.
   */
  allowCreate?: boolean;
  onRetry?: () => void;
  disabled?: boolean;
}

function resolveSelectedItems(available: LabelRef[], selected: string[]): LabelRef[] {
  return selected.map((id) => available.find((label) => label.id === id) ?? { id, name: id });
}

function isSameLabel(a: LabelRef, b: LabelRef): boolean {
  return a.id === b.id;
}

export function LabelsField({
  available,
  selected,
  onChange,
  loading,
  error,
  truncated = false,
  allowCreate = false,
  onRetry,
  disabled,
}: LabelsFieldProps) {
  const anchor = useComboboxAnchor();
  const [inputValue, setInputValue] = useState("");
  const selectedItems = useMemo(
    () => resolveSelectedItems(available, selected),
    [available, selected],
  );

  const catalogIds = useMemo(() => new Set(available.map((label) => label.id)), [available]);
  const trimmedQuery = inputValue.trim();
  const queryExists = useMemo(() => {
    if (!trimmedQuery) return false;
    const lower = trimmedQuery.toLowerCase();
    return (
      available.some(
        (label) => label.id.toLowerCase() === lower || label.name.toLowerCase() === lower,
      ) || selected.some((id) => id.toLowerCase() === lower)
    );
  }, [available, selected, trimmedQuery]);

  const pendingCreate =
    allowCreate && trimmedQuery.length > 0 && !queryExists
      ? ({ id: trimmedQuery, name: trimmedQuery } satisfies LabelRef)
      : null;

  const items = useMemo(() => {
    const byId = new Map<string, LabelRef>();
    for (const label of available) byId.set(label.id, label);
    for (const item of selectedItems) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    if (pendingCreate) byId.set(pendingCreate.id, pendingCreate);
    return [...byId.values()];
  }, [available, selectedItems, pendingCreate]);

  const catalogBlocked = Boolean(error) && !allowCreate;
  const fieldDisabled = disabled || loading || catalogBlocked;

  return (
    <Label className="col-span-2">
      Labels (optional){loading ? " …" : ""}
      <div className="flex flex-col gap-2">
        <div className="relative">
          {loading && (
            <Loader2 className="pointer-events-none absolute top-2 right-2 z-10 size-3.5 animate-spin opacity-70" />
          )}
          <Combobox
            items={items}
            multiple
            value={selectedItems}
            onValueChange={(next) => {
              const ids = (next ?? []).map((label) => label.id);
              onChange(ids);
            }}
            inputValue={inputValue}
            onInputValueChange={setInputValue}
            itemToStringLabel={(label) => label.name}
            itemToStringValue={(label) => label.id}
            isItemEqualToValue={isSameLabel}
            disabled={fieldDisabled}
            autoHighlight
          >
            <ComboboxChips ref={anchor} className="w-full min-h-8">
              <ComboboxValue>
                {(value: LabelRef[]) => (
                  <>
                    {value.map((label) => (
                      <ComboboxChip key={label.id}>{label.name}</ComboboxChip>
                    ))}
                  </>
                )}
              </ComboboxValue>
              <ComboboxChipsInput
                placeholder={
                  allowCreate
                    ? selected.length > 0
                      ? "Add label…"
                      : "Type or select labels…"
                    : selected.length > 0
                      ? "Add label…"
                      : "Select labels…"
                }
                disabled={fieldDisabled}
                aria-label={allowCreate ? "Filter or create labels" : "Filter labels"}
              />
            </ComboboxChips>
            <ComboboxContent anchor={anchor} className="w-(--anchor-width)">
              <ComboboxEmpty>
                {allowCreate
                  ? "Type a name to create a label"
                  : available.length === 0
                    ? "No existing labels in this tracker"
                    : "No matching labels"}
              </ComboboxEmpty>
              <ComboboxList>
                {(label) => {
                  const isCreate =
                    pendingCreate !== null &&
                    label.id === pendingCreate.id &&
                    !catalogIds.has(label.id);
                  return (
                    <ComboboxItem key={label.id} value={label}>
                      {isCreate ? `Create “${label.name}”` : label.name}
                    </ComboboxItem>
                  );
                }}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>

        {error && (
          <p className="text-[0.7rem] text-destructive">
            Failed to load labels: {error}
            {onRetry && (
              <>
                {" "}
                <button type="button" className="underline underline-offset-2" onClick={onRetry}>
                  Retry
                </button>
              </>
            )}
            {allowCreate && " You can still type new labels."}
          </p>
        )}

        {!loading && !error && truncated && available.length > 0 && (
          <p className="text-[0.7rem] text-muted-foreground">
            Showing first {available.length} labels; more may exist in the tracker.
          </p>
        )}

        {!loading && !error && available.length === 0 && !allowCreate && (
          <p className="text-[0.7rem] text-muted-foreground">No existing labels in this tracker.</p>
        )}

        {!loading && allowCreate && (
          <p className="text-[0.7rem] text-muted-foreground">
            Type any label name; existing ones appear as suggestions.
          </p>
        )}
      </div>
    </Label>
  );
}
