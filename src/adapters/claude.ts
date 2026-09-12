import type { NormalizedEvent } from "../types";

/**
 * Claude Code source adapter (docs/WORLDVIEW.md §5.2 in the Forge repo).
 *
 * Claude Code's native `type: "http"` hooks always POST Claude Code's own
 * payload shape verbatim -- there's no way to have it send a different body,
 * so this gateway has to speak that shape rather than a generic envelope.
 * This is the one place that happens; everything past this function only
 * ever sees a NormalizedEvent.
 *
 * Deliberately reads exactly two fields: `hook_event_name` and `tool_name`.
 * Never `tool_input`, `tool_result`, or `last_assistant_message` -- those
 * carry real content (commands, file contents, diffs, what Claude said),
 * and Worldview's entire premise is that content never leaves the
 * originating machine. A tool's name ("Bash", "Edit") is a category label,
 * not content.
 */

interface ClaudeHookPayload {
  hook_event_name?: string;
  tool_name?: string;
}

export function normalizeClaudeEvent(payload: ClaudeHookPayload): NormalizedEvent {
  const timestamp = Date.now();

  switch (payload.hook_event_name) {
    case "SessionStart":
      return { state: "working", activity: "Session started", timestamp };
    case "PreToolUse":
      return {
        state: "working",
        activity: payload.tool_name ? `Running ${payload.tool_name}` : "Running a tool",
        timestamp,
      };
    case "PostToolUse":
      return {
        state: "working",
        activity: payload.tool_name ? `Finished ${payload.tool_name}` : "Finished a tool",
        timestamp,
      };
    case "Stop":
      // Claude finished a turn, not the CLI session -- still open, waiting
      // on the next prompt. "idle" still reads as online (presence.ts),
      // just with an honest activity label instead of a stale "Running X".
      return { state: "idle", activity: "Waiting for input", timestamp };
    case "SessionEnd":
      return { state: "stopped", timestamp };
    default:
      // An event this adapter doesn't specially handle yet. Still real
      // signal that the session is alive -- fail open rather than drop it,
      // labelled with the event's own name (a category, not content).
      return { state: "working", activity: payload.hook_event_name, timestamp };
  }
}
