# Manage documentation publishing with MCP

Connect an OAuth-capable MCP client to the Portal's Streamable HTTP endpoint:

```text
https://zixiaolabs.com/api/mcp
```

For example, in a client that uses a `mcpServers` JSON configuration with HTTP transport:

```json
{
  "mcpServers": {
    "zixiao-portal": {
      "type": "http",
      "url": "https://zixiaolabs.com/api/mcp"
    }
  }
}
```

Clients need OAuth discovery, public dynamic client registration, and authorization code flow with S256 PKCE. Start sign-in from the client, verify your Portal administrator work email if prompted, check the callback address, and approve the connection. A GitHub-only Portal session does not qualify, even for a linked administrator. The OAuth scope is `docs:repositories`, and the bearer is scoped to the exact MCP URL.

Tokens last at most 30 minutes and cannot outlive their Portal session. This flow does not issue refresh tokens; reconnect through OAuth when prompted. Disconnecting via a client that supports OAuth token revocation, signing out of the parent Portal session, or removing the account's administrator access stops use of the token. Portal browser cookies, user-management CLI tokens, GitHub tokens, and GitHub Actions OIDC assertions are not accepted as MCP credentials.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `register_publish_repository` | `{"id":"123456","repository":"zixiao-labs/example"}` | Registers the repository by numeric GitHub ID and full name. A duplicate name or ID is a conflict. |
| `unregister_publish_repository` | `{"id":"123456"}` | Revokes the grant. `removed` is `false` if the ID was not registered. Previously published pages remain public. |

Use the numeric GitHub repository ID **as a string**. Verify the name and ID with `gh api repos/zixiao-labs/example --jq .id` before granting access. The MCP tools and the Portal admin page change the same grant. Only the GitHub Actions job can upload snapshots; follow the [publishing guide](https://zixiaolabs.com/docs/portal/publish-docs) to set up that job.

## Install the agent skills

```sh
npx skills add zixiao-labs/portal --list
npx skills add zixiao-labs/portal --skill portal-mcp --skill portal-docs-publishing
```

These skills document the workflow; installation does not configure a client, grant permissions, or upload content.
