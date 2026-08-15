import React from "react";
import { Box, Text } from "ink";

/**
 * Shown when no ticket workspaces are open.
 * Explains multi-ticket work and how to open the first ticket.
 */
export function NoTicketsEmptyState() {
  return (
    <Box flexDirection="column" paddingY={2} paddingX={2} flexGrow={1}>
      <Text bold color="cyan">
        No open tickets
      </Text>
      <Box flexDirection="column" marginTop={1} width={64}>
        <Text dimColor>
          Each ticket is its own workspace — composer inputs, agent output, and progress stay
          separate. Open several and switch from the sidebar while an agent is still running on
          another ticket.
        </Text>
      </Box>
      <Box marginTop={2} flexDirection="column">
        <Text bold>Open your first ticket</Text>
        <Text>
          Press <Text color="cyan">Ctrl+N</Text> (or <Text color="cyan">n</Text> here) to start a
          new ticket workspace.
        </Text>
      </Box>
    </Box>
  );
}
