import React from "react";
import { Box, Text } from "ink";
import { ScrollView } from "ink-scroll-view";
import type { ScrollViewRef } from "ink-scroll-view";
import { MarkdownText } from "./MarkdownText";
import { PromptInput } from "./PromptInput";
import type { InteractiveState } from "./interactive-types";

export interface StepRenderContext {
  state: InteractiveState;
  input: string;
  inputVersion: number;
  sym: ReturnType<typeof import("../runtime/terminal.js").uiSymbols>;
  scrollViewRef: React.RefObject<ScrollViewRef | null>;
  projects: Array<{ key: string; name: string }>;
  defaultProjectKey?: string;
  orderedIssueTypes: string[];
  orderedHarnesses: Array<{ name: string; displayName: string }>;
  allHarnesses: Array<{ name: string; displayName: string }>;
  hasEpicStep: boolean;
  hasIssueTypeStep: boolean;
  backendName?: string;
  elapsedSeconds: number;
  sharedPromptInputProps: { onEscape: () => void; onExit: () => void };
  handleTextSubmit: (value: string) => void;
}

/**
 * Renders the UI for the current wizard step.
 * Always returns a non-null layout so the body under the chrome is never blank.
 *
 * @param ctx - Current wizard state plus the callbacks/refs the steps need.
 * @returns Step-specific Ink layout (including skip/recovery placeholders).
 */
// oxlint-disable-next-line complexity -- one switch over 15 wizard steps; split each case into a `<XStep>` subcomponent (shared StepShell + ScrollableMarkdownPane) rather than growing this function.
export function renderStep(ctx: StepRenderContext): React.ReactNode {
  const {
    state,
    input,
    inputVersion,
    sym,
    scrollViewRef,
    projects,
    defaultProjectKey,
    orderedIssueTypes,
    orderedHarnesses,
    allHarnesses,
    hasEpicStep,
    hasIssueTypeStep,
    backendName,
    elapsedSeconds,
    sharedPromptInputProps,
    handleTextSubmit,
  } = ctx;

  switch (state.step) {
    case "project":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Select project:</Text>
          {projects.map((project, index) => (
            <Text key={project.key}>
              {index + 1}. {project.name} ({project.key})
              {project.key === defaultProjectKey ? " (default)" : ""}
            </Text>
          ))}
          {defaultProjectKey && (
            <Text dimColor>Press Enter to use default project, or type number and press Enter</Text>
          )}
          <PromptInput
            key={`${state.step}-${inputVersion}`}
            initialValue={input}
            onSubmit={handleTextSubmit}
            marginTop={1}
            {...sharedPromptInputProps}
          />
        </Box>
      );

    case "source-type":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Select source type:</Text>
          <Text>1. Figma design URL</Text>
          <Text>2. Error log / Bug report</Text>
          <Text>3. Free-form prompt</Text>
        </Box>
      );

    case "source-input": {
      const label =
        state.sourceType === "figma"
          ? "Enter Figma URL:"
          : state.sourceType === "log"
            ? "Enter error log or bug description:"
            : "Enter your requirements:";
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>{label}</Text>
          <PromptInput
            key={`${state.step}-${inputVersion}`}
            initialValue={input}
            onSubmit={handleTextSubmit}
            {...sharedPromptInputProps}
          />
        </Box>
      );
    }

    case "custom":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Custom instructions (optional, press Enter to skip):</Text>
          <Text dimColor>Additional requirements or focus areas</Text>
          <Text dimColor>{'Example: "Focus on accessibility" or "Prioritize performance"'}</Text>
          <PromptInput
            key={`${state.step}-${inputVersion}`}
            initialValue={input}
            onSubmit={handleTextSubmit}
            {...sharedPromptInputProps}
          />
        </Box>
      );

    case "epic":
      // Skipped steps are redirected by effect; show a non-null body while redirecting.
      if (!hasEpicStep) {
        return (
          <Box flexDirection="column" paddingY={1}>
            <Text dimColor>Skipping epic step…</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Epic key (optional, press Enter to skip):</Text>
          <Text dimColor>Example: PROJ-123</Text>
          <PromptInput
            key={`${state.step}-${inputVersion}`}
            initialValue={input}
            onSubmit={handleTextSubmit}
            {...sharedPromptInputProps}
          />
        </Box>
      );

    case "issue-type":
      if (!hasIssueTypeStep) {
        return (
          <Box flexDirection="column" paddingY={1}>
            <Text dimColor>Skipping issue type step…</Text>
          </Box>
        );
      }
      const defaultIssueType = orderedIssueTypes[0];
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>
            Select issue type <Text dimColor>(Enter to accept default)</Text>:
          </Text>
          {orderedIssueTypes.map((type, index) => (
            <Text key={type}>
              {index + 1}. {type}
              {type === defaultIssueType ? " (default)" : ""}
            </Text>
          ))}
        </Box>
      );

    case "style":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>Select prompt style:</Text>
          <Text>1. PM style (user stories, acceptance criteria)</Text>
          <Text>2. Technical style (includes technical considerations)</Text>
        </Box>
      );

    case "harness": {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold>
            Select AI agent harness <Text dimColor>(Enter to accept current)</Text>:
          </Text>
          {orderedHarnesses.map((harness, index) => (
            <Text key={harness.name}>
              {index + 1}. {harness.displayName}
              {harness.name === state.harnessName ? " (current)" : ""}
            </Text>
          ))}
        </Box>
      );
    }

    case "confirm": {
      const sourceLabel =
        state.sourceType === "figma"
          ? "URL"
          : state.sourceType === "log"
            ? "Error Log"
            : "Requirements";
      const selectedHarness = allHarnesses.find((h) => h.name === state.harnessName);
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="green">
            Review your configuration:
          </Text>
          <Box paddingLeft={2} flexDirection="column" paddingY={1}>
            {state.projectKey && (
              <Box flexDirection="column" paddingBottom={1}>
                <Text bold>Project:</Text>
                <Text color="cyan">{state.projectKey}</Text>
              </Box>
            )}

            <Text bold>Source Type:</Text>
            <Text color="cyan">{state.sourceType}</Text>

            {state.sourceContent && (
              <Box flexDirection="column" paddingTop={1}>
                <Text bold>{sourceLabel}:</Text>
                <Text color="cyan">{state.sourceContent}</Text>
              </Box>
            )}

            {state.customInstructions && (
              <Box flexDirection="column" paddingTop={1}>
                <Text bold>Custom Instructions:</Text>
                <Text color="cyan">{state.customInstructions}</Text>
              </Box>
            )}

            {state.epicKey && (
              <Box flexDirection="column" paddingTop={1}>
                <Text bold>Epic:</Text>
                <Text color="cyan">{state.epicKey}</Text>
              </Box>
            )}

            {hasIssueTypeStep && (
              <Box flexDirection="column" paddingTop={1}>
                <Text bold>Issue Type:</Text>
                <Text color="cyan">{state.issueType}</Text>
              </Box>
            )}

            <Box flexDirection="column" paddingTop={1}>
              <Text bold>Prompt Style:</Text>
              <Text color="cyan">{state.promptStyle}</Text>
            </Box>

            {(selectedHarness || state.harnessName) && (
              <Box flexDirection="column" paddingTop={1}>
                <Text bold>Agent:</Text>
                <Text color="cyan">{selectedHarness?.displayName || state.harnessName}</Text>
              </Box>
            )}
          </Box>
          <Text bold>Continue? (Y/n)</Text>
        </Box>
      );
    }

    case "generating":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="cyan">
            🤖 Generating task...
          </Text>
          <Text dimColor>
            {state.statusMessage ?? "Running AI agent — this may take a few minutes"}
          </Text>
          <Text dimColor>Elapsed: {elapsedSeconds}s • Ctrl+C to cancel</Text>
        </Box>
      );

    case "preview": {
      if (!state.previewData) {
        return (
          <Box flexDirection="column" paddingY={1}>
            <Text bold color="yellow">
              Waiting for task preview...
            </Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box paddingY={1} flexDirection="column">
            <Text bold>📌 Title:</Text>
            <Box paddingLeft={2}>
              <Text color="green">{state.previewData.summary}</Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            <Text bold>📝 Description:</Text>
            <Text dimColor>
              (Use arrow keys {sym.scrollArrows} to scroll, PgUp/PgDn for fast scroll)
            </Text>
            <Box
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
              paddingY={1}
              flexDirection="column"
              height={25}
            >
              <ScrollView ref={scrollViewRef}>
                <MarkdownText>{state.previewData.description}</MarkdownText>
              </ScrollView>
            </Box>
          </Box>
          <Box paddingTop={1}>
            <Text bold>
              Create this {state.issueType.toLowerCase()} in {backendName || "task tracker"}? (Y/n)
              {sym.sep}Press E to edit
            </Text>
          </Box>
        </Box>
      );
    }

    case "edit-prompt":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box paddingY={1} flexDirection="column">
            <Text bold>📌 Title:</Text>
            <Box paddingLeft={2}>
              <Text color="green">{state.previewData?.summary}</Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            <Text bold>📝 Current Description:</Text>
            <Text dimColor>
              (Use arrow keys {sym.scrollArrows} to scroll, PgUp/PgDn for fast scroll)
            </Text>
            <Box
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
              paddingY={1}
              flexDirection="column"
              height={15}
            >
              <ScrollView ref={scrollViewRef}>
                <MarkdownText>{state.previewData?.description || ""}</MarkdownText>
              </ScrollView>
            </Box>
          </Box>
          <Box paddingTop={1} flexDirection="column">
            <Text bold color="cyan">
              What would you like to change?
            </Text>
            <Text dimColor>
              {'Example: "Add more details about error handling" or "Make it more concise"'}
            </Text>
            <PromptInput
              key={`${state.step}-${inputVersion}`}
              initialValue={input}
              onSubmit={handleTextSubmit}
              marginTop={1}
              {...sharedPromptInputProps}
              onScrollUp={() => scrollViewRef.current?.scrollBy(-1)}
              onScrollDown={() => {
                const ref = scrollViewRef.current;
                if (!ref) return;
                const currentOffset = ref.getScrollOffset();
                const bottomOffset = ref.getBottomOffset();
                if (currentOffset < bottomOffset) {
                  ref.scrollBy(1);
                }
              }}
              onPageUp={() => {
                const ref = scrollViewRef.current;
                if (!ref) return;
                ref.scrollBy(-(ref.getViewportHeight() || 1));
              }}
              onPageDown={() => {
                const ref = scrollViewRef.current;
                if (!ref) return;
                const height = ref.getViewportHeight() || 1;
                const currentOffset = ref.getScrollOffset();
                const bottomOffset = ref.getBottomOffset();
                if (currentOffset < bottomOffset) {
                  ref.scrollBy(Math.min(height, bottomOffset - currentOffset));
                }
              }}
            />
          </Box>
        </Box>
      );

    case "regenerating":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="cyan">
            🤖 Updating task description...
          </Text>
          <Text dimColor>
            {state.statusMessage ?? "Running AI agent — this may take a few minutes"}
          </Text>
          <Text dimColor>Elapsed: {elapsedSeconds}s • Ctrl+C to cancel</Text>
        </Box>
      );

    case "done":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="green">
            ✓ Ready to create!
          </Text>
          <Text dimColor>Creating task in {backendName || "task tracker"}...</Text>
        </Box>
      );

    case "success":
      return (
        <Box flexDirection="column" paddingY={1}>
          <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
            <Box flexDirection="column">
              <Text bold color="green">
                ✓ Success!
              </Text>
              {state.successMessage && <Text color="green">{state.successMessage}</Text>}
            </Box>
          </Box>
          <Box paddingTop={1}>
            <Text dimColor>Press any key to create another task...</Text>
          </Box>
        </Box>
      );

    default:
      // Never render null for a reachable step — recovery path if step graph drifts.
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="yellow">
            This step could not be displayed.
          </Text>
          <Text dimColor>Press Esc to return to the start, or Ctrl+C to exit.</Text>
        </Box>
      );
  }
}
