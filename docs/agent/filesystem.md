# Agent Notes: Filesystem and Git Safety

Read this when changing file browser behavior, file-manager operations, path validation, workspace boundaries, git commands, or delete/move/write semantics.

## File Operations Safety Rules

1. All paths from the client are treated as untrusted until validated by
   `file-manager.ts`.
2. `file-manager.ts` resolves paths with `path.resolve()` and checks they start
   with the project root using `startsWith()` AFTER resolving. This prevents
   `../../../etc/passwd` style traversal.
3. Max file read size: 5MB. Larger files return a truncation notice.
4. `getTree()` skips: `node_modules`, `.git`, `dist`, `build`, `__pycache__`,
   `.next`, `.nuxt`, `coverage`, `.vite`, `.turbo`, `.cache`. Default max depth: 6 levels;
   `/files/tree?maxDepth=` is clamped to 1–32 and truncated directories return `truncated: true`.
5. Delete operations on non-empty directories are rejected — return a helpful error
   asking the user to delete contents first. Do not implement recursive force-delete.

---

## Related Critical Rules

- All filesystem operations go through `file-manager.ts` or `git-runner.ts`; never call `fs.*` directly in route handlers.
- `file-manager.ts` enforces path validation. Route handlers must never trust raw `path` query params or body fields without running them through file-manager.
- Return 403 for traversal attempts; do not throw and do not 500.
- Git command failures return 200 with `{ success: false, error: string }`; git errors are user-visible events, not server errors.
- Do not return raw stderr from git or bash commands to the client; sanitize first.
