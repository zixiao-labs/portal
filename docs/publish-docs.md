# Publish and index repository documentation

Authorized repositories in the `zixiao-labs` GitHub organization can publish a complete documentation snapshot to the Zixiao Laboratories Portal. All documents in an uploaded snapshot are public even if the source repository is private.

## Configure repository access

1. Find the numeric repository ID with `gh api repos/zixiao-labs/example --jq .id`. Ask a Portal administrator to grant access for that ID and the full name in `/admin` or via [MCP](https://zixiaolabs.com/docs/portal/mcp).
2. Install the portal's `publish-docs` composite Action and its caller workflow at `.github/workflows/publish-docs.yml`. See the [GitHub workflow template](https://github.com/zixiao-labs/portal/blob/main/.github/workflows/publish-docs.yml).
3. Configure the GitHub Actions environment `docs-publish` to allow deployments from `main` only, with required reviewers where supported. Protect `main` and review changes to the docs and publishing workflow. The repository variable `PORTAL_DOCS_ENABLED` must be `true`.
4. Give the publishing job `contents: read` and `id-token: write`. The GitHub job is the publisher; neither a personal access token nor a portal CLI token is accepted.

The template runs on a push to `main` affecting the docs or publishing configuration. You can trigger it from a terminal after your changes have landed:

```sh
gh workflow run publish-docs.yml --repo zixiao-labs/example --ref main
gh run list --repo zixiao-labs/example --workflow publish-docs.yml --limit 1
```

## Prepare the snapshot

The composite Action collects only Git-tracked regular `.md`, `.mdx`, and `.html` files under `docs/`. Git ignore rules and root `.docsignore` rules are applied independently. Use lowercase ASCII letters, digits, hyphens, and underscores in path segments; each segment must start with a letter or digit. The extension is removed from the public URL, so `start.md` and `start.html` would collide.

Markdown supports GitHub Flavored Markdown. HTML is sanitized. MDX only accepts Markdown and a small whitelist of static tags without attributes, such as `details`, `summary`, and `kbd`. Images, scripts, custom components, and embeds are not rendered. Link to other documents using their public routes rather than their source filenames.

Send 1–250 files with up to 120,000 UTF-16 code units per file in a JSON payload of at most 2 MiB. Each successful publication atomically replaces only that repository's snapshot. To unpublish an article, remove it from the next snapshot. Revoking repository authorization prevents future publications but does not remove published articles.

## Submit via HTTP from a publishing job

If you use another HTTP client inside the authorized workflow, request a GitHub Actions OIDC JWT with the exact audience `https://zixiaolabs.com/api/publish`. The portal checks the organization, repository ID and name, workflow path, branch, job environment, event, and freshness. A JWT can be used for only one successful publication. Keep it out of logs.

Send `POST /api/publish` with `Content-Type: application/json`, `Authorization: Bearer` followed by that OIDC JWT, and a full snapshot. Paths in the request are relative to `docs/`, not the repository root.

```json
{
  "files": [
    {
      "path": "guides/start.md",
      "content": "# Get started\n\nInstall the SDK before running this example."
    }
  ]
}
```

For example, if the running job has obtained its OIDC JWT as `PUBLISH_OIDC` and saved the request body as `snapshot.json`:

```sh
curl --silent --show-error --fail-with-body \
  --header "Authorization: Bearer $PUBLISH_OIDC" \
  --header 'Content-Type: application/json' \
  --data-binary @snapshot.json \
  https://zixiaolabs.com/api/publish
```

An HTTP `200` response gives the stable collection slug, its public URLs, and the number of articles:

```json
{
  "collection": "example",
  "count": 1,
  "url": "https://zixiaolabs.com/docs/example",
  "llmsTxt": "https://zixiaolabs.com/docs/example/llms.txt"
}
```

Errors contain `{"error":"…"}`. Use a fresh JWT when retrying after a replay (`409`); a `409` can also mean a renamed or conflicting collection needs administrator migration. A `400`, `413`, or `415` indicates invalid content, an oversized payload, or a missing JSON content type. A `401` or `403` indicates a missing bearer or rejected GitHub identity or repository grant.

## Register the public collection with Context7

Write the public guide and runnable examples in English: Context7 skips documentation whose primary prose is in other languages. After publishing, open `url` without signing in and check that it links to the rendered articles. Submit the collection URL as a **Website** source, with the crawl scope limited to that collection when the option is available. The `llmsTxt` URL also provides a per-repository discovery file linking to the same public articles.

Use [Add a library](https://context7.com/add-library) or the [Context7 website API](https://context7.com/docs/api-reference/add-library/add-a-website) with your own Context7 credentials. Wait for parsing to complete and confirm you can query the returned library ID, for example with `npx ctx7@latest docs` followed by the ID and a question about the guide. Publishing to the portal does not register, refresh, or remove a Context7 library automatically.

The Portal repository can also be added as a public GitHub source (`https://github.com/zixiao-labs/portal`) once these English guides are on `main`. The repository's `context7.json` configures the indexing scope.
