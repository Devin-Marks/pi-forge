import { useState, type FormEvent } from "react";
import { useAuthStore } from "../store/auth-store";

export function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useAuthStore((s) => s.login);
  const ldapEnabled = useAuthStore((s) => s.ldapEnabled);
  const pending = useAuthStore((s) => s.loginPending);
  const error = useAuthStore((s) => s.loginError);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (password.length === 0) return;
    if (ldapEnabled && username.trim().length === 0) return;
    void login(password, ldapEnabled ? username.trim() : undefined);
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-lg"
      >
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <img src="/icons/icon.svg" alt="" className="h-6 w-6" aria-hidden="true" />
            <h1 className="text-xl font-semibold tracking-tight">pi-forge</h1>
          </div>
          <p className="text-sm text-neutral-400">
            {ldapEnabled
              ? "Enter your LDAP username and password, or username admin for the local pi-forge password."
              : "Enter the pi-forge password to continue."}
          </p>
        </header>
        {ldapEnabled && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-neutral-300">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            />
          </label>
        )}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-neutral-300">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!ldapEnabled}
            autoComplete="current-password"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
        </label>
        {error !== undefined && (
          <p role="alert" className="text-sm text-red-400">
            {error === "invalid_password"
              ? ldapEnabled
                ? "Incorrect username/password, local admin password, or LDAP group."
                : "Incorrect password."
              : error === "username_required"
                ? "Username is required."
                : `Login failed: ${error}`}
          </p>
        )}
        <button
          type="submit"
          disabled={
            pending || password.length === 0 || (ldapEnabled && username.trim().length === 0)
          }
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
