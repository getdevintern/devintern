/**
 * The human form of the shared next steps, for text output.
 *
 * `--json` documents carry steps written for a program on the worker host:
 * `--no-wait` sign-ins that print a url and a `--complete` command, and
 * `--json` on every command. A person in a terminal gets the interactive
 * command instead (`devintern worker login` opens the browser and waits) and
 * a message addressed to them. Every text renderer that prints `nextSteps`
 * (`worker init --non-interactive`, `worker service`, the `worker login`
 * follow-up) goes through {@link humanNextSteps}, so the two forms never
 * drift. The JSON documents are never changed.
 */

import {
  NO_TERMINAL_SIGN_IN,
  OTHER_LOGIN_METHODS,
  WORKER_PILOT_OFFER,
} from "../account/worker-pilot";

/**
 * The shared next-step shape (`NextStep` in `readiness-json`), restated so
 * the text renderers in `readiness` can import this module without a cycle.
 */
interface NextStep {
  id: string;
  message: string;
  command: string;
  url?: string;
}

/** Flags that only make sense for a program reading the output. */
const MACHINE_FLAGS = ["--json", "--no-wait"] as const;

/** Options for {@link humanNextStep}. */
export interface HumanNextStepOptions {
  /**
   * Machine flags the user passed to the command that printed the steps:
   * those are kept (they asked for them).
   */
  passedFlags?: readonly string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `command` without the machine flags the user did not pass (bare tokens only). */
export function humanCommand(command: string, options: HumanNextStepOptions = {}): string {
  const drop = MACHINE_FLAGS.filter((flag) => !options.passedFlags?.includes(flag));
  let result = command;
  for (const flag of drop) {
    result = result.replace(new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|$)`, "g"), "");
  }
  return result.trim();
}

/** `message` with every backticked command in its human form. */
function humanMessage(message: string, options: HumanNextStepOptions): string {
  return message.replace(/`([^`]+)`/g, (_match, inner: string) => {
    return `\`${humanCommand(inner, options)}\``;
  });
}

const NO_TERMINAL_SENTENCE = new RegExp(`\\s*${NO_TERMINAL_SIGN_IN} \`[^\`]*\`\\.?`, "g");

/**
 * A check hint or other prose for a person: backticked commands lose the
 * machine flags, and the "Without a terminal: `... --no-wait`" alternative
 * is dropped (the person has a terminal).
 */
export function humanText(text: string, options: HumanNextStepOptions = {}): string {
  const keepNoWait = options.passedFlags?.includes("--no-wait") === true;
  return humanMessage(keepNoWait ? text : text.replace(NO_TERMINAL_SENTENCE, ""), options);
}

/** Messages for a person, by step id, when the JSON one is written for a program. */
const HUMAN_MESSAGES: Record<string, string> = {
  "sign-in":
    `Sign in to begin your ${WORKER_PILOT_OFFER}. It asks how to sign in (GitHub, or ` +
    `${OTHER_LOGIN_METHODS}) and opens your browser. A paid LICENSE_KEY in the workspace .env ` +
    "works instead",
  "complete-sign-in":
    "Open the sign-in address in any browser and sign in. The browser then lands on a " +
    "127.0.0.1 page that does not load: paste that page's full address into this command on " +
    "this host",
  connect:
    "Optional, after signing in: pair the relay for instant GitHub events (polling works " +
    "without it). Approve the GitHub App in your browser when it asks",
};

/** The interactive sign-in: no method (it asks), no `--no-wait`, no `--json`. */
function humanSignInCommand(command: string, options: HumanNextStepOptions): string {
  const human = humanCommand(command, options);
  // Without --no-wait the method is a choice the prompt offers; keep it when
  // the user asked for a --no-wait sign-in.
  if (human.includes("--no-wait")) return human;
  return human.replace(/(\sworker login(?:\s--workspace\s(?:'[^']*'|\S+))?)\sgithub(?=\s|$)/, "$1");
}

/** One step in the form a person in a terminal runs. */
export function humanNextStep<T extends NextStep>(step: T, options: HumanNextStepOptions = {}): T {
  const human: T = {
    ...step,
    message: humanMessage(step.message, options),
    command:
      step.id === "sign-in"
        ? humanSignInCommand(step.command, options)
        : humanCommand(step.command, options),
  };
  const message = HUMAN_MESSAGES[step.id];
  // A kept --no-wait means the user wants the url-and-complete flow the JSON
  // message describes.
  if (message && !human.command.includes("--no-wait")) human.message = message;
  return human;
}

/** Every step in its human form, in order. */
export function humanNextSteps<T extends NextStep>(
  steps: readonly T[],
  options: HumanNextStepOptions = {},
): T[] {
  return steps.map((step) => humanNextStep(step, options));
}

/**
 * The numbered `Next steps:` list text output prints: each step's message,
 * then its command on the line below.
 *
 * @param indent - Leading spaces for the numbered lines.
 */
export function renderNextSteps(
  steps: readonly NextStep[],
  options: HumanNextStepOptions & { indent?: string } = {},
): string[] {
  const indent = options.indent ?? "  ";
  const lines: string[] = [];
  humanNextSteps(steps, options).forEach((step, index) => {
    const number = `${index + 1}. `;
    lines.push(`${indent}${number}${step.message}`);
    lines.push(`${indent}${" ".repeat(number.length)}${step.command}`);
  });
  return lines;
}
