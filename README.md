# 紫霄实验室门户 · Zixiao Laboratories

- `/login`：公开的登录入口。任何用户都可通过 **GitHub** 登录／自动注册，但 GitHub 主邮箱必须已验证；工作邮箱验证码仅发给 `@zixiaolabs.com`，不开放公开邮箱注册。员工身份只来自验证通过的工作邮箱；用 GitHub 登录时，已验证的主邮箱须是工作邮箱。GitHub 主邮箱变更不会自动迁移现有账户。
- `/account`：登录后读取账户资料。员工可按组织仓库签发、查看和撤销发布 Token；明文只显示一次，有效期 90 天。不需要登录的文档公开索引；个人中心与 API 不索引。
- `/docs`：公开 SSR 文档库，带标题、描述、canonical、sitemap 与全文页面。由组织内 GitHub Actions 发布，不允许单独持 Token 上传。CLI 是路线图，目前没有发布命令。
- 外观菜单支持 UI Kit 的全部内置配色、组件风格和明暗，默认是 **紫霄配色 + 鹤坡 + 浅色**。浏览器保存偏好。

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
pnpm exec playwright install chromium
pnpm test:visual # 使用已构建的产物，运行 Lightning 浏览器回归测试
```

Nasti 2.11 的 Start 热更新暂时关闭；源文件变化后重新加载浏览器即可。视觉测试将原图写到 `artifacts/`；有意修改布局与配色后检查原图再运行 `pnpm test:visual --update` 更新基线。

开发无需凭据即可查看登录页面和空文档库。若要连调 GitHub，单独注册一个回调为 `http://localhost:3000/api/auth/github/callback` 的 OAuth App。不要复制生产 OAuth 密钥到本地。使用 `.env.example` 作为配置参考；不测试邮件时可以不设置 `SMTP_URL` 和 `SMTP_FROM`。

## 正式部署

**仅限紫霄实验室授权的 `zixiaolabs.com` 或其子域。** 以下以 `portal.zixiaolabs.com` 为例，也是公开页面的 canonical 域名。若做正式域名迁移而不是镜像，请同步更新 `src/deployment.mjs` 中的 canonical。生产启动拒绝本地和未授权域名；入口服务也会在提供静态资源之前拒绝与 `PORTAL_ORIGIN` 不符的 `Host`（HTTP 421）。`pnpm dev` 只用于本机开发。

1. 在域名服务商配置 DNS，在同一机器的 TLS 反向代理上配置证书。代理只能转发准确的站点 `Host`，不能把任意外部 Host 重写成授权域名。不要把内部 HTTP 端口直接暴露到公网。
2. 参考 `.env.example` 在服务器创建不受 Git 跟踪的环境配置（权限 `0600`），设 `PORTAL_ORIGIN=https://portal.zixiaolabs.com`。使用 `openssl rand -hex 32` 生成 `PORTAL_SECRET`，按下节配置 OAuth、SMTP 与 `GITHUB_ORG_ID`。组织 ID 可用 `gh api orgs/zixiao-labs --jq .id` 查询。
3. 单机部署：执行 `pnpm install --frozen-lockfile && pnpm build`，然后让 systemd 等进程管理器以普通用户、在仓库目录运行 `pnpm start`。或使用容器：

   ```sh
   docker build -t zixiao-portal .
   docker volume create zixiao-portal-data
   docker run -d --name zixiao-portal --restart unless-stopped \
     --env-file /secure/portal.env \
     -e BIND_HOST=0.0.0.0 -e SQLITE_PATH=/data/portal.sqlite \
     -p 127.0.0.1:3000:3000 \
     -v zixiao-portal-data:/data zixiao-portal
   ```

   `docker --env-file` 不处理引号：容器配置文件的 `SMTP_FROM` 建议只填邮箱地址，不加引号。SQLite 文件及其 WAL/SHM 放在同一持久化磁盘；先按单实例部署，不要用共享网络文件系统做多副本。备份用 SQLite `.backup` 或停机备份，不要只拷贝活动数据库主文件。
4. 反向代理示例（Nginx）：

   ```nginx
   server {
       listen 443 ssl;
       server_name portal.zixiaolabs.com;
       ssl_certificate     /path/to/fullchain.pem;
       ssl_certificate_key /path/to/privkey.pem;
       client_max_body_size 2m;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $http_host;
           proxy_buffering off;
       }
   }
   ```

   未知域名配置单独的默认虚拟主机拒绝；若开启 80，只将本站域名重定向到本站 HTTPS。上线后检查 `/login`、`/sitemap.xml`、未登录的 `/api/account`（401）以及错误 Host（421），再在正式环境实测登录和发布。代理层对登录接口配置额外的请求限流，避免打满整个站点的邮件发送配额。

### GitHub OAuth App

1. 以组织管理员进入 `zixiao-labs` 的 **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. 应用名填 `Zixiao Laboratories Portal`，Homepage URL 填 `https://portal.zixiaolabs.com`，Authorization callback URL 填 `https://portal.zixiaolabs.com/api/auth/github/callback`。
3. 记录 Client ID，生成 Client Secret，分别配置 `GITHUB_CLIENT_ID`／`GITHUB_CLIENT_SECRET`。只需 `user:email`，不要授予仓库权限。不要把此 Secret 配进 Actions。
4. 分别用非员工账号与已验证主邮箱是 `@zixiaolabs.com` 的 GitHub 帐号实测。工作邮箱离职停用时，管理员也应撤销门户中的员工发布 Token、会话和 GitHub 关联账号的员工权限，不应只停用 SMTP。

离职运维：备份 SQLite，在同一事务内对该员工的 `users` 记录设置 `employee=0`，并按相同 `user_id` 删除 `sessions` 和 `tokens`；不要删除 `users` 记录，否则仍持有 GitHub 工作邮箱验证的用户可能重新注册。同步移除相应 Actions 环境 Secret。

### 阿里企业邮箱（不用 25 端口）

中国大陆站点使用 `smtp.qiye.aliyun.com:465`，隐式 TLS；非大陆站点按[阿里邮箱文档](https://www.alibabacloud.com/help/en/alibaba-mail/latest/alibaba-mail-imap-pop-smtp-address-and-port-information)选实际主机。启用服务邮箱的第三方客户端权限，使用客户端专用密码。配置 `SMTP_URL=smtps://<编码后的邮箱>:<编码后的客户端密码>@smtp.qiye.aliyun.com:465`，`SMTP_FROM` 填该邮箱或已授权发件地址。防火墙放行 TCP 465 出站即可，不要求开放 TCP 25。部署后请测试验证码接收，并配置 SPF/DKIM/DMARC。

### GitHub Actions：组织内文档发布

1. 组织 **Settings → Actions → General** 中允许选定的组织仓库运行 Actions，并批准 GitHub 提供的 `actions/checkout`。保持默认 `GITHUB_TOKEN` 只读；发布 job 仅声明 `contents: read`、`id-token: write`。
2. 将本仓库的 [publish-docs.yml](.github/workflows/publish-docs.yml) 原名放到每个**获准公开文档**的组织仓库。保护 `main`，对 `docs/**`、`.docsignore` 和发布 workflow 设 CODEOWNERS/必需审核。仓库 **Settings → Environments** 创建 `docs-publish`，只允许 `main`，建议设必需审批且禁止自我审批（以所在计划支持为准）。不要把发布 Secret 提供给 PR、fork 或任意未审核的工作流。
3. 员工在个人中心为这个 `zixiao-labs/<repo>` 创建 Token，保存为 `docs-publish` 环境 Secret `PORTAL_PUBLISH_TOKEN`；设环境变量 `PORTAL_ORIGIN=https://portal.zixiaolabs.com`。最后将**仓库级** Actions 变量 `PORTAL_DOCS_ENABLED` 设为 `true`，明确启用发布。若用组织级变量共享 Origin，请用 selected repositories 限定访问范围；每仓库的发布 Token 仍应独立。更新 Token 后撤销旧值。
4. 提交 `docs/`，合到 `main` 自动发布，或在 Actions 选择 `main` 手动运行。服务器同时验证员工 Token 与 GitHub 签名的短期 OIDC，核对组织 ID、仓库、环境、工作流文件、分支、事件和 audience。同一 OIDC JWT 不能重复提交。`GITHUB_TOKEN`、GitHub PAT、工作站请求及仅有员工 Token 的请求不能替代 OIDC。

#### 文档格式、忽略与更新

- 只收集 Git 跟踪的 `docs/` 下常规 `.md`、`.mdx`、`.html` 文件。路径各段使用小写英数字、`_`、`-`，首字符必须是英数字；`docs/guides/start.md` 发布为 `/docs/<repo>/guides/start`。同一路径不能同时存在不同扩展名。页面标题取第一条一级标题，摘要取首段。
- 根目录 `.docsignore` 使用 gitignore 语法，例如 `/docs/drafts/`；标准 `.gitignore` 也会生效。不要用忽略规则替代内容审查：所有上传文档都可公开访问，即使来源是私有仓库。
- MD 支持 GFM；HTML 会净化；MDX 支持 Markdown 和无属性的静态标签（如 `details`、`summary`、`kbd`、`mark`），拒绝自定义组件、表达式和 `import`/`export`。不会执行上传代码，也不代理资源；脚本、嵌入和图片不显示。文间链接用实际文档 URL，例如 `/docs/my-repo/guides/start`，不要链接源 `.md` 文件。
- 每次发布是该仓库完整快照，SQLite 在一次事务内替换；从快照移除一篇即下线。每次 1–250 篇，JSON ≤ 2 MiB，单篇 ≤ 120,000 字符。误发布时先从内容仓库移除并重发；若需清空整个集合或仓库改名，请由管理员备份后维护数据库。撤销 Token 不会撤掉已发布的内容。
