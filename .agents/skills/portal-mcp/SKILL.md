---
name: portal-mcp
description: Connect an OAuth-capable MCP client to the Zixiao Laboratories Portal and register or revoke GitHub repository documentation publishing permissions. Use for Portal MCP setup, tool calls, and authorization troubleshooting.
---

# Manage Portal publishing permissions over MCP

1. Add a remote **Streamable HTTP** server at `https://zixiaolabs.com/api/mcp`. Use the client's browser-based OAuth flow; do not paste a GitHub PAT, Portal CLI token, or browser cookie into the client. A compatible client discovers the OAuth endpoints and registers itself with the Portal.
2. Open the authorization page from the client. Use a Portal administrator's verified `@zixiaolabs.com` work-email session. Check the callback address and approve only the connection you just started. GitHub sign-in alone does not grant administrator access.
3. Confirm the exact repository and publishing change with the user before making either write. Get the numeric repository ID via `gh api repos/zixiao-labs/<repo> --jq .id`, using the user's existing GitHub access. Do not guess the ID.
4. Call `register_publish_repository` with `{"id":"123456","repository":"zixiao-labs/example"}` to allow publishing. Call `unregister_publish_repository` with `{"id":"123456"}` to revoke future publishing. The ID is a string. An unregistered ID returns `removed: false`; a duplicate name or ID on registration is a conflict, not an instruction to overwrite it.
5. Report the result. Neither tool publishes a document or deletes public pages. If a token expires, the Portal session ends, or credentials are revoked, reconnect through OAuth. Do not try to bypass administrator or work-email verification.

For client configuration and tool details, read the [Portal MCP guide](https://zixiaolabs.com/docs/portal/mcp) or its [source](https://github.com/zixiao-labs/portal/blob/main/docs/mcp.md). Use `portal-docs-publishing` for the GitHub Actions setup.
