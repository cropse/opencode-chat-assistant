import type { NormalizedInput } from "../platform/types.js";
import { interactionManager } from "./manager.js";
import type {
  BlockReason,
  ExpectedInput,
  GuardDecision,
  IncomingInputType,
  InteractionState,
} from "./types.js";

function normalizeIncomingCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const token = trimmed.split(/\s+/)[0];
  const withoutMention = token.split("@")[0].toLowerCase();

  if (withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function classifyIncomingInput(input: NormalizedInput): {
  inputType: IncomingInputType;
  command?: string;
} {
  if (input.type === "callback") {
    return { inputType: "callback" };
  }

  if (input.type === "text" && input.text !== undefined) {
    const command = normalizeIncomingCommand(input.text);
    if (command) {
      return { inputType: "command", command };
    }

    return { inputType: "text" };
  }

  // Photo, voice, document, and other non-text messages are classified as "other"
  return { inputType: "other" };
}

function getExpectedInputBlockReason(expectedInput: ExpectedInput): BlockReason {
  switch (expectedInput) {
    case "callback":
      return "expected_callback";
    case "command":
      return "expected_command";
    case "text":
    case "mixed":
      return "expected_text";
  }
}

function createAllowDecision(
  inputType: IncomingInputType,
  state: InteractionState | null,
  command?: string,
): GuardDecision {
  return {
    allow: true,
    inputType,
    state,
    command,
  };
}

function createBlockDecision(
  inputType: IncomingInputType,
  state: InteractionState,
  reason: BlockReason,
  command?: string,
): GuardDecision {
  return {
    allow: false,
    inputType,
    state,
    reason,
    command,
  };
}

function isAllowedRenameCancelCallback(input: NormalizedInput, state: InteractionState): boolean {
  return (
    state.kind === "rename" &&
    state.expectedInput === "text" &&
    input.type === "callback" &&
    input.callbackData === "rename:cancel"
  );
}

export function resolveInteractionGuardDecision(input: NormalizedInput): GuardDecision {
  const state = interactionManager.getSnapshot();
  const { inputType, command } = classifyIncomingInput(input);

  if (!state) {
    return createAllowDecision(inputType, null, command);
  }

  if (interactionManager.isExpired()) {
    interactionManager.clear("expired");
    return createBlockDecision(inputType, state, "expired", command);
  }

  if (inputType === "command") {
    if (command === "/start") {
      return createAllowDecision(inputType, state, command);
    }

    if (command && state.allowedCommands.includes(command)) {
      return createAllowDecision(inputType, state, command);
    }

    return createBlockDecision(inputType, state, "command_not_allowed", command);
  }

  if (state.expectedInput === "mixed") {
    if (inputType === "callback" || inputType === "text") {
      return createAllowDecision(inputType, state, command);
    }

    return createBlockDecision(inputType, state, "expected_text", command);
  }

  if (inputType === "callback" && isAllowedRenameCancelCallback(input, state)) {
    return createAllowDecision(inputType, state, command);
  }

  if (state.expectedInput === inputType) {
    return createAllowDecision(inputType, state, command);
  }

  return createBlockDecision(
    inputType,
    state,
    getExpectedInputBlockReason(state.expectedInput),
    command,
  );
}
