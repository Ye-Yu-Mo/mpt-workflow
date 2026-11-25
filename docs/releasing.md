# Releasing

The package is published as **`mpt-workflow`**. The `workflow-mcp` name on npm
belongs to an unrelated project.

## Checklist

1. Bump the version in **both** `package.json` and `src/version.ts`; they must
   match.
2. Move the `[Unreleased]` section in `CHANGELOG.md` to
   `[X.Y.Z] - YYYY-MM-DD` and add the compare link.
3. Run the local gate:

   ```bash
   npm run typecheck
   npm run build
   npm test
   npm run test:coverage
   npm pack --dry-run
   ```

   Build before test: three hook/MCP tests spawn `dist/cli.js`.

4. Commit as `chore(release): vX.Y.Z`, then create and push an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. The **Release** workflow checks that the tag matches `package.json`,
   re-runs typecheck/tests/build, publishes with npm provenance, and creates a
   GitHub release from the generated notes.

6. Verify:

   ```bash
   npm view mpt-workflow version
   ```

## Repository secrets

| Secret | Purpose |
|---|---|
| `NPM_TOKEN` | npm **Automation** token, or a granular token with **bypass 2FA** enabled, with publish rights for `mpt-workflow` |

npm rejects tokens without 2FA bypass with `E403 ... Two-factor authentication
or granular access token with bypass 2fa enabled is required`.

The workflow already requests `id-token: write` for provenance and
`contents: write` for the GitHub release.

## First publish

The tag workflow performs the first publish; no manual step is needed as long
as the token can create a new package.

During a first publish npm may create a temporary `0.0.0-stage` version. It is
a staged-publishing placeholder, not the `latest` tag — verify with:

```bash
npm view mpt-workflow dist-tags
# { latest: 'X.Y.Z' }
```

If you publish manually instead, the tag workflow will see the version already
exists and skip `npm publish`; it will still create the GitHub release.

## Re-runs and prereleases

The publish step checks `npm view mpt-workflow@<version>` first. If the version
already exists it skips `npm publish` and continues to the GitHub release, so a
tag run that failed after publishing can be re-run safely.

A version containing `-` (for example `v0.8.0-rc.1`) is published under the
`next` dist-tag and marked as a prerelease on GitHub. Stable tags use `latest`.

The workflow runs typecheck, test typecheck, lint, build, coverage and
`npm pack --dry-run` before publishing; `--ignore-scripts` keeps `NPM_TOKEN`
away from package lifecycle scripts.

## Troubleshooting

- `Cannot find module .../dist/cli.js` during tests: run `npm run build` before
  `npm test`.
- `E403` during publish: the token lacks 2FA bypass; regenerate it as an
  Automation token or a granular token with bypass 2FA.
- A failed tag run can be re-run after fixing the secret; publish is idempotent.
- If the workflow itself must change, move the tag to a commit containing the
  fix only when npm and GitHub have no artifact for that version; otherwise bump
  the patch version.
