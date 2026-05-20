import { useState, type FormEvent } from "react";
import { useAuthStore } from "../store/auth-store";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Shown after a successful login with the env-supplied initial
 * password. The token issued by that login is scoped to
 * `POST /auth/change-password` only — every other API call returns
 * 403 `must_change_password` until the user picks a new password.
 *
 * Once the user submits a new password the server hashes it, persists
 * it to `${FORGE_DATA_DIR}/password-hash`, and issues a fresh
 * full-access token. Subsequent logins use the stored hash and ignore
 * the env value entirely.
 */
export function ChangePasswordScreen() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const changePassword = useAuthStore((s) => s.changePassword);
  const pending = useAuthStore((s) => s.changePasswordPending);
  const remoteError = useAuthStore((s) => s.changePasswordError);
  const logout = useAuthStore((s) => s.logout);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setLocalError(undefined);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`new password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (next !== confirm) {
      setLocalError("new password and confirmation do not match");
      return;
    }
    if (next === current) {
      setLocalError("new password must differ from the current one");
      return;
    }
    void changePassword(current, next);
  };

  const error = localError ?? friendlyRemote(remoteError);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-lg"
      >
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <img src="/icons/icon.svg" alt="" className="h-6 w-6" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">Set a new password</h1>
          </div>
          <p className="text-sm text-neutral-400">
            You signed in with the deployment-supplied initial password. Pick a new one before
            continuing — it will be stored as a hash on the pi-forge data volume.
          </p>
        </header>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-300">Current password</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-300">New password</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-300">Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        {error !== undefined && (
          <p role="alert" className="text-sm text-red-400 light:text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || current.length === 0 || next.length === 0}
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : "Set new password"}
        </button>
        <button
          type="button"
          onClick={logout}
          className="w-full rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

function friendlyRemote(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  switch (code) {
    case "invalid_password":
      return "Current password is incorrect.";
    case "password_unchanged":
      return "New password must differ from the current one.";
    case "ui_password_not_configured":
      return "Password auth is not configured on this server.";
    case "auth_required":
      return "Session expired — sign in again.";
    default:
      return `Could not change password: ${code}`;
  }
}
