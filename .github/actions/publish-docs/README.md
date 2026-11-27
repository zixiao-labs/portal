# Publish Zixiao portal documents

This composite Action uploads tracked `.md`, `.mdx`, and `.html` files under `docs/`, honoring `.docsignore` and `.gitignore`. **Uploaded documents are public, even when the source repository is private.** Run it after checkout on an Ubuntu runner with Git and Python 3.

1. Ask a portal admin to authorize the `zixiao-labs` repository by full name and numeric GitHub ID.
2. Keep the caller workflow at `.github/workflows/publish-docs.yml`, on `main`, triggered by `push` or `workflow_dispatch`. Set its job environment to `docs-publish` with branch restrictions and approval as available. Grant `contents: read` and `id-token: write` to that job.
3. Copy this directory to `.github/actions/publish-docs/` and call `uses: ./.github/actions/publish-docs` after checkout. Private repositories that can access the portal repository can instead call `zixiao-labs/portal/.github/actions/publish-docs@<full-commit-sha>`. Before any public distribution, obtain approval from Zixiao Laboratories. With approval, this directory can be published independently at the root of an Action repository.

The Action needs no PAT or publishing secret. Its `portal-origin` input defaults to `https://zixiaolabs.com`; set it only for an approved HTTPS deployment on `zixiaolabs.com` or one of its subdomains. The OIDC audience matches the chosen `/api/publish` URL. On success, the run log prints the repository's public collection URL and its `llms.txt` index when the portal returns it.
