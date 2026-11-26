# 紫霄实验室门户 · Zixiao Laboratories

- `/login`：公开的登录入口。任何用户都可通过 **GitHub** 登录／自动注册，但 GitHub 主邮箱必须已验证；工作邮箱验证码仅发给 `@zixiaolabs.com`，不开放公开邮箱注册。员工身份只来自验证通过的工作邮箱；用 GitHub 登录时，已验证的主邮箱须是工作邮箱。GitHub 主邮箱变更不会自动迁移现有账户。
- `/account`：登录后读取账户资料。员工可按组织仓库签发、查看和撤销发布 Token；明文只显示一次，有效期 90 天。不需要登录的文档公开索引；个人中心与 API 不索引。
- `/docs`：公开 SSR 文档库，带标题、描述、canonical、sitemap 与全文页面。由组织内 GitHub Actions 发布，不允许单独持 Token 上传。CLI 是路线图，目前没有发布命令。
- 页脚「外观」支持 UI Kit 的全部内置配色和组件风格，默认是 **紫霄配色 + 鹤坡 + 跟随系统**。可手动选择浅色或深色，浏览器会记住偏好。

## 本地工具链

需要 Node.js 24 和 pnpm 12.21.0。Nasti 原生构建 TanStack Start；`@tanstack/react-start`、路由生成器、Start 编译器按 Nasti 支持版本锁定，升级时要同时验证开发与服务端产物。SQLite 使用 Node 内置 `node:sqlite`，不需要单独部署数据库。

```sh
pnpm install --frozen-lockfile
pnpm dev
# http://localhost:3000/login

pnpm format
pnpm lint
pnpm build       # 同时生成 src/routeTree.gen.ts；全新工作树先执行它或 pnpm dev
pnpm typecheck
pnpm test
pnpm test:visual # 需要 Docker；在与 CI 相同的 Linux/amd64 容器中构建并运行视觉测试
```

Nasti 2.11 的 Start 热更新暂时关闭；源文件变化后重新加载浏览器即可。视觉测试统一使用容器中的 Chromium 和字体，避免不同系统的渲染差异影响基线。原图写到 `artifacts/`；有意修改界面时，先检查原图，再运行 `pnpm test:visual --update` 更新基线。

开发无需凭据即可查看登录页面和空文档库。若要连调 GitHub，单独注册一个回调为 `http://localhost:3000/api/auth/github/callback` 的 OAuth App。不要复制生产 OAuth 密钥到本地。使用 `.env.example` 作为配置参考；不测试邮件时将 SMTP 参数全部留空。

## 正式部署

**正式入口是 `https://zixiaolabs.com`。** 访问 `/` 会收到 `301` 并进入 `/login`；公开文档仍在 `/docs`。登录、文档的 canonical 和 sitemap 均指向裸域。生产仅允许在紫霄实验室授权域名部署，并拒绝与 `PORTAL_ORIGIN` 不符的 `Host`（HTTP 421）。`pnpm dev` 只用于本机开发。

[Verify portal](.github/workflows/verify.yml) 在 PR 和 `main` 上运行 CI。仅当 `zixiao-labs/portal` 的 `main` 通过检查并主动启用 CD 后，才会构建对应提交的 Docker 镜像并经 SSH 发送给服务器，不需要镜像仓库或 PAT。容器只发布到 `127.0.0.1:3000`。部署检查 `/login` 和读取 SQLite 的 `/sitemap.xml`，新容器未就绪会恢复旧容器，但不回退数据库。公网 HTTPS 单独检查，证书或代理故障不会触发应用回滚。

### 从 Delta 自助上线

在改动所在的 Delta 线程选择 **Merge → Merge Changes**，如有多个技能则选择 [`portal-release`](.delta/skills/portal-release/SKILL.md)。技能只在独立 Reviewer 子代理批准同一版本、且 PR 的 `Verify portal` 通过后合并到 `main`，再检查对应提交的生产部署结果。无法启动 Reviewer 或审查未通过时不会合并；请确认 Delta 的子代理委派未关闭。这个门槛只约束该技能，不拦截从 GitHub 或命令行绕过 Delta 的合并。

首次使用前，在 GitHub 为 `main` 配置分支保护：将 `verify` 设为必需状态检查，要求分支在合并前跟上 `main`，并启用 **Do not allow bypassing the above settings**，让管理员也受约束。如果当前 GitHub 计划不支持或技能无法验证这些规则，技能会停止。它不会帮你绕过保护或改动 GitHub 设置。

### Ubuntu 24.04：服务器和 Let's Encrypt

1. **DNS 与防火墙。** 裸域 `@` 的 `A` 记录已指向 `8.219.216.152`，仅部署裸域不需要新增记录，也不需要 `_acme-challenge` TXT。没有可用公网 IPv6 就不要保留 `AAAA`；若已有 CAA 限制，须允许 `letsencrypt.org`。仅在打算提供 `www` 或旧 `portal` 子域时，才为该主机名另配 DNS、TLS 和跳转。云安全组和主机防火墙均放行公网 TCP `80`/`443`，以及 Actions runner 到部署 SSH 端口；不要开放 `3000`。标准 GitHub-hosted runner 不保证固定出口 IP。
2. **Docker 与 SSH。** 安装 [Docker Engine 28+](https://docs.docker.com/engine/install/ubuntu/) 和 `curl`。创建专用 SSH 用户 `portal-deploy`，仅允许密钥登录。将专用部署密钥的**公钥**放入该用户的 `~/.ssh/authorized_keys`（可用 `restrict` 前缀）；确认该用户登录后可执行 `docker info`，且 `127.0.0.1:3000` 未被其他服务占用。若用 rootful Docker，`docker` 组等同于主机 root 权限；不要复用个人 SSH 密钥。用 `uname -m` 确认服务器架构。
3. **Caddy。** 按 [Caddy 官方 Ubuntu 安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装 systemd 服务。若 80/443 已有 Nginx、Apache 或其他代理，不要直接停用或覆盖现有站点，先安排代理迁移。独立服务器可执行以下命令；已有 Caddy 时，把 [站点配置](deploy/Caddyfile)合并进现有配置。

   ```sh
   sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl enable --now caddy
   sudo systemctl reload caddy
   ```

   Caddy 通过 Let’s Encrypt 公网 ACME 签发并自动续期，自动将 HTTP 重定向至 HTTPS；无需 Certbot 或 DNS API 凭据。保留包安装的 Caddy 数据目录 `/var/lib/caddy`，确保可以出站连接 ACME（TCP `443`）。证书签发失败时用 `sudo journalctl -u caddy` 排查。

### GitHub Actions：生产配置与首次上线

在仓库 **Settings → Environments** 创建 `production`，限制为 `main`，建议启用部署审批（若计划支持）。保护 `main`，要求审核工作流和部署脚本的改动。将下列值设置为该环境的 **Secrets**，不要写入仓库、镜像或日志。

| Secret | 值 |
| --- | --- |
| `DEPLOY_SSH_KEY` | 专用 SSH 私钥全文；无人值守部署使用无口令密钥 |
| `DEPLOY_SSH_KNOWN_HOSTS` | 从服务器控制台核实的 SSH 主机公钥行，格式 `主机名 ssh-ed25519 公钥内容`；公钥可从 `/etc/ssh/ssh_host_ed25519_key.pub` 读取。主机名须与 SSH 连接目标一致，非 22 端口用 `[主机名]:端口` |
| `PORTAL_SECRET` | `openssl rand -hex 32` 生成。已有部署沿用原值，不要每次发版都更换 |
| `PORTAL_GITHUB_CLIENT_ID`、`PORTAL_GITHUB_CLIENT_SECRET` | 下文 OAuth App 的 Client ID 和 Client Secret |
| `PORTAL_GITHUB_ORG_ID` | `gh api orgs/zixiao-labs --jq .id` 返回的数字组织 ID |
| `SMTP_USER` | SMTP 登录用户名，阿里企业邮箱填完整邮箱地址 |
| `SMTP_PASSWORD` | SMTP 客户端安全密码原文，无需 URL 编码或额外加引号 |

默认通过 `portal-deploy@zixiaolabs.com:22` 连接。需要变更时，在 `production` 环境的 **Variables** 设置 `DEPLOY_USER`、`DEPLOY_HOST`（DNS 名或 IPv4）、`DEPLOY_PORT`。ARM64（`aarch64`）服务器需要在 **仓库级 Actions Variables** 设置 `PORTAL_DEPLOY_ARCH=arm64`；`x86_64` 无需设置。准备就绪后，在同一仓库级位置设置 `PORTAL_DEPLOY_ENABLED=true`，然后在 Actions → **Verify portal** 选择 `main` 手动运行，或等下一次推送到 `main`。运行时凭证经 SSH 传入，不需要预先创建服务器 `.env` 文件；服务器上拥有 Docker 权限的用户仍可读取运行时环境。

上线后检查 `curl -I http://zixiaolabs.com/`（跳转 HTTPS）、`curl -i https://zixiaolabs.com/`（`301` 到 `/login`）、`https://zixiaolabs.com/sitemap.xml`，并实测 GitHub 登录、邮箱验证码与文档发布。SQLite 保存在 `zixiao-portal-data` 命名卷；请定期做 SQLite `.backup` 或停机备份，不要删卷或只拷贝活动数据库主文件。若已有部署使用其他位置的数据库，**先备份并迁移到该卷，再启用 CD**。单实例替换会有短暂中断；若主机宕机等中断留下 `zixiao-portal-previous`，先用 `docker ps -a` 确认当前容器状态，恢复或清理旧容器后再发布。定期检查磁盘并清理不再使用的旧镜像。

### GitHub OAuth App

1. 以组织管理员进入 `zixiao-labs` 的 **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. 应用名填 `Zixiao Laboratories Portal`，Homepage URL 填 `https://zixiaolabs.com`，Authorization callback URL 填 `https://zixiaolabs.com/api/auth/github/callback`。
3. 记录 Client ID，生成 Client Secret，只保存到门户仓库的 `production` 环境 Secret（见上表）。只需 `user:email`，不要授予仓库权限。不要把它配置到文档发布工作流或其他仓库。
4. 分别用非员工账号与已验证主邮箱是 `@zixiaolabs.com` 的 GitHub 帐号实测。工作邮箱离职停用时，管理员也应撤销门户中的员工发布 Token、会话和 GitHub 关联账号的员工权限，不应只停用 SMTP。

离职运维：备份 SQLite，在同一事务内对该员工的 `users` 记录设置 `employee=0`，并按相同 `user_id` 删除 `sessions` 和 `tokens`；不要删除 `users` 记录，否则仍持有 GitHub 工作邮箱验证的用户可能重新注册。同步移除相应 Actions 环境 Secret。

### 阿里企业邮箱（不用 25 端口）

1. 按[阿里邮箱 SMTP 程序发信文档](https://help.aliyun.com/zh/document_detail/36687.html)启用发信邮箱的第三方客户端 SMTP 权限，并生成客户端安全密码。中国大陆站点用 `smtp.qiye.aliyun.com:465`（隐式 TLS）；非大陆站点按[服务器地址表](https://www.alibabacloud.com/help/en/alibaba-mail/latest/alibaba-mail-imap-pop-smtp-address-and-port-information)选对应主机。只需放行 TCP 465 出站，无需开放 TCP 25。
2. 在 `production` 环境的 **Secrets** 设置 `SMTP_USER` 和 `SMTP_PASSWORD`，直接填原文，不拼 URL，也不做百分号编码。在同一环境的 **Variables** 设置连接和发件人参数：

   | Variable | 值 |
   | --- | --- |
   | `SMTP_HOST` | 必填；阿里企业邮箱中国大陆站点填 `smtp.qiye.aliyun.com`，不带协议或端口 |
   | `SMTP_TLS_MODE` | 可选；默认 `implicit`（连接即加密），也可填 `starttls`（强制升级为 TLS） |
   | `SMTP_PORT` | 可选；`implicit` 默认 `465`，`starttls` 默认 `587`；不支持 `25` |
   | `SMTP_FROM` | 可选；填已授权的发件邮箱地址。留空使用 `SMTP_USER`，若用户名不是邮箱则必填 |
   | `SMTP_FROM_NAME` | 可选；只填发件人显示名，例如 `紫霄实验室` |

   此前已设置 `SMTP_URL` 的话，请移除并改填独立参数。若旧的 `SMTP_FROM` Secret 包含不同的发件地址或显示名，分别移到上述两个 Variables。生产启动、邮件发送和 `pnpm smtp:check` 都使用同一套配置，并始终验证 TLS 证书。
3. 在部署环境执行 `pnpm smtp:check`（容器内可用 `docker exec zixiao-portal pnpm smtp:check`）检查连接、TLS 证书和 SMTP 认证，不会发送邮件。通过后在 `/login` 用一个 `@zixiaolabs.com` 邮箱实测收信和验证码登录。`EAUTH` 优先检查客户端权限和安全密码；连接错误先检查主机、出站端口和证书；检查通过但出现 `EENVELOPE` 时检查 `SMTP_FROM` 的发件权限和收件地址。SMTP 接收成功并不保证到达收件箱；还应检查垃圾箱并配置 SPF、DKIM 和 DMARC。

阿里邮箱建议批量或高频系统通知使用独立的邮件推送服务；本配置仅用于员工登录验证码。

### GitHub Actions：组织内文档发布

1. 组织 **Settings → Actions → General** 中允许选定的组织仓库运行 Actions，并批准 GitHub 提供的 `actions/checkout`。保持默认 `GITHUB_TOKEN` 只读；发布 job 仅声明 `contents: read`、`id-token: write`。
2. 将本仓库的 [publish-docs.yml](.github/workflows/publish-docs.yml) 原名放到每个**获准公开文档**的组织仓库。保护 `main`，对 `docs/**`、`.docsignore` 和发布 workflow 设 CODEOWNERS/必需审核。仓库 **Settings → Environments** 创建 `docs-publish`，只允许 `main`，建议设必需审批且禁止自我审批（以所在计划支持为准）。不要把发布 Secret 提供给 PR、fork 或任意未审核的工作流。
3. 员工在个人中心为这个 `zixiao-labs/<repo>` 创建 Token，保存为 `docs-publish` 环境 Secret `PORTAL_PUBLISH_TOKEN`；设环境变量 `PORTAL_ORIGIN=https://zixiaolabs.com`。最后将**仓库级** Actions 变量 `PORTAL_DOCS_ENABLED` 设为 `true`，明确启用发布。若用组织级变量共享 Origin，请用 selected repositories 限定访问范围；每仓库的发布 Token 仍应独立。更新 Token 后撤销旧值。
4. 提交 `docs/`，合到 `main` 自动发布，或在 Actions 选择 `main` 手动运行。服务器同时验证员工 Token 与 GitHub 签名的短期 OIDC，核对组织 ID、仓库、环境、工作流文件、分支、事件和 audience。同一 OIDC JWT 不能重复提交。`GITHUB_TOKEN`、GitHub PAT、工作站请求及仅有员工 Token 的请求不能替代 OIDC。

#### 文档格式、忽略与更新

- 只收集 Git 跟踪的 `docs/` 下常规 `.md`、`.mdx`、`.html` 文件。路径各段使用小写英数字、`_`、`-`，首字符必须是英数字；`docs/guides/start.md` 发布为 `/docs/<repo>/guides/start`。同一路径不能同时存在不同扩展名。页面标题取第一条一级标题，摘要取首段。
- 根目录 `.docsignore` 使用 gitignore 语法，例如 `/docs/drafts/`；标准 `.gitignore` 也会生效。不要用忽略规则替代内容审查：所有上传文档都可公开访问，即使来源是私有仓库。
- MD 支持 GFM；HTML 会净化；MDX 支持 Markdown 和无属性的静态标签（如 `details`、`summary`、`kbd`、`mark`），拒绝自定义组件、表达式和 `import`/`export`。不会执行上传代码，也不代理资源；脚本、嵌入和图片不显示。文间链接用实际文档 URL，例如 `/docs/my-repo/guides/start`，不要链接源 `.md` 文件。
- 每次发布是该仓库完整快照，SQLite 在一次事务内替换；从快照移除一篇即下线。每次 1–250 篇，JSON ≤ 2 MiB，单篇 ≤ 120,000 字符。误发布时先从内容仓库移除并重发；若需清空整个集合或仓库改名，请由管理员备份后维护数据库。撤销 Token 不会撤掉已发布的内容。
