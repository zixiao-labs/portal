# 紫霄实验室门户 · Zixiao Laboratories

- `/login`：公开的登录入口。任何用户都可通过 **GitHub** 登录／自动注册；GitHub 注册要求主邮箱已验证。仅验证了 `@zixiaolabs.com` 工作邮箱才能注册员工账户。门户将会话 JWT 保存在 `HttpOnly` Cookie 中，7 天有效；退出登录后该会话立即失效。
- `/account`：个人中心与 API 不索引。员工用工作邮箱登录后，可绑定自己的 GitHub 账号；之后可用同一个 GitHub 账号登录，门户中的工作邮箱和员工身份不会改变。不会按邮箱自动合并账户，也不会覆盖已有绑定。
- `/admin`：管理后台。管理员可搜索、停用、恢复用户，结束其会话，以及授权或撤销多个组织仓库的文档发布权限。必须验证工作邮箱才能进入后台和签发有效期 30 分钟的 [CLI 用户管理凭据](docs/cli-user-management.md)；通过 GitHub 登录的管理员可从个人中心直接发起验证，无需退出登录。
- `/docs`：公开 SSR 文档库。首次发布后，仓库拥有 `/docs/<repo>` 首页和 `/docs/<repo>/llms.txt` 索引，可作为 Context7 的公开文档来源。提交仅接受获授权仓库的 GitHub Actions 短期 OIDC 凭据，不接受浏览器会话、CLI Token 或 PAT。[Portal 文档源码](docs/overview.md)也通过同一工作流发布。
- `/api/mcp`：与「个人中心 → OAuth 应用」共用第三方 OAuth。员工可以注册应用、清除 Token 或取消注册；任何已登录用户可用 `docs:read` 查询公开文档。仓库发布授权仍由工作邮箱验证的管理员管理。见 [OAuth 和 MCP 指南](docs/mcp.md)。
- 页脚「外观」支持 UI Kit 的全部内置配色和组件风格，默认是 **紫霄配色 + 鹤坡 + 跟随系统**。可手动选择浅色或深色，浏览器会记住偏好。
- **PWA**：通过 HTTPS 打开门户，在 Chrome 或 Edge 菜单中选择安装；在 iOS Safari 中通过「分享 → 添加到主屏幕」安装。应用以独立窗口打开 `/login`。断网时可查看重试提示；登录和文档仍需联网，Service Worker 不缓存门户页面或 API 响应。

## Agent Skills

在 skills CLI 中列出此仓库的 Skills，或安装 MCP 用法与文档发布设置：

```sh
npx skills add zixiao-labs/portal --list
npx skills add zixiao-labs/portal --skill portal-mcp --skill portal-docs-publishing
```

源码位于 [`.agents/skills`](.agents/skills/)，也供 skills.sh 从公开仓库发现。榜单受 skills.sh 的安装统计影响。安装 Skills 不会授权仓库或自动发布文档。

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
pnpm test:action  # 需要 Python 3；验证发布 Action，不会发送真实请求
pnpm test:visual # 需要 Docker；在与 CI 相同的 Linux/amd64 容器中构建并运行视觉测试
```

Nasti 2.11 的 Start 热更新暂时关闭；源文件变化后重新加载浏览器即可。视觉测试统一使用容器中的 Chromium 和字体，避免不同系统的渲染差异影响基线。原图写到 `artifacts/`；有意修改界面时，先检查原图，再运行 `pnpm test:visual --update` 更新基线。

`pnpm dev` 不注册 Service Worker，避免干扰重新构建；`pnpm test:visual` 会用生产构建检查 PWA 安装条件、断网提示和恢复联网后的重试。

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
| `PORTAL_ADMIN_EMAILS` | 启用后台时新增。填获授权的 `@zixiaolabs.com` 工作邮箱，多个用逗号分隔；留空禁用后台，不影响门户和已授权仓库 |
| `SMTP_USER` | SMTP 登录用户名，阿里企业邮箱填完整邮箱地址 |
| `SMTP_PASSWORD` | SMTP 客户端安全密码原文，无需 URL 编码或额外加引号 |

默认通过 `portal-deploy@zixiaolabs.com:22` 连接。需要变更时，在 `production` 环境的 **Variables** 设置 `DEPLOY_USER`、`DEPLOY_HOST`（DNS 名或 IPv4）、`DEPLOY_PORT`。ARM64（`aarch64`）服务器需要在 **仓库级 Actions Variables** 设置 `PORTAL_DEPLOY_ARCH=arm64`；`x86_64` 无需设置。准备就绪后，在同一仓库级位置设置 `PORTAL_DEPLOY_ENABLED=true`，然后在 Actions → **Verify portal** 选择 `main` 手动运行，或等下一次推送到 `main`。运行时凭证经 SSH 传入，不需要预先创建服务器 `.env` 文件；服务器上拥有 Docker 权限的用户仍可读取运行时环境。

JWT 沿用 `PORTAL_SECRET` 派生签名密钥，GitHub 绑定沿用现有 OAuth App 及回调地址；文档发布也不需要新建 Secret。镜像的 SSH 发布与文档的 OIDC 发布是两条链路，保留现有 SSH、OAuth 和 SMTP 配置。

第三方 OAuth 复用现有 `PORTAL_SECRET`，不需要额外配置 GitHub OAuth App 或 Secret。启动时自动创建应用注册和授权相关表，不改变已有仓库发布授权。旧的匿名动态注册和相应 Token 不再有效，请从个人中心重新注册并替换客户端的 Client ID。

上线后检查 `curl -I http://zixiaolabs.com/`（跳转 HTTPS）、`curl -i https://zixiaolabs.com/`（`301` 到 `/login`）、`https://zixiaolabs.com/sitemap.xml`，并实测 GitHub 登录、邮箱验证码与文档发布。SQLite 保存在 `zixiao-portal-data` 命名卷；请定期做 SQLite `.backup` 或停机备份，不要删卷或只拷贝活动数据库主文件。若已有部署使用其他位置的数据库，**先备份并迁移到该卷，再启用 CD**。单实例替换会有短暂中断；若主机宕机等中断留下 `zixiao-portal-previous`，先用 `docker ps -a` 确认当前容器状态，恢复或清理旧容器后再发布。定期检查磁盘并清理不再使用的旧镜像。

#### 从旧版升级

1. 切换前备份 `zixiao-portal-data` 中的 SQLite。仍使用 `/data/portal.sqlite`；启动只新增 GitHub 授权流程、显式绑定、停用用户和发布授权表及索引。不删改已有账号、关联、文档和旧 Token 记录，不需要手工 SQL 或重建卷。
2. 保持原 `PORTAL_SECRET`。旧的不透明会话 Cookie 不再接受，已登录用户需要重新登录一次。旧版可读取同一数据卷，但不识别新 JWT、纯 OIDC 工作流或新版停用记录；若必须回滚，先从工作邮箱和 GitHub 侧阻止已停用账号重新登录。回滚应用不会回退数据库。
3. 设置 `PORTAL_ADMIN_EMAILS` 后部署门户，用工作邮箱登录后台为原计划发布的仓库逐一授权。发布授权初始为空：不会从历史 Token 自动推断对外发布权限，也不再读取 `PORTAL_PUBLISH_REPOSITORY_IDS`。切换各内容仓库的新工作流，从 `main` 试发成功后再移除旧 `PORTAL_PUBLISH_TOKEN` Secret。已有文档在切换期间仍可访问。

### GitHub OAuth App

1. 以组织管理员进入 `zixiao-labs` 的 **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. 应用名填 `Zixiao Laboratories Portal`，Homepage URL 填 `https://zixiaolabs.com`，Authorization callback URL 填 `https://zixiaolabs.com/api/auth/github/callback`。
3. 记录 Client ID，生成 Client Secret，只保存到门户仓库的 `production` 环境 Secret（见上表）。只需 `user:email`，不要授予仓库权限。不要把它配置到文档发布工作流或其他仓库。
4. 分别实测访客 GitHub 注册、员工邮箱登录、在个人中心绑定 GitHub、退出后用所绑定的 GitHub 登录。显式绑定后依据 GitHub 数字账号 ID 识别身份，个人 GitHub 主邮箱可与工作邮箱不同。既有的 GitHub 自动注册/关联仍验证原主邮箱；已经关联其他门户账户的 GitHub 不会自动合并，请联系管理员处理。

离职运维：在管理后台停用账号，会结束该账号的会话并阻止重新登录，不删除账号或关联数据。若离职者是管理员，先从 `PORTAL_ADMIN_EMAILS` 移除并重新部署，再停用；仅通过 GitHub 登录不会获得管理权限。仍需同步关闭工作邮箱、移除 GitHub 仓库、分支和环境访问权。仓库发布权限不与个人账户绑定。

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

1. **在门户授权仓库。** 管理员用工作邮箱登录，打开 **个人中心 → 管理后台 → 可发布仓库**，或使用 [MCP](docs/mcp.md)；两者操作同一份授权记录。用 `gh api repos/zixiao-labs/<repo> --jq .id` 查询数字 ID（私有仓库需有查询权限）。新授权和撤销立即生效，不需要部署。门户根据 GitHub 签名的仓库名称和 ID 比对授权，不需要 PAT 或读取私有仓库的凭据。
2. **在各内容仓库接入 Action。** 把 [工作流模板](.github/workflows/publish-docs.yml) 原名放在 `.github/workflows/`。选择以下一种安装方式；两种调用的是同一个可移植的 [Composite Action](.github/actions/publish-docs/action.yml)：
   - **复制到获授权的组织仓库：** 把 [`.github/actions/publish-docs/`](.github/actions/publish-docs/) 一并复制到内容仓库，模板无需改动。复制到公开仓库前，请按 [License](License) 取得公开分发许可。
   - **集中引用：** 将模板中的本地 Action 引用替换为 `uses: zixiao-labs/portal/.github/actions/publish-docs@<已审核的完整提交 SHA>`。调用方必须允许该 Action；如果门户仓库是私有的，还需在门户仓库 **Settings → Actions → General → Access** 中授权组织内的私有仓库访问。公开仓库不能直接引用私有 Action。
3. **配置发布门槛。** 在内容仓库创建 `docs-publish` 环境，只允许 `main`，并建议启用必需审批、禁止自我审批（以所在计划支持为准）。保护 `main`，对 `docs/**`、`.docsignore`、发布 workflow 和仓库内的 Action 代码设 CODEOWNERS/必需审核。将**仓库级** Actions Variable `PORTAL_DOCS_ENABLED` 设为 `true`。模板仅授予 `contents: read`、`id-token: write`，不需要发布 Secret。默认发布到 `https://zixiaolabs.com`；已配置 `PORTAL_ORIGIN` 的仓库继续使用该地址。
4. **试发。** 审核 `docs/` 的内容并合并到 `main`，或在 Actions 选择 `main` 手动运行。门户校验 GitHub 签名、时效、精确 audience `https://zixiaolabs.com/api/publish`、组织 ID、仓库 ID 和名称、工作流路径、分支、环境与事件，并拒绝重放。OIDC 验证的是运行该 Action 的工作流，不证明仓库已开启分支保护或审批；这些规则需在内容仓库配置。

#### 文档格式、忽略与更新

- 从终端可以用 `gh workflow run publish-docs.yml --repo zixiao-labs/<repo> --ref main` 触发发布。HTTP 请求格式、发布结果和 Context7 提交流程见[发布文档指南](docs/publish-docs.md)。
- 只收集 Git 跟踪的 `docs/` 下常规 `.md`、`.mdx`、`.html` 文件。路径各段使用小写英数字、`_`、`-`，首字符必须是英数字；`docs/guides/start.md` 发布为 `/docs/<repo>/guides/start`。同一路径不能同时存在不同扩展名。页面标题取第一条一级标题，摘要取首段。
- 根目录 `.docsignore` 使用 gitignore 语法，例如 `/docs/drafts/`；标准 `.gitignore` 也会生效，两套规则独立计算，任一排除的文件都不会上传。不要用忽略规则替代内容审查：所有上传文档都可公开访问，即使来源是私有仓库。
- MD 支持 GFM；HTML 会净化；MDX 支持 Markdown 和无属性的静态标签（如 `details`、`summary`、`kbd`、`mark`），拒绝自定义组件、表达式和 `import`/`export`。不会执行上传代码，也不代理资源；脚本、嵌入和图片不显示。文间链接用实际文档 URL，例如 `/docs/my-repo/guides/start`，不要链接源 `.md` 文件。
- 每次发布是该仓库完整快照，SQLite 在一次事务内仅替换该仓库文档；从快照移除一篇即下线。每次 1–250 篇，JSON ≤ 2 MiB，单篇 ≤ 120,000 个 UTF-16 代码单元。误发布时先从内容仓库移除并重发；若需清空整个集合或迁移已发布仓库名称，请由管理员备份后维护数据库。撤销授权只会停止未来发布，不会下线已发布内容。
