# Docs site deployment

## Vercel project

| Field | Value |
|---|---|
| Project | `zvn-dev/vura` |
| Domain | `vura.io` |
| Org | `zvn-dev` (ZVN Dev) |
| Build config | root `vercel.json` (governs the root-directory project) |

## How the build works

The root `vercel.json` at the repo root points Vercel at the docs site:

```json
{
  "buildCommand": "npm --prefix docs-site install && npm --prefix docs-site run build",
  "outputDirectory": "docs-site/dist",
  "trailingSlash": true
}
```

`docs-site/vercel.json` exists for local reference (`vercel dev` from inside
`docs-site/`), but the **root `vercel.json` wins** for the Vercel project
because the project is configured with no custom root directory.

`sites/landing/index.html` (the former GitHub redirect) is now unused — it
is superseded by the docs-site build. The file is left in place (harmless).

## Preview deploys

Vercel fires a preview deployment on every PR automatically. The "Vercel"
check in the PR links to the preview URL. No extra configuration is needed —
the Vercel GitHub integration is already installed on the `CelsianJs/vura`
repository (confirmed via PR #23 and PR #24 Vercel checks).

## CI gate

`.github/workflows/docs-site.yml` runs on every PR and push to main that
touches `docs-site/**` or `packages/core/package.json`. It:

1. Builds the site with `npm --prefix docs-site run build`
2. Checks for broken internal links with `linkinator` (external GitHub URLs
   are skipped — they 404 on feature branches before merge)
3. Asserts the version badge in `dist/index.html` matches
   `packages/core/package.json`
4. Uploads `docs-site/dist` as a build artifact

The `Docs site / build` check must be green before tagging a release
(see RELEASING.md — the v0.5 gate).

## Manual deploy / promotion

Production deploys happen automatically on merge to `main`. To manually
promote a preview:

```sh
vercel promote <deployment-url> --scope zvn-dev
```

Or use the Vercel dashboard → Deployments → Promote to Production.

## `VERCEL_TOKEN`

The `VERCEL_TOKEN` secret is needed only for CLI-driven deploys from CI.
Preview/production deploys via the GitHub integration do not require it.
If you need to add it: Vercel dashboard → Account Settings → Tokens →
create a token scoped to `zvn-dev`, then add it as a repo secret
`VERCEL_TOKEN`.
