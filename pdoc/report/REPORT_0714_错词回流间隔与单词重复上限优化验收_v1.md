# REPORT_0714_错词回流间隔与单词重复上限优化验收_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：实施验收报告
- 报告版本：v1
- 状态：本地实现与内部验收完成；生产发布 NO-GO
- 日期：2026-07-14
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0714_错词回流间隔与单词重复上限优化_v1.md`
- 验收范围：当前 checkout、内存 repository、真实 SQLite-D1 适配层、隔离本地 Worker/D1、Worker API、Vue 浏览器多视口
- 未执行：远端 D1、preview、部署、生产数据操作

## 2. 验收结论

`PLAN_0714` 的本地编码范围已经完成并通过内部验收：

1. v2 错答后首次同词再现使用 3 至 6 道实际完成题的间隔。
2. 每词每课 `primary + bridge + reflux` 总任务数不超过 3，任意 N 词课总任务数不超过 `3N`。
3. 五词全部持续答错时恰好生成并完成 15 题，每词出现 3 次；前两次错答各产生一个 scheduled obligation，第三次错答写入 `deferred_cap`，不产生第四题。
4. 一至三个冻结词进入 `deferred_capacity` short-pool 降级；本课有限结束，下一课到期，但不虚假承诺下一课能够完成同课回流。
5. `primary / bridge / reflux` 的错答统一进入排程；非 primary 不重复推进 mastery，只通过 StageEngine transition 收紧下一课到期。
6. session 策略版本、answer disposition、答案、词状态与任务变更均已持久化；重复提交和并发提交返回首次 winner。
7. v1 started session 保持 v1 语义，v2 session 保持 v2 语义；`disabled` 禁止创建新 session，但允许恢复已有 v1/v2 session。
8. 达到 cap 或容量顺延的词稳定进入课后“还要再练”，前端不读取或显示内部 disposition。
9. 损坏队列在答案提交或结课前返回稳定 `queue_invariant_violation`，服务层验证证明没有答案、日志、词状态、任务或课程进度部分写入。

本地 G-W 逻辑冲突可以关闭；生产仍为 NO-GO。原因不是本地算法未通过，而是目标 D1 的 started v1 审计、远端 migration、隔离 preview 和发布前外部门禁未获授权且尚未执行。

## 3. 实施结果

### 3.1 全局队列策略

- 新增纯策略模块 `server/services/LessonQueuePolicy.ts`。
- 策略输入只使用 session 的冻结 primary word 集合、持久化 task、review log、disposition 和 suspended word 集合。
- `isQueueFeasible` 使用区间匹配判断是否存在合法排程。
- `buildSchedule` 使用独立的最晚槽构造器生成队列。
- 测试使用第三套穷举基准交叉验证 oracle 与构造器，不以生产实现自证。
- completed/skipped 前缀不可重排；skipped 占 cap，但不计实际间隔。
- scheduled source 的第一次同词再现必须是唯一 `refluxSourceTaskId` child。

### 3.2 策略版本与原子持久化

- 新增 additive migration：`migrations/0009_add_lesson_queue_policy_v2.sql`。
- `lesson_sessions.queue_policy_version` 区分 `v1_5_8_unbounded` 与 `v2_3_6_cap3`；历史行默认回填 v1。
- `review_logs.queue_disposition` 只允许 `scheduled / deferred_cap / deferred_capacity`，并按 v1/v2、通过/未通过答案建立约束。
- D1 与内存 repository 都使用 current pending task、唯一 review log、唯一 source child 和预期策略版本作为 winner 守卫。
- D1 的 session、tasks、review logs 快照使用单次 `db.batch` 读取，降低跨调用视图漂移。
- disposition 与 answer、word-state transition、task reorder/insert 同批提交。

### 3.3 Runtime 与报告

- 新 session 的策略由显式 `queueWriteMode` 决定；缺失或非法环境值解析为 `disabled`。
- `CourseRuntime` 工厂要求调用点显式传入 write mode，避免静默回退到旧策略。
- v2 所有可评分 role 的错答统一调用全局策略；v1 继续使用原 5 至 8 逻辑恢复历史 session。
- `CourseQueryService` 的正确率仍只按 primary 计算；任何 `deferred_cap / deferred_capacity` 词都会进入“需继续练习”。
- v2 完成报告若缺少任一已完成 task 的审计日志，或未通过日志缺 disposition，则拒绝生成报告。
- learner start、answer、恢复和 report DTO 不暴露 queue policy 或 disposition。

### 3.4 浏览器与真实栈

- 隔离本地 Worker + D1 的五词全错流程验证 15 题、每词 3 次、3 至 6 道间隔、刷新恢复、结课和报告。
- 生产 Vue 页面直接连接同一临时 Worker + D1 完成五词全错 15 题，不使用 mock 调度结果。
- 多视口 Vue fixture 不实现调度算法，只提供固定的 15 题服务端序列，验证不同视口下前端持续读取权威 next task。
- 真实页面与多视口 fixture 均在第 7 题后刷新，当前词保持不变；第 15 题后出现完成按钮，报告显示 5 个“还要再练”词。
- 320、375、768、1280 四个 learner 视口均通过该路径。

## 4. 验证证据

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| 全量单元测试 | 通过 | 51 files / 458 tests |
| 全量组件测试 | 通过 | 17 files / 181 tests |
| 全仓 lint | 通过 | `pnpm lint` |
| 全量类型检查 | 通过 | `pnpm typecheck` |
| 隔离发布构建 | 通过 | `pnpm build`；Worker、client 与 secret artifact scan 通过 |
| 真实 SQLite-D1 定向测试 | 通过 | D1 repository 45 tests；包含 v2 重启恢复与五词 cap |
| 完整 UI 多视口 | 通过 | 39 Playwright tests |
| 隔离 Worker + D1 整栈 | 通过 | 4 Playwright stack tests；9 个 migration 在临时本地 D1 成功应用 |
| 纯策略交叉验证 | 通过 | oracle、独立 builder、测试穷举基准一致 |
| 差异完整性 | 通过 | `git diff --check` 通过；双轴独立复核无未关闭 P1/P2；最终 status 仅包含本计划范围内文件 |

首次在受限沙箱内启动 Chromium 时，浏览器在 macOS Mach port 注册阶段被系统拒绝，测试逻辑未开始。允许本机 Chromium 后，目标浏览器测试和完整 UI 套件均通过；该启动失败不属于产品失败。

## 5. 重点场景验收

| 场景 | 结果 |
| --- | --- |
| gap 2/3/4/5/6/7 | 仅 3 至 6 合法 |
| 五词全错三轮 | 15 题、每词 3 次、10 scheduled、5 deferred_cap、0 deferred_capacity |
| N=10、N=20 压力课 | 每词不超过 3，总数不超过 `3N` |
| N=1/2/3 连续两课 | 每课有限结束，使用 capacity defer，不引入未来词或伪题 |
| bridge/reflux 错答 | 统一排程或 defer，不重复更新 mastery 计数 |
| 第三次仍错 | 写日志、无第四题、下一课到期、本课可结束 |
| required 未完成 | 结课返回 `lesson_incomplete` |
| 重复/并发提交 | 一条 log、一个 disposition、一个 child，loser 返回 winner |
| Runtime/repository 重建 | task 顺序、状态、role、source 和 disposition 保持一致 |
| 腐坏快照 | `queue_invariant_violation`，业务写入为零 |
| 报告 | primary 正确率保持原口径；defer 词进入“还要再练” |
| 浏览器刷新 | 刷新前后 current task 一致，15 题后可完成 |
| v1/v2/disabled | v1/v2 started 可恢复；disabled 不创建新 session |

## 6. 生产阻断

以下门禁仍未关闭，因此不得将本报告解释为生产发布授权：

1. 未对目标远端 D1 只读统计 started v1 session；结果不为 0 时不得启用 v2 写入。
2. 未在目标 preview/生产 D1 执行 migration preflight 或 migration 0009。
3. 未在隔离 preview Worker/D1 上完成真实恢复、并发、响应丢失与回滚演练。
4. 未验证 Cloudflare Access、自定义域名、真实手机/平板和 `PLAN_0713` 的外部观察门禁。
5. 未部署，未修改任何远端变量，未执行生产 smoke。

## 7. 发布与回退顺序

若后续获得远端授权，必须按以下顺序执行：

1. 只读统计目标 D1 的 started v1 session，并记录精确结果。
2. 在隔离 preview 先应用 additive migration 0009。
3. 发布可同时读取 v1/v2 且默认 `queueWriteMode = disabled` 的兼容 Worker。
4. preview 全量通过后，再显式切换 `queueWriteMode = v2` 创建新 session。
5. 观察期内发现异常时，先切回 `disabled`，再回退到双读兼容 Worker。

不得 down-migrate D1，不得删除 v2 task，不得改写历史 review log，也不得回退到只理解 v1 的旧 Worker。

## 8. 最终决策

- 本地实现：通过。
- 内存、SQLite-D1、Worker API 和浏览器语义一致性：通过。
- 原五词数学死锁与无限重复问题：本地关闭。
- 生产发布：NO-GO，等待第 6 节外部门禁逐项关闭并单独授权。
