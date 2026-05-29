# Agent Notes: Releases

Read this when the user asks to cut a release, bump a version, prepare a version bump PR, or update release notes.

## Version Cut Workflow

When cutting a version, use the repository release tooling. Do not hand-edit package versions.

1. Start from a clean working tree on the intended release base, normally `main`.
2. Inspect the changes since the last version commit/tag and summarize the release-worthy changes.
   Useful commands:

   ```bash
   git log --oneline --decorate --grep='chore(release):' --max-count=5
   git tag --sort=-version:refname | head
   git log --oneline <last-version-ref>..HEAD
   git diff --stat <last-version-ref>..HEAD
   ```

3. Fill out `CHANGELOG.md` under `## [Unreleased]` with the changes since the last version commit.
   Group entries under the existing changelog style/categories when possible.
4. Run the version bump script:

   ```bash
   scripts/bump-version.sh <new-version>
   ```

   The script updates the root, server, and client `package.json` versions in lockstep, rolls
   `CHANGELOG.md` from `## [Unreleased]` to the dated release heading, stages the changes, and
   prints next-step instructions. It does **not** commit, push, or tag.

5. Include the changelog updates and version bumps together in the version bump PR. The PR should
   clearly call out that release notes were generated from changes since the previous version.
## Important Rules

- Do not bypass `scripts/bump-version.sh` for normal releases.
- Do not run the bump before filling `## [Unreleased]`; the script intentionally rejects an empty section unless `--allow-empty` is passed for a rare infra-only cut.
- Do not commit, push, or tag unless the user explicitly asks. The bump script stages files but leaves those checkpoints manual.
- Keep `package.json`, `packages/server/package.json`, and `packages/client/package.json` versions in lockstep.
- The version bump PR should include both the package version changes and the completed changelog entry for that version.
