import { spawn } from "node:child_process";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { scrubbedEnv } from "./pty-manager.js";

export function sandboxSpawnIdentity(): { uid?: number; gid?: number } {
  if (!config.agentToolSandbox.enabled) return {};
  return { uid: config.agentToolSandbox.uid!, gid: config.agentToolSandbox.gid! };
}

export function createForgeBashOperations(workspacePath: string): BashOperations {
  return {
    exec: (command, _cwd, options) => {
      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const proc = spawn("/bin/sh", ["-c", command], {
          cwd: workspacePath,
          env: scrubbedEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          ...sandboxSpawnIdentity(),
        });
        const onAbort = (): void => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // best-effort
          }
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // best-effort
            }
          }, 2000);
        };
        if (options.signal !== undefined) {
          if (options.signal.aborted) onAbort();
          else options.signal.addEventListener("abort", onAbort, { once: true });
        }
        proc.stdout?.on("data", (data: Buffer) => options.onData(data));
        proc.stderr?.on("data", (data: Buffer) => options.onData(data));
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => resolve({ exitCode: code }));
      });
    },
  };
}
