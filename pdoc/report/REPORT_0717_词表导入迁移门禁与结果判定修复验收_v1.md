# REPORT_0717_词表导入迁移门禁与结果判定修复验收_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：生产故障修复与发布验收报告
- 报告版本：v1
- 状态：生产修复、发布与真实数据验收完成
- 日期：2026-07-17
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0717_词表导入迁移门禁与结果判定修复_v1.md`
- 验收范围：生产 D1、导入 API 契约、双模式幂等、前端自动确认、发布门禁、本地全量测试、生产 Worker、118 词真实导入

## 2. 验收结论

本次故障已经完成生产恢复和机制收口，计划列出的 12 项完成标准全部通过。

1. 生产 D1 已应用 `0011_add_progressive_context_model.sql`，本地与远端 11 份 migration 顺序一致。
2. 导入仍保留“本地预览 -> 一次用户确认 -> 创建可编辑草稿”的产品链路；草稿不是额外导入步骤，也没有被取消。
3. 主按钮已改为“导入并创建草稿”，普通成功和响应丢失路径都不再要求用户点击“安全重试”。
4. 明确失败、schema 未就绪和需要自动确认已经分为稳定错误契约，界面不再显示“导入结果未知”。
5. 新词库和同词库下一版本均使用 operation token、完整请求指纹和原子 operation ledger；精确重放最多写入一次，冲突重放明确拒绝。
6. 生产发布命令已收口为 `pnpm release:deploy`；远端 migration 不齐、数据库身份不符或检查异常时，在 Worker 上传前失败关闭。
7. 真实生产导入最终得到 1 个 source、1 个 draft version、118 个 words、24 个 groups 和 1 条 operation；118 行六列内容与输入 CSV 逐行完全一致。
8. 当前生产详情页可见 `人教版5年级上册 / v1`、`草稿` 和 `导入 118 个词`，浏览器控制台无 warning 或 error。

## 3. 根因与修复边界

### 3.1 根因

故障由三层问题串联形成：

1. 生产 Worker 已读取 `source_versions.content_model`、`words.example_phrase` 和 `words.example_sentence_extended`。
2. 生产 D1 当时只迁移到 `0010`，漏应用随代码发布的 `0011`，因此导入首次访问新字段时返回 HTTP 500。
3. 前端把明确的服务端失败误归为“结果未知”，又要求用户手动重试；自动部署流程同时缺少远端 migration 完整性门禁。

故障前两次失败均已由 D1 事务回滚。故障调查时四张业务表和 operation ledger 都是零记录，不存在需要清理的半成品草稿或重复数据。

### 3.2 保留的业务边界

- 导入后创建草稿是既定内容生命周期的一部分，必须保留。
- 练习构建、人工审批、发布覆盖率和已发布版本不可变规则没有被绕过。
- CSV 六列契约、500 行和 256 KiB 上限没有改变。
- 本次没有修改学习端、课程、课时调度、错词队列或已发布内容快照规则。

## 4. 生产 D1 恢复与发布门禁

### 4.1 D1 恢复

- 数据库：`eng-learn-prod`
- database ID：`851f7eb3-e88e-40dc-bc83-37f327774067`
- 迁移前 Time Travel bookmark：`0000001c-00000000-000050ab-673ef80aab0c25bffa4d872ebf508ca6`
- 已应用 migration：`0011_add_progressive_context_model.sql`
- 迁移后结果：本地与远端 11/11 一致，新字段和内容模型不可变触发器存在。
- 2026-07-17 最终只读复核：`pnpm db:migrations:check:remote` 通过，目标名称和 database ID 一致。

`0011` 是 additive migration。发生代码回滚时保留该 migration；不得删除列或触发器。只有确认 schema 或数据受损、停止生产写入并再次获得 Solazhu 明确授权后，才能评估使用上述 bookmark 执行 Time Travel restore。

### 4.2 发布门禁

新增的只读门禁会校验：

- `wrangler.jsonc` 中的数据库名称和 ID；
- 本地 migration 文件名及顺序；
- 远端 `d1_migrations` 的文件名、顺序和完整性；
- Wrangler 输出、认证和远端查询是否可解析并成功。

项目脚本已经分离为：

- `pnpm db:migrations:check:remote`：只读检查；
- `pnpm db:migrate:remote`：需单独授权的生产写入；
- `pnpm release:deploy`：先通过只读门禁，再执行严格 Worker 部署。

Cloudflare Workers Builds 的 Deploy command 已由 `npx wrangler deploy` 改为 `pnpm release:deploy`，并在 Dashboard 回读确认。故障注入已证明本地多出 migration、数据库身份不符、远端查询失败或输出损坏时均会在上传前非零退出。

## 5. 实施结果

### 5.1 服务端结果契约与幂等

- 两种导入模式都强制要求 operation token。
- v2 请求指纹覆盖导入模式、目标 source/name、六列单词数据和原始顺序。
- 兼容既有新词库 v1 指纹记录的精确重放，不回写或误判历史 operation。
- operation ledger 与 source、version、words、groups 使用同一 D1 batch 原子提交。
- 同 token + 同请求精确重放原结果；同 token + 不同请求返回 `idempotency_conflict`。
- schema 缺失返回 `schema_not_ready`；账本暂时无法核验时返回 `import_reconcile_required`；已确认未提交的内部错误保持明确失败。
- 精确重放返回第一次导入时的 `draft` 结果，不会因版本后来归档或发布而漂移。

### 5.2 前端一次确认与自动收敛

- CSV 选择和预览只在浏览器本地完成，不写服务端。
- 一次点击“导入并创建草稿”后，页面锁定当前命令、payload 和 token。
- 只在网络失败、响应契约损坏或 `import_reconcile_required` 时自动确认，退避间隔为 0/1/5/15/30 秒。
- 自动确认始终重放同一命令；页面隐藏或离线时暂停，恢复可见或联网后继续。
- 同标签页刷新可从 `sessionStorage` 恢复；损坏或超过 512 KiB 的恢复数据失败关闭且不发请求。
- 成功终态不会被后续列表刷新失败改写；组件卸载后不会重新启动后台计时器。
- 页面已经删除手动安全重试入口和“结果未知”文案。

### 5.3 定点复核

实现完成后进行了两轮独立定点代码复核。复核发现的精确重放结果漂移、成功后列表刷新改写终态、卸载后计时器恢复等问题均已补测试并修复；最终两轮复核均无剩余发现。

## 6. 验证矩阵

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript / 发布构建 | 通过 | `pnpm typecheck`、`pnpm build` |
| ESLint | 通过 | `pnpm lint` |
| 全量单元测试 | 通过 | 64 files / 562 tests |
| 全量组件测试 | 通过 | 19 files / 253 tests |
| 隔离 Worker + D1 整栈 | 通过 | 6 passed / 0 failed，含 118 词导入和响应丢失恢复 |
| 完整 UI 浏览器测试 | 通过 | 55 passed / 13 skipped / 0 failed；13 项由既定配置跳过 |
| Cloudflare 类型与启动分析 | 通过 | `pnpm cf:types:check`、`pnpm cf:check` |
| 构建与敏感产物扫描 | 通过 | `pnpm scan:artifacts` |
| 远端 migration 门禁 | 通过 | `eng-learn-prod` / 指定 database ID / 11 migrations |
| migration 故障注入 | 通过 | 缺 migration、身份不符、输出损坏和远端失败均失败关闭 |
| 差异卫生 | 通过 | `git diff --check` |

测试覆盖两种导入模式的 token 必填、完整指纹冲突、v1 兼容、D1 batch 中途失败零写入、账本重放、schema 未就绪、响应丢失自动确认、session 恢复失败关闭、成功终态锁定以及发布门禁失败路径。

## 7. 生产发布与运行态

### 7.1 发布记录

- 受控 `pnpm release:deploy` 发布：
  - Worker version：`e35a4d00-9506-4159-a30c-3ee566d0f762`
  - deployment ID：`961f5dff-a96a-45a5-a720-6555043516b2`
  - 创建时间：`2026-07-17T07:59:39.71454Z`
  - 当时流量：100%
- 随后远端 `main` 于 2026-07-17 16:13（Asia/Shanghai）更新到实施提交 `01bcc3c`，生产在 16:14 出现后续版本：
  - 当前 Worker version：`5e6fe640-bc1a-4eaa-b212-261830e1ad74`
  - deployment ID：`5e88e5a4-9ae5-4082-acad-73280f804d8d`
  - 创建时间：`2026-07-17T08:14:27.120344Z`
  - 当前流量：100%
  - 当前 D1 binding：`851f7eb3-e88e-40dc-bc83-37f327774067`

第二个版本晚于第一次受控发布，因此最终生产验收以当前 `5e6fe640...` 版本为准，不把旧版本号冒充为现行生产状态。

### 7.2 Health smoke

- `GET /api/app/health`：HTTP 200，返回 `{"ok":true,"data":{"scope":"app"}}`。
- 未认证 `GET /api/admin/health`：HTTP 401，符合管理员接口必须认证的设计。

## 8. 118 词生产真实验收

### 8.1 权威计数

用户在生产管理端完成真实导入后，远端 D1 只读核验得到：

| 对象 | 数量 |
| --- | ---: |
| `word_sources` | 1 |
| `source_versions` | 1 |
| `words` | 118 |
| `word_groups` | 24 |
| `admin_operations` | 1 |

目标记录：

- source ID：`edd52d7f-352b-4a18-9906-f03ffb647ef6`
- source name：`人教版5年级上册`
- version ID：`44ef6f22-77e1-403d-9769-9ce91a0b3706`
- version：`v1`
- status：`draft`
- content model：`v2_progressive_context`
- 单词顺序：最小 1、最大 118、去重后 118 个顺序值。

### 8.2 内容完整性

将生产 D1 的 118 行按 `order_index` 排序后，与 `/Users/solazhu/Downloads/eng-learn-word-import-template.csv` 的六列逐行比较：

- 118/118 行完全一致；
- 首个不一致行：不存在；
- `example_phrase` 空值：0；
- `example_sentence` 空值：0；
- `example_sentence_extended` 空值：0；
- 24/24 个分组的序号和 5 词边界完全符合预期；
- operation kind 为 `create_source`，target 为 `new-source`，结果中的 source/version ID 与业务记录一致。

最终核验查询返回 `changed_db=false`、`rows_written=0`，没有为验收修改生产数据。

### 8.3 浏览器与导入后动作

生产详情页显示：

- `人教版5年级上册 / v1`；
- `草稿`；
- `导入 118 个词`。

详情页浏览器控制台的 warning/error 结果为空。验收没有冒充抓到了最初的成功卡片或逐请求网络追踪；导入成功由当前详情页、唯一 operation ledger 和 D1 精确终态共同证明。

导入成功后，用户又独立点击了“构建练习”。最终只读状态为：

- `content_revision=1`；
- 118 个 exercise packs；
- 708 个 exercise items；
- 708 个 draft、0 个 approved、0 个 disabled。

这 708 条是 118 个词各 6 个阶段的预期练习，不是重复导入；source、version、words、groups 和 import operation 的数量仍保持 1/1/118/24/1。本次没有批准、发布、删除或改写这些练习。

## 9. 完成标准逐项审计

| # | 计划完成标准 | 结果 | 权威证据 |
| ---: | --- | --- | --- |
| 1 | 生产 D1 应用 0011 | 通过 | 11/11 migration、字段与触发器探针 |
| 2 | 本地预览后仅一次写入确认 | 通过 | 组件测试、生产实际操作 |
| 3 | 按钮为“导入并创建草稿” | 通过 | 组件与 UI 测试 |
| 4 | 无手动安全重试 | 通过 | 页面实现与组件测试 |
| 5 | 明确失败不显示未知 | 通过 | 错误契约、API 与组件测试 |
| 6 | 响应丢失自动用同 token 确认 | 通过 | unit/component/stack 故障注入 |
| 7 | 两种模式统一幂等语义 | 通过 | schema/service/D1/API 测试 |
| 8 | 精确重放一次、冲突重放拒绝 | 通过 | operation workflow 与 D1 测试 |
| 9 | 指纹覆盖 mode/target/六列/顺序 | 通过 | crypto 指纹变异测试 |
| 10 | 同标签刷新恢复原 token | 通过 | recovery 与组件测试 |
| 11 | migration 不齐阻断部署 | 通过 | 远端门禁与失败注入测试 |
| 12 | 生产终态 1/1/118/24/1 | 通过 | D1 只读计数与 118 行逐行比较 |

## 10. Git 与交付边界

- 实施提交：`01bcc3c 修复词表导入幂等与迁移门禁`。
- 远端 `origin/main` 当前指向 `01bcc3c`；本地 reflog 记录 2026-07-17 16:13 更新 by push。
- 本报告只陈述当前 Git 事实，不推断该 push 的具体操作者。
- 验收报告和计划完成状态另行本地提交；未获得新的 push 指令前不再次推送。

## 11. 最终决策

- 生产 D1 恢复：通过。
- 双模式导入幂等和结果契约：通过。
- 前端一次确认与自动收敛：通过。
- migration 发布门禁：通过。
- 本地全量与故障注入回归：通过。
- 当前生产 Worker 与 health：通过。
- 118 词生产数据完整性：通过。
- 用户后续练习构建：状态已记录，不纳入导入重复判定，不做额外修改。

## 12. 后续审查补丁验收（2026-07-17）

### 12.1 修复结论

首次验收后的代码复核发现并修复了三个证据与实现缺口：

1. ledger 已查空后的 readiness 普通依赖失败不再误转为 `import_reconcile_required`，而是保持明确的 `dependency_failure`。
2. 导入 operation 指纹改为复用共享 `ImportWordInput`，六列序列化由 `keyof` 穷尽约束；既有 v2 golden hash 保持不变。
3. 整栈验收新增真实 0010 D1 阶段和 D1 权威计数，不再以“全迁移数据库上的模拟异常”或仅版本数量代替缺迁移、零写入与 operation 唯一性证据。

本补丁的验收阶段只修改本地代码、测试、计划和验收报告；没有执行远端 migration、生产部署、生产数据写入或 push。

### 12.2 红绿证据

| 切片 | 红测 | 绿测 |
| --- | --- | --- |
| readiness 错误分类 | 期望 `dependency_failure`，旧实现实际返回 `import_reconcile_required` | workflow 定向套件 14/14 通过；crypto + workflow 合计 19/19 通过 |
| 指纹共享类型 | 先记录当前 v2 指纹并加入 golden 断言 | 重构后 hash 仍为 `sha256:c72cff2b43def325abb34ec452584cdb3e3fed96ce23dfccfe3507f849052c31`，类型检查通过 |
| 缺 0011 整栈 | 原 runner 先应用全部 11 个 migration，测试观察到导入成功而非 503 | 真实 0001–0010 D1 返回 503 / `schema_not_ready`，五类计数均为 0，1/1 通过 |
| operation 唯一性 | 原用例只断言 source version 数量 | 新建导入与下一版本各响应丢失一次后，D1 为 1 source / 2 versions / 40 words / 8 groups / 2 operations |

### 12.3 独立验收矩阵

最终验收基线为提交 `2e8428e` 加本补丁 8 个代码/测试文件的一次性隔离副本，避免工作区内并行开发影响判定。

| 门禁 | 结果 |
| --- | --- |
| TypeScript 三项目 | 通过 |
| ESLint | 通过 |
| unit | 64 files / 562 tests 通过 |
| component | 19 files / 253 tests 通过 |
| pre-0011 Worker + D1 | 1/1 通过 |
| post-0011 完整 Worker + D1 | 6/6 通过 |
| UI Playwright | 55 passed / 13 skipped / 0 failed |
| 发布构建与敏感产物扫描 | 通过 |
| Cloudflare types / startup | 通过 |
| `git diff --check` | 通过 |

### 12.4 并行工作区边界

验收期间工作区并行出现“学习版本双路径审阅”相关的共享类型、repository、service、页面和测试改动。该组改动在开发中途导致当前工作区 typecheck/lint 失败，并因页面删除“先查看”链接而使 6 个宽屏 UI 断言失败；在未包含该组改动的隔离副本中，同一 UI 套件 55/55 执行项通过。最终只读回查时 typecheck 已通过，lint 仍有 4 个 error 和 14 个 warning，均位于并行审阅功能文件。

因此，本节只确认词表导入后续补丁自身通过，不替并行功能宣布全仓集成完成，也没有修改或回退其文件。
