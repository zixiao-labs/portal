---
name: portal-docs-publishing
description: Set up GitHub Actions to publish a repository's public documentation to the Zixiao Laboratories Portal via OIDC. Use for docs workflow installation, repository grants, snapshot rules, and Context7 indexing.
---

# Publish repository documentation

1. Verify that the target repository is in `zixiao-labs` and that the user wants its documentation made **public**, even if the source repository is private. Review `docs/` and root `.docsignore` before enabling publication; never upload secrets or internal-only content.
2. Find the repository ID with `gh api repos/zixiao-labs/<repo> --jq .id`. Ask an email-verified Portal administrator to grant publishing access in `/admin` or with the `portal-mcp` skill. The grant does not publish anything.
3. Install the [workflow template](https://github.com/zixiao-labs/portal/blob/main/.github/workflows/publish-docs.yml) as `.github/workflows/publish-docs.yml`. Use the [composite action](https://github.com/zixiao-labs/portal/tree/main/.github/actions/publish-docs) locally when permitted by the license, or reference it at a reviewed full commit SHA. Do not grant more than `contents: read` and `id-token: write` to the publishing job. Do not configure a Portal or GitHub token as a publishing secret.
4. Configure the `docs-publish` environment for `main` only, with required review where available. Protect `main` and review docs, `.docsignore`, the publishing workflow, and a copied action. With the user's approval, set the repository Actions variable `PORTAL_DOCS_ENABLED=true`. After the reviewed changes land, trigger `gh workflow run publish-docs.yml --repo zixiao-labs/<repo> --ref main` if needed.
5. Check `https://zixiaolabs.com/docs/<repo>` and `/docs/<repo>/llms.txt` without signing in. Submit the collection as a Website source to Context7 only if requested; it is a separate registration.

The Action sends a complete snapshot of Git-tracked `.md`, `.mdx`, and `.html` files under `docs/`. A removed article goes offline on the next successful snapshot. Revoking the repository's grant stops new snapshots without removing existing public documents. Read the [publishing guide](https://zixiaolabs.com/docs/portal/publish-docs) or its [source](https://github.com/zixiao-labs/portal/blob/main/docs/publish-docs.md) for content limits and troubleshooting.
