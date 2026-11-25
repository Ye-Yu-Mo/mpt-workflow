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
   npm test
   npm run build
   npm run test:coverage
   npm pack --dry-run
   ```

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
| `NPM_TOKEN` | npm automation token with publish rights for `mpt-workflow` |

The workflow already requests `id-token: write` for provenance and
`contents: write` for the GitHub release.

## First publish

If `mpt-workflow` does not exist on npm yet, a manual first publish may be
required:

```bash
npm login
npm publish --access public
```

After that, tag-driven releases are enough. Use a 2FA-enabled account and keep
the automation token scoped to this package.
