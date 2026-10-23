# Fork 说明：请求脱敏（Redaction）

本仓库 fork 自 [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub)，在其基础上增加了「请求脱敏」功能，仅供自用。本文档说明功能、构建镜像的方式，以及如何持续跟随上游更新。

## 功能概览

- **出站脱敏**：每个发往上游供应商的请求，在最终序列化之前把敏感值替换为占位符，例如 `[REDACTED:OPENAI_KEY#3fa1c09e]`。
  - 作用于最终请求体的副本，客户端原始请求、会话详情里的「请求前」内容都保持原样；会话详情的「请求后」内容就是实际发往上游的脱敏版本。
  - 占位符由 `HMAC(salt, 原值)` 生成，**同一个值永远得到同一个占位符**，因此不会破坏上游的 Prompt 缓存前缀。
  - 支持 Anthropic Messages、OpenAI Chat、OpenAI Responses / Codex、Gemini 格式。id、签名、thinking 块、图片等协议字段不会被改动（否则会导致工具配对或签名校验失败）。
  - `count_tokens`、`responses/compact` 这类原样透传的端点同样会脱敏。
- **内置规则**（36 条，移植自 `~/project/demo` 下的 privacy-filter、redact-restore、claude-code-redact、claude-code-privacy-guard）：
  - 默认开启：各厂商密钥（Anthropic、OpenAI 风格 `sk-`、OpenRouter、Google、AWS、GitHub、GitLab、Slack、Stripe、阿里云、腾讯云等）、PEM 私钥、JWT、连接串密码、Authorization / Bearer、`password=` / `密码：` 赋值；带校验位的中国手机号、身份证号、银行卡号（Luhn）。
  - 默认关闭（代码里容易误伤）：邮箱、IPv4、MAC、内网主机名、国际电话、IBAN、统一社会信用代码。
  - 可在设置页单独开关；支持白名单（永不遮盖的精确值）。
- **自定义规则**：正则（可只遮盖某个捕获组）或精确值；保存时会校验正则、拒绝过宽的规则。
- **Jev 自动发现规则**：
  1. 本地启发式只在**新内容**中找候选：疑似密钥的赋值右值、高熵随机串、URL 中的密码；UUID、git 哈希、路径、版本号、代码标识符、`${VAR}` 等会被排除。
  2. 候选交给 [TypeSafe Jev](https://docs.typesafe.ai/models)（Decisions API，`choice` 题型）判定：密钥 / 个人信息 / 内部标识 / 无害。
  3. 置信度 ≥「自动生效阈值」（默认 0.9）→ 立即生成**生效**的精确值规则；介于「建议阈值」（默认 0.6）与自动生效阈值之间 → 生成**待审核**规则；带厂商前缀的 token（如 `acme_xxx`）还会推导出一条通配整个 token 家族的正则规则（始终待审核）。
  4. 每个值只判定一次（判定结果按哈希缓存在数据库）；失败 10 分钟后才会重试。
  5. 同步模式下会在超时时间内等待判定，**首次出现就能被遮盖**；异步模式不延迟请求，新规则从下一个请求起生效。
  6. 默认「遮盖」发送模式：Jev 只会收到候选值的形态（前缀、长度、字符类别、熵）和已遮盖已知敏感值的上下文，**不会收到值本身**。
- **使用记录**：
  - 使用记录列表的状态列旁会出现盾牌图标和数字，点开即可看到每个值的**原文**、**发往上游的占位符**、所在位置（JSON 路径）以及上下文。请求详情侧栏的「概要」页顶部也有同样的区块。
  - **只记录本次请求新增内容中的命中**：会话每轮都会重发历史，同一段文本里已经报告过的值不会在后面每条记录里重复出现；用户在新消息里再次粘贴同一个值会再次记录；**上下文压缩后**，摘要是新文本，其中的值会重新记录一次。
  - 实现方式：按「所在字符串的指纹 + 偏移 + 值」生成命中键，每个会话（无会话时按 API Key）在 Redis 中记住已报告的命中键（默认 72 小时，Redis 不可用时退化为进程内存）。
  - 可关闭「保存原文」，此时只保存 `sk-p…uV (51)` 形式的遮盖预览。
  - 非管理员用户只能看到自己请求的脱敏记录。

> 注意：这是**不可逆**脱敏（与 privacy-filter 一致）。模型看到的是占位符，所以如果让模型把某个被遮盖的值写进文件，写进去的会是占位符；编辑包含被遮盖值的文件也可能因为 `old_string` 不匹配而失败。这正是邮箱、IP 等规则默认关闭的原因。

## 使用

1. 打开 **设置 → 请求脱敏**，在「通用设置」中开启脱敏并保存。
2. 「内置规则」按需开关；「测试台」可以粘贴文本预览效果（不会发送给 Jev）。
3. 需要自动发现时，在「Jev 自动发现」中填写 API Key（TypeSafe 直连，或通过 OpenRouter），点「测试连接」，开启后保存。
4. 「自定义与自动发现」页可以审核 Jev 生成的待审核规则（批准 / 拒绝 / 编辑 / 删除）。

数据表（运行时自动创建，无需迁移）：`fork_redaction_settings`、`fork_redaction_rules`、`fork_redaction_candidates`、`fork_redaction_events`。

## 构建 GHCR 镜像

工作流 `.github/workflows/fork-ghcr.yml`：

- 推送到 `main` 时自动运行：先跑脱敏单元测试，再用上游的 `deploy/Dockerfile` 构建并推送镜像。
- 镜像：`ghcr.io/<你的用户名>/claude-code-hub`，标签 `latest`、`<上游版本>-fork.<短 SHA>`、`sha-<短 SHA>`。可用仓库变量 `FORK_IMAGE_NAME` 改镜像名。
- 默认只构建 `linux/amd64`（快）；需要 arm64 时在 Actions 页手动运行并把 platforms 填成 `linux/amd64,linux/arm64`。

首次设置：

1. 在 GitHub 仓库的 **Actions** 页启用工作流（fork 默认禁用）。
2. 禁用上游自带的工作流（否则推送 `main` 会触发上游的发版流水线 `release.yml` 等）：
   ```bash
   scripts/fork/disable-upstream-workflows.sh zhaojun1998/claude-code-hub
   ```
   这只修改仓库设置、不改文件，所以以后合并上游不会产生冲突。上游以后新增的工作流需要再运行一次脚本。
3. 部署时把 `docker-compose.yaml` 中的镜像改为 `ghcr.io/<你的用户名>/claude-code-hub:latest`。若包是私有的，服务器需先 `docker login ghcr.io`。

## 跟随上游更新

分支约定：`main` = 上游 `main` + 本 fork 的提交。

- **自动**：`.github/workflows/fork-sync-upstream.yml` 每天把上游 `main` 合并进来，有更新就重新构建镜像；有冲突时运行失败、不推送，需要手动处理。
  - 上游改动了 `.github/workflows` 时，`GITHUB_TOKEN` 无权推送；可添加仓库 Secret `SYNC_TOKEN`（细粒度 PAT，权限：Contents 读写、Workflows 读写），否则这类更新需手动同步。
- **手动**：
  ```bash
  git remote add upstream https://github.com/ding113/claude-code-hub.git   # 只需一次
  git fetch upstream
  git checkout main
  git merge upstream/main
  bun install && bun run test tests/unit/redaction && bun run typecheck
  git push origin main   # 触发镜像构建
  ```
  也可以直接在 GitHub 页面点 **Sync fork → Update branch**，推送后同样会触发构建。

### 冲突时需要关注的上游文件

本功能尽量都放在新文件里，只在以下上游文件中做了很小的改动（都带有 `[fork:redaction]` 注释）：

| 文件 | 改动 |
| --- | --- |
| `src/app/v1/_lib/proxy/forwarder.ts` | 两处调用：最终请求过滤之后 `applyOutboundRedaction`；原样透传分支 `applyOutboundRedactionToRaw` |
| `src/app/[locale]/dashboard/logs/_components/virtualized-logs-table.tsx` | 导入并在状态列渲染 `<RedactionBadge />` |
| `src/app/[locale]/dashboard/logs/_components/error-details-dialog/index.tsx` | 导入并在概要页顶部渲染 `<RedactionDetailsSection />` |
| `src/app/[locale]/settings/_lib/nav-items.ts` | 设置导航新增一项 |
| `messages/*/settings/index.ts` | 注册 `redaction` 文案 |

新增文件：`src/lib/redaction/**`、`src/app/api/fork/redaction/**`、`src/app/[locale]/settings/redaction/**`、`src/app/[locale]/dashboard/logs/_components/redaction/**`、`messages/*/settings/redaction.json`、`tests/unit/redaction/**`、`.github/workflows/fork-*.yml`、`scripts/fork/**`、`FORK.md`。

页面通过独立的 REST 路由 `/api/fork/redaction/*` 读写数据（上游禁止客户端组件直接调用 Server Action），鉴权、CSRF 和管理员校验复用上游 `/api/v1` 的中间件，但没有注册进上游的 OpenAPI 应用，所以上游改动 `/api/v1` 不会和本功能冲突。

数据表不走上游的 drizzle 迁移（上游迁移按序号递增，fork 自带迁移会在每次同步时冲突），而是在 `src/lib/redaction/store.ts` 中用 `CREATE TABLE IF NOT EXISTS` 幂等创建。若本地开发使用 `bun run db:push`，drizzle-kit 可能会提示删除这几张 `fork_` 表，选择保留即可。

## 开发

```bash
bun run test tests/unit/redaction   # 本功能的单元测试
bun run typecheck
bun run lint
```

主要代码：

- `src/lib/redaction/engine.ts`：规则编译、匹配、合并重叠、确定性占位符
- `src/lib/redaction/builtin-rules.ts`、`validators.ts`：内置规则与校验（Luhn、身份证、熵、占位值识别等）
- `src/lib/redaction/body-walker.ts`、`redact-body.ts`：按协议遍历请求体
- `src/lib/redaction/incremental.ts`：增量命中去重
- `src/lib/redaction/candidates.ts`、`jev-client.ts`、`discovery.ts`：Jev 自动发现
- `src/lib/redaction/runtime.ts`、`outbound.ts`：运行时与 forwarder 接入
- `src/lib/redaction/http-api.ts`、`client-api.ts`：页面使用的 REST 路由与浏览器端调用
