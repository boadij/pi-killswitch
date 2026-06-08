# Releasing

`pi-killswitch` is published as a Pi-extension-only package. Pi loads the TypeScript extension entry through its package loader.

## Prerequisites

- `package-lock.json` is committed and matches `package.json`.
- The npm trusted publisher is configured on npmjs.com for this GitHub repository.
- The trusted publisher workflow filename matches `.github/workflows/release-please.yml`.
- The package repository URL matches `https://github.com/boadij/pi-killswitch`.
- The release environment is named `npm-publish`.
- The publish job uses a GitHub-hosted runner with `id-token: write`.
- The runner uses Node/npm versions that support provenance and trusted publishing.

## Local checks

```bash
npm ci
npm run check
npm pack --dry-run
```

## Release flow

Release Please opens and updates the release PR from Conventional Commit history. Merge the Release Please PR to create the GitHub release and publish the package.

If branch protection needs workflows to run on Release Please-created PRs, configure Release Please with a PAT or GitHub App token instead of the default `GITHUB_TOKEN`.
