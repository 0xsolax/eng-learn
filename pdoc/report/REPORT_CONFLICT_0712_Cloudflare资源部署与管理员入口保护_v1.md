# REPORT_CONFLICT_0712_Cloudflare资源部署与管理员入口保护_v1

## 1. 文档信息

- 项目：eng-learn
- 日期：2026-07-12
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 结论：云端资源创建和 Worker 部署通过；管理员公网入口保护未达到生产验收标准。

## 2. 本次范围

本次只创建和配置云端 MVP 当前代码实际依赖的资源：

- Cloudflare Worker：Vue 静态资源和 Worker API。
- Cloudflare D1：词库、课程、课时任务、答题日志和单词状态。
- Worker secret：`ADMIN_API_TOKEN`，用于保护 `/api/admin/*`。

当前代码未使用 KV、R2、Queue、Durable Objects、Workers AI 或 Vectorize，因此未创建这些资源。

## 3. 已创建和复用的资源

| 资源 | 结果 |
| --- | --- |
| Cloudflare account | `0xsolax@gmail.com's Account` |
| account_id | `c7ca52deb3d8d683f242d58b95c928b9` |
| Worker | 复用已有 `eng-learn` |
| Worker URL | `https://eng-learn.0xsolax.workers.dev` |
| Worker version | `bb895040-6fad-4c9a-9d8f-f2834f3a3617` |
| D1 database | 新建 `eng-learn-prod` |
| D1 database_id | `851f7eb3-e88e-40dc-bc83-37f327774067` |
| D1 location | APAC，远端查询由 HKG primary 提供 |
| Worker secret | 已配置 `ADMIN_API_TOKEN`，正文不记录明文 |

管理员令牌的本地副本保存在 Git 忽略的 `.dev.vars` 中。构建扫描确认令牌值只存在于本地忽略文件，没有进入可部署 JavaScript、静态资源或 Wrangler 配置。

## 4. 数据库结果

已应用迁移：

- `0001_initial.sql`
- `0002_add_review_task_integrity.sql`

远端复核结果：

- 无待执行迁移。
- 已创建 14 张系统和业务表。
- 本轮未写入测试词库或学习数据。

## 5. 配置变更

`wrangler.jsonc` 已完成以下变更：

- 固定目标 `account_id`，避免多账号环境部署到错误账号。
- D1 binding 保持为 `DB`。
- 数据库名称改为 `eng-learn-prod`。
- 占位 database_id 替换为真实 D1 UUID。

`worker-configuration.d.ts` 已在不加载本地 `.dev.vars` 的隔离环境中通过 `wrangler types --check`；本机 secret 派生的类型变化不进入提交。

## 6. 验证结果

| 验证项 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 通过，17 个测试 |
| `pnpm test:e2e` | 通过，1 个浏览器用例 |
| `pnpm build` | 通过 |
| `pnpm cf:check` | 通过 |
| `wrangler deploy --dry-run` | 通过，仅包含 D1 binding |
| 远端 D1 migration | 通过，无待执行迁移 |
| `GET /api/app/health` | `200` |
| 无令牌访问 `/api/admin/health` | `401` |
| 带令牌访问 `/api/admin/health` | `200` |
| 浏览器导航 `/app`、`/admin` | SPA fallback 可用 |

## 7. 未消解冲突

计划要求：

- `/app` 对学习者公开。
- `/admin` 和 `/api/admin/*` 必须有管理员认证或等价保护。

当前状态：

- `/api/admin/*` 已由 `ADMIN_API_TOKEN` 保护。
- `/admin` 仍是公开可加载的静态 SPA 路由。
- 当前 `/admin` 只显示占位内容，不读取或展示管理数据，但后续接入真实管理功能后不能维持该状态。
- 本轮没有提供自定义域名或最终 Access 策略，因此未创建 Cloudflare Access 应用。

这意味着资源部署可以用于后台 API 和 D1 联调，但不能按计划认定为正式生产安全验收通过。

## 8. 处理选项

推荐顺序：

1. 使用 Cloudflare 托管的自定义域名，为 `/admin*` 和 `/api/admin/*` 配置路径级 Access，保持 `/app*` 公开。
2. 如果暂时不使用自定义域名，增加应用层管理员登录和服务端会话，作为等价保护。
3. 如果后续安全边界继续扩大，再把管理员端和学习端拆成两个 Worker；第一版不建议立即扩大为双 Worker 架构。

在上述任一方案完成前：

- 不在该环境录入真实儿童敏感信息。
- 不把当前部署标记为生产安全验收完成。
- 管理操作只通过受控设备和管理员令牌进行。

## 9. 回滚信息

- Worker 可回滚到部署前版本。
- D1 当前只有 schema，没有测试业务数据；如需废弃，应先确认没有后续写入。
- `ADMIN_API_TOKEN` 无法从 Cloudflare 读取明文，丢失时应重新生成并轮换。

## 10. 最终判定

- 云端资源创建：通过。
- D1 迁移：通过。
- Worker 部署和绑定：通过。
- 管理 API 鉴权：通过。
- 管理员公网入口生产保护：未通过，等待 Access 或等价认证方案决策。
