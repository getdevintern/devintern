import React from "react";
import { Box, Text } from "ink";
import {
  ticketAgentStatus,
  ticketAgentStatusShort,
  ticketSubtitle,
  ticketTitle,
} from "../ticket-workspaces.ts";
import type { TicketAgentStatus, TicketWorkspace } from "../ticket-workspaces.ts";

export interface TicketSidebarProps {
  tickets: TicketWorkspace[];
  activeTicketId: string | null;
  /** Highlight when sidebar focus mode is on (arrow navigation). */
  focused?: boolean;
  /** Max title width for truncation in narrow terminals. */
  titleWidth?: number;
}

function statusColor(status: TicketAgentStatus): string | undefined {
  switch (status) {
    case "running":
      return "cyan";
    case "error":
      return "red";
    case "done":
      return "green";
    case "ready":
      return "yellow";
    case "idle":
      return undefined;
  }
}

function TicketRow({
  ticket,
  active,
  index,
  titleWidth,
}: {
  ticket: TicketWorkspace;
  active: boolean;
  index: number;
  titleWidth: number;
}) {
  const isError =
    ticket.wizard.step === "success" &&
    Boolean(ticket.wizard.successMessage?.toLowerCase().startsWith("error"));
  const status = ticketAgentStatus(ticket.wizard.step, isError);
  const title = ticketTitle(ticket, titleWidth);
  const subtitle = ticketSubtitle(ticket, Math.max(12, titleWidth - 4));
  const marker = active ? "▸" : " ";
  const num = String(index + 1);

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={active ? "cyan" : undefined} bold={active}>
          {marker}
          {num}{" "}
        </Text>
        <Text color={active ? "cyan" : undefined} bold={active} wrap="truncate-end">
          {title}
        </Text>
        <Text dimColor> </Text>
        <Text color={statusColor(status)} dimColor={status === "idle"}>
          [{ticketAgentStatusShort(status)}]
        </Text>
      </Box>
      {subtitle && active ? (
        <Box paddingLeft={3}>
          <Text dimColor wrap="truncate-end">
            {subtitle}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Sidebar of open ticket workspaces for the TUI.
 * Switching does not cancel agent runs — each row shows that ticket's own status.
 */
export function TicketSidebar({
  tickets,
  activeTicketId,
  focused = false,
  titleWidth = 18,
}: TicketSidebarProps) {
  return (
    <Box
      flexDirection="column"
      width={Math.max(22, titleWidth + 10)}
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      marginRight={1}
    >
      <Text bold color="cyan">
        Open tickets
      </Text>
      <Text dimColor>{tickets.length === 0 ? "None yet" : `${tickets.length} open`}</Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {tickets.length === 0 ? (
          <Text dimColor>
            Open a ticket to start. Keep several open and switch while agents run.
          </Text>
        ) : (
          tickets.map((ticket, index) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              active={ticket.id === activeTicketId}
              index={index}
              titleWidth={titleWidth}
            />
          ))
        )}
      </Box>
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderColor="gray"
        paddingX={0}
      >
        <Text dimColor>Ctrl+N new</Text>
        <Text dimColor>Ctrl+W close</Text>
        <Text dimColor>Ctrl+↑/↓ switch</Text>
        <Text dimColor>Ctrl+1..9 select</Text>
      </Box>
    </Box>
  );
}
