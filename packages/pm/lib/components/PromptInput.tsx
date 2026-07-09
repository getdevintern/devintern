import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import chalk from "chalk";

interface PromptInputProps {
  initialValue?: string;
  onSubmit: (value: string) => void;
  marginTop?: number;
  onEscape?: () => void;
  onExit?: () => void;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
}

/**
 * Render the input value with an inverse-video cursor at the given offset.
 */
function renderWithCursor(value: string, cursor: number): string {
  if (value.length === 0) {
    return chalk.inverse(" ");
  }

  let rendered = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? "";
    rendered += index === cursor ? chalk.inverse(char) : char;
  }

  if (cursor === value.length) {
    rendered += chalk.inverse(" ");
  }

  return rendered;
}

/**
 * Number of characters to delete for a key event.
 *
 * Holding backspace often delivers multiple raw DEL (`\x7f`) or BS (`\b`) bytes in
 * one stdin chunk. Ink only sets `key.backspace`/`key.delete` for single-byte events.
 */
function deleteCountForInput(input: string, key: Key): number {
  if (key.backspace || key.delete) {
    return 1;
  }

  if (input.length === 0) {
    return 0;
  }

  let count = 0;
  for (const char of input) {
    if (char === "\x7f" || char === "\b") {
      count++;
    } else {
      return 0;
    }
  }
  return count;
}

/**
 * Bordered Ink text input with a prompt prefix for CLI wizard steps.
 *
 * Uses refs for the live value/cursor so rapid keystrokes are not dropped while
 * React state catches up (ink-text-input reads a stale controlled `value` prop).
 *
 * @param initialValue - Pre-filled input text when the field mounts.
 * @param onSubmit - Called when the user presses Enter.
 * @param marginTop - Optional top margin passed to the outer Box.
 * @param onScrollUp - Optional handler for ↑ (e.g. scroll a preview pane).
 * @param onScrollDown - Optional handler for ↓.
 * @param onPageUp - Optional handler for PgUp.
 * @param onPageDown - Optional handler for PgDn.
 * @returns Prompt row with `>` prefix and text input.
 */
export function PromptInput({
  initialValue = "",
  onSubmit,
  marginTop,
  onEscape,
  onExit,
  onScrollUp,
  onScrollDown,
  onPageUp,
  onPageDown,
}: PromptInputProps) {
  const valueRef = useRef(initialValue);
  const cursorRef = useRef(initialValue.length);
  const onSubmitRef = useRef(onSubmit);
  const onEscapeRef = useRef(onEscape);
  const onExitRef = useRef(onExit);
  const scrollRef = useRef({
    onScrollUp,
    onScrollDown,
    onPageUp,
    onPageDown,
  });
  const [renderedValue, setRenderedValue] = useState(() =>
    renderWithCursor(initialValue, initialValue.length),
  );

  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onEscapeRef.current = onEscape;
    onExitRef.current = onExit;
    scrollRef.current = { onScrollUp, onScrollDown, onPageUp, onPageDown };
  }, [onSubmit, onEscape, onExit, onScrollUp, onScrollDown, onPageUp, onPageDown]);

  const syncDisplay = useCallback(() => {
    setRenderedValue(renderWithCursor(valueRef.current, cursorRef.current));
  }, []);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.upArrow) {
        scrollRef.current.onScrollUp?.();
        return;
      }
      if (key.downArrow) {
        scrollRef.current.onScrollDown?.();
        return;
      }
      if (key.pageUp) {
        scrollRef.current.onPageUp?.();
        return;
      }
      if (key.pageDown) {
        scrollRef.current.onPageDown?.();
        return;
      }
      if (key.tab || (key.shift && key.tab)) {
        return;
      }
      if (key.ctrl && input === "c") {
        onExitRef.current?.();
        return;
      }
      if (key.escape) {
        onEscapeRef.current?.();
        return;
      }
      if (key.return) {
        onSubmitRef.current(valueRef.current);
        return;
      }

      const value = valueRef.current;
      let cursor = cursorRef.current;

      if (key.leftArrow) {
        cursorRef.current = Math.max(0, cursor - 1);
        syncDisplay();
        return;
      }
      if (key.rightArrow) {
        cursorRef.current = Math.min(value.length, cursor + 1);
        syncDisplay();
        return;
      }
      const deleteCount = deleteCountForInput(input, key);
      if (deleteCount > 0) {
        const deletes = Math.min(deleteCount, cursor);
        if (deletes > 0) {
          valueRef.current = value.slice(0, cursor - deletes) + value.slice(cursor);
          cursorRef.current = cursor - deletes;
          syncDisplay();
        }
        return;
      }

      if (!input || key.ctrl || key.meta) {
        return;
      }

      valueRef.current = value.slice(0, cursor) + input + value.slice(cursor);
      cursorRef.current = cursor + input.length;
      syncDisplay();
    },
    [syncDisplay],
  );

  useInput(handleInput);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={marginTop}>
      <Text color="cyan">&gt; </Text>
      <Text>{renderedValue}</Text>
    </Box>
  );
}
