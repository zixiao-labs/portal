# CLI user administration

Use the Portal CLI HTTP API to search portal users, suspend or restore a non-admin account, or end its sessions. The API requires a short-lived token issued by an administrator who signed in with a verified work email.

## Issue a CLI token

1. Open [the portal](https://zixiaolabs.com/login) and sign in with your work email. If already signed in via GitHub, verify your work email from the account page.
2. Open the admin console and select **CLI 凭据** (CLI credentials).
3. Select **签发 CLI Token** (issue CLI token). Copy the returned `zxc_…` value. It is only shown on issuance and is valid for up to 30 minutes.

The browser uses `POST /api/admin/cli-token` to issue the token. It requires the authenticated browser session cookie and a same-origin request. The response contains `token` and `expiresAt` (UTC ISO 8601). The token is scoped to CLI user operations and is not an alternative to the browser session. Reissuing in the same session replaces the previous token. Logging out of that session also revokes its token.

## Search users

Send the token as an `Authorization: Bearer` header. A browser cookie is neither required nor accepted in place of a CLI token. The examples use Bash and `curl` against production:

```bash
read -rs -p 'Portal CLI token: ' PORTAL_CLI_TOKEN
printf '\n'
PORTAL_ORIGIN=https://zixiaolabs.com

curl --silent --show-error --fail-with-body \
  --header "Authorization: Bearer $PORTAL_CLI_TOKEN" \
  --get --data-urlencode 'q=reader' \
  "$PORTAL_ORIGIN/api/cli/users"
```

`GET /api/cli/users` returns up to 50 users in ascending ID order. Optional `q` is a case-insensitive substring of the email; use the returned `next` value as `after` to fetch another page with the same query. A `null` cursor means there is no next page. IDs and cursors are strings.

```json
{
  "users": [
    {
      "id": "71",
      "email": "reader@example.org",
      "employee": false,
      "github": true,
      "suspended": false,
      "admin": false
    }
  ],
  "next": null
}
```

## Change account status

| Method | Path | Effect |
| --- | --- | --- |
| `POST` | `/api/cli/users/{id}/suspend` | Blocks new sign-ins and invalidates all sessions. |
| `POST` | `/api/cli/users/{id}/restore` | Allows sign-in again without restoring old sessions. |
| `POST` | `/api/cli/users/{id}/revoke-sessions` | Invalidates active sessions without blocking new sign-ins. |

The request has no body. Substitute the ID returned by the search before running any action:

```bash
curl --silent --show-error --fail-with-body \
  --header "Authorization: Bearer $PORTAL_CLI_TOKEN" \
  --request POST "$PORTAL_ORIGIN/api/cli/users/71/revoke-sessions"
```

Success returns `{"ok":true}`. Failures return `{"error":"…"}`. Use the HTTP status rather than parsing the localized message: `400` invalid query, `401` missing or inactive credential, `403` missing admin privileges, `404` unknown user or endpoint, and `409` protected administrator account.

## Revoke the credential

Use **撤销 CLI Token** (revoke CLI token) in the same browser session or send a CLI request to revoke the token in use:

```bash
curl --silent --show-error --fail-with-body \
  --header "Authorization: Bearer $PORTAL_CLI_TOKEN" \
  --request DELETE "$PORTAL_ORIGIN/api/cli/token"
unset PORTAL_CLI_TOKEN
```

Do not store the token in source control, log it, or pass it to an untrusted process. A CLI token cannot grant repository access or be used with the document publishing endpoint.
