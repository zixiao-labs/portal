# Zixiao Laboratories Portal

The Zixiao Laboratories Portal provides GitHub and work-email sign-in, administrative tools for managing portal users, and a public documentation library populated by authorized repositories.

## Sign in

Open [the portal login page](https://zixiaolabs.com/login). Anyone can sign in and register with GitHub if their primary email is verified. Employee accounts require a verified `@zixiaolabs.com` address. Employees can sign in with a code sent to their work email and then explicitly link a GitHub account in the account page. Accounts are not merged automatically by matching email addresses.

Administrators must verify their work email before managing users or authorizing repositories. Signing in with an already-linked GitHub account does not grant those permissions until the administrator verifies their work email.

## Find published documentation

Browse [the documentation library](https://zixiaolabs.com/docs). A repository named `example` gets a public collection at `/docs/example` after its first successful publication. An article such as `docs/guides/start.md` is available at `/docs/example/guides/start`. Each collection also has a plaintext `llms.txt` index at `/docs/example/llms.txt`.

## Automate portal tasks

- [CLI user administration](https://zixiaolabs.com/docs/portal/cli-user-management): Issue a short-lived CLI credential, find users, suspend or restore accounts, and revoke sessions.
- [Portal OAuth and MCP](https://zixiaolabs.com/docs/portal/mcp): Connect to read public docs when signed in, manage employee OAuth applications, or manage repository publishing grants as an administrator.
- [Publish and index repository documentation](https://zixiaolabs.com/docs/portal/publish-docs): Configure a GitHub Actions job, submit a full snapshot, and register the public collection with Context7.

User administration, MCP repository grants, and snapshot publishing use different credentials. A Portal CLI or MCP token cannot publish documents. The documentation library is public, so never include secrets or internal-only content in a publishable snapshot.
