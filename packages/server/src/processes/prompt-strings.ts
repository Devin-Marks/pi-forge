/**
 * Prompt snippet + guidelines + tool description for the `process`
 * tool.
 *
 * ─────────────────────────────────────────────────────────────────
 * Adapted from @aliou/pi-processes (MIT).
 * Copyright (c) aliou.
 * https://github.com/aliou/pi-processes
 * ─────────────────────────────────────────────────────────────────
 *
 * The wording is preserved because it's been tuned against real
 * model behavior — rules like "avoid &, nohup, disown, or setsid
 * when the process tool fits" steer the model toward the right
 * primitive. The reducer, lifecycle, log handling, UI, and SSE
 * wiring are pi-forge's own.
 */

export const PROMPT_SNIPPET = "Manage background processes without blocking the conversation";

export const PROMPT_GUIDELINES: string[] = [
  "Use the process tool for long-running commands such as dev servers, test watchers, build watchers, and log tails instead of bash.",
  "Avoid shell background patterns such as &, nohup, disown, or setsid when the process tool fits.",
  "After starting a process, continue other work instead of waiting for it.",
  "Use the pi-forge process tool's notify flags (alertOnSuccess / alertOnFailure / alertOnKill) and logWatches when you need to react to events without polling.",
];

export const TOOL_DESCRIPTION = `Manage background processes. Actions:
- start: Run command in background (requires 'name' and 'command')
  - alertOnSuccess (default: false): Get a turn to react when process completes successfully
  - alertOnFailure (default: true): Get a turn to react when process crashes/fails
  - alertOnKill (default: false): Get a turn to react if killed by external signal (killing via tool never triggers a turn)
  - logWatches (optional): Runtime output watches that trigger immediate alerts while running
    - pattern: regex string to match per output line
    - stream: stdout | stderr | both (default both)
    - repeat: false by default (single-fire). Set true for repeat alerts
- list: Show all managed processes with their IDs and names
- output: Get recent stdout/stderr (requires 'id')
- logs: Get log file paths to inspect with read tool (requires 'id')
- kill: Terminate a process (requires 'id')
- clear: Remove all finished processes from the list
- write: Write to process stdin (requires 'id' and 'input', optional 'end' to close stdin)

Important: You DON'T need to poll or wait for processes. Notifications arrive automatically based on your preferences. Start processes and continue with other work — you'll be informed if something requires attention.

Note: User always sees process updates in the UI. The notify flags control whether YOU (the agent) get a turn to react (e.g. check results, fix code, restart).`;
