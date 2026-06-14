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
  "After starting a process, continue other work instead of waiting for it. Do not repeatedly call list/output just to see whether it has finished.",
  "Use bash instead when you need a command's result before continuing. Use process notify flags/logWatches only for asynchronous follow-up, especially failures or specific output patterns.",
];

export const TOOL_DESCRIPTION = `Manage background processes. Actions:
- start: Run command in background (requires 'name' and 'command')
  - alertOnSuccess (default: false): Show an informational notification on clean completion; does not wake the agent
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

Important: Use bash when you need a command's result before continuing in the current turn. Use process for asynchronous/background work only. You DON'T need to poll or wait for processes. Do not repeatedly call list/output after start just to check whether the process has completed. Repeated list/output calls while live process state/output is unchanged are suppressed; failure/kill notifications and logWatches arrive automatically when they require attention. Start processes and continue other work.

Note: User always sees process updates in the UI. The notify flags control whether YOU (the agent) get a turn to react (e.g. check results, fix code, restart).`;
