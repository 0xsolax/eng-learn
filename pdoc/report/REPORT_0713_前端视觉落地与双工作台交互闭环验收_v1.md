# REPORT_0713：前端视觉落地与双工作台交互闭环验收

## 1. 文档信息

- 项目：eng-learn
- 文档类型：实施验收与发布决策报告
- 报告版本：v1
- 执行窗口：2026-07-13 至 2026-07-14
- 状态：本地实现与内部验证完成；生产发布阻断
- 发布决策：NO-GO
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行计划：`pdoc/plan/PLAN_0713_前端视觉落地与双工作台交互闭环_v1.md`
- 阶段 0 决策：`pdoc/report/REPORT_0713_前端阶段0门禁审计与执行决策_v1.md`
- 产品约束冲突：`pdoc/report/REPORT_CONFLICT_0713_五词首课与错词回流间隔约束冲突_v1.md`
- 历史数据冲突：`pdoc/report/REPORT_CONFLICT_0713_旧版题型快照与新交互契约冲突_v1.md`

## 2. 验收结论

管理端与学习端的本地实现、共享契约、安全边界、错误恢复、真实 Worker/D1 闭环、响应式和自动化无障碍检查已经完成。本地最终门禁全部通过：573 个 Vitest 用例、35 个 UI Playwright 用例和 4 个真实 Worker/D1 Playwright 用例均通过，构建、Cloudflare 隔离检查以及 secret/宿主路径工件扫描通过。

该结果不能解释为“所有问题已解决”，也不能授权生产发布。当前仍有两个生产阻断：

1. 首课固定 5 个词时，“任意错词第一次再次出现前隔 5 至 8 道题、同课完成、不借未来词、不增加中性题”对五词连续答错没有合法调度。
2. 目标远端 D1 尚未完成旧版题型、旧 lesson snapshot 和未关联 review log 的只读计数审计，无法证明历史课程都能进入新交互契约。

此外，远端 Cloudflare Access、独立 preview Worker/D1、远端 migration preflight、真实手机和平板、视觉基线确认和目标儿童观察均未完成。以上任一门禁未关闭前，生产状态保持 NO-GO。

## 3. 已交付范围

### 3.1 身份与会话安全

- 管理 API 支持校验 Cloudflare Access JWT；保留受控 service-to-service token 兼容路径，但浏览器不持有静态管理员令牌。
- 学习码兑换建立服务端 learner session；浏览器只使用 HttpOnly Cookie，D1 保存 token hash，不保存 raw token。
- app 请求校验 session、learner、course、lesson 和 task 归属，写请求校验 Origin。
- 学习码轮换撤销已有 learner session；并发轮换只有一个成功者。
- answer、complete 和管理写操作具有稳定幂等语义；响应丢失后使用相同 operation token 重放，不重复写业务状态。
- API 返回稳定机器码；前端不解析服务端英文 message 作为业务分支。

### 3.2 内容版本与审核闭环

- 同一 source 支持递增 draft version，并由 repository 约束单 draft。
- build 生成 draft exercise item；管理端支持查看、编辑、批准、禁用、coverage 和发布。
- published version 的 build、edit、approve、disable 均 fail-closed；并发写通过 revision/CAS 返回稳定 conflict，不覆盖较新数据。
- coverage 同时检查 word、stage、taskType、prompt/answer schema、批准状态和内容安全。
- 管理端完成 CSV 预览、导入、构建、审阅、发布、创建课程和状态恢复界面。

### 3.3 学习闭环

- 学习端完成学习码、课程首页、开始/继续课时、S0 至 S5 六类 renderer、反馈、断网重试、刷新恢复、完成和课后报告。
- 任务 DTO 使用共享判别联合和运行时 Zod 校验；未提交 task 不返回权威答案。
- S5 使用“草稿预览参考句，再提交自评”的两段式协议；预览不修改 word state 或 review log。
- `task_not_current`、`conflict` 和 S5 preview authority drift 只重新读取权威状态，不盲目重放 mutation。
- 网络异常、明确 5xx 和无法确认的响应保留同一 payload 重试；确定性 4xx、会话错误和内容不兼容不会循环重试。
- LessonReport 对网络/503/非法响应、报告不存在、课时关闭和会话失效分别采用可验证的恢复路径。
- 完成、重载和退出操作具有显式焦点优先级；确定性完成错误移除主操作后，焦点回退到仍可用的退出动作。

### 3.4 D1 一致性与队列写入

- 完成或放弃的 session 再次 preview/answer 稳定返回 `lesson_not_active`，不写 answer、word state、review log 或队列。
- D1 answer 事务只写实际变化的 task；500-task 正确答案路径从 1000 次 task update 降为 1 次 update。
- 回流插入、reorder、并发失败者和幂等重放都有真实 SQLite/D1 写入计数测试。
- 队列构造仍需在内存中读取和比较当前 lesson tasks；错误路径排序最坏仍为 O(n log n)。本轮消除了 O(queue) D1 写放大，但没有把整个调度计算改造成增量索引。

### 3.5 视觉、响应式与无障碍

- 建立共享色彩、字号、间距、圆角、阴影、焦点和动效 token；管理端与学习端共享视觉语言、保留不同信息密度。
- 学习端覆盖 320、375、768、1280 视口；管理端覆盖 375、768、1024、1280、1440 视口。
- 高频触控尺寸、键盘路径、focus-visible、forced-colors、reduced-motion、横向溢出和六类题型可操作性进入浏览器测试。
- 320px 长中文/长英文、200% 等效重排和 Chromium achromatopsia 灰度模式进入浏览器测试；等效重排不冒充浏览器 UI 的真实 200% 缩放。
- Axe 自动检查未发现 serious 或 critical 级问题。
- 原黄色焦点环与白色背景的对比度只有 1.603:1；红测后改用更深品牌色，自动门禁要求焦点指示达到至少 3:1。

## 4. TDD 与专项审计证据

| 风险 | 红测证据 | 最小修复与绿测 |
| --- | --- | --- |
| 内容并发覆盖 | 10 个并发 edit/approve/disable 请求退化为 500 | revision/CAS 后稳定返回 `conflict` 或 `source_version_immutable`，零静默覆盖 |
| 已关闭课时仍可写 | completed/abandoned session 的 D1 answer/preview 进入非稳定错误 | 统一返回 `lesson_not_active`，相关写表增量为 0 |
| 队列写放大 | 500-task 正确答案执行 1000 次 task update | repository 只接收 task mutation delta，降为 1 次 update |
| S5 隐形答案泄漏 | 零宽字符、软连字符、全角和 ligature 可绕过目标词检查 | safety-only NFKC 与 Default_Ignorable 清理；导入、构建、admin/app 读取全部 fail-closed |
| 管理端真实 UI 被 API helper 绕过 | 真实栈只用 API 预置内容，无法发现导入、构建、审批、发布和建课 wiring 错误 | 浏览器直接完成 CSV 导入、构建、30 项审批、发布只读、建课、学习码和 S0；真实栈 4/4 |
| 发布工件泄漏构建机路径 | Worker region 注释和生成 Wrangler 配置包含 checkout/临时目录绝对路径 | 构建后净化生成元数据，scanner 新增 fail-closed 门禁；不同 checkout 的 Worker、配置和 client hash 完全一致 |
| 净化器改写运行语义 | 第一版整行正则会删除模板字符串中的同形 `//#region` 文本 | TypeScript parser 只删除真实 line-comment range；字符串、正则及模板 head/middle/tail 保持运行值，2/2 回归通过 |
| 学习端盲重试 | authority conflict 后可能再次提交 mutation | 只重新读取权威 lesson；网络和未知结果才允许同 payload 重试 |
| 结课焦点丢失 | 确定性 403 后 activeElement 落到 body | 主操作存在时优先 complete/reload；移除后回退 exit，两个互补焦点测试通过 |
| 焦点优先级回归 | 第一版回退选择器按 DOM 顺序错误优先 exit | 拆成显式两级查询，LessonRunner 52/52 通过并经独立终审复核 |

最终独立代码审计曾发现并阻断“真实管理端 UI 覆盖盲区”和“发布净化器可能改写模板字符串”两个 P2；两项均完成 RED→GREEN 并再次独立复核。除已记录的五词回流 P1 产品约束冲突外，最终候选没有遗留的可复现 P0、P1 或 P2。

## 5. 最终自动化验证

最终结果均基于最后一次代码冻结后的独占执行。候选 diff（排除不属于本轮的 `pdoc/.DS_Store`）应用到基于 `3385386` 的全新 detached worktree 后统一验证，避免复用主工作区的依赖、服务或测试产物。

| 命令 | 结果 | 关键证据 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 通过 | lockfile 无变更；395 个条目通过 supply-chain policy；310 个包安装完成 |
| `pnpm typecheck` | 通过 | app、component、server 三套 TypeScript 配置均无错误 |
| `pnpm lint` | 通过 | ESLint 覆盖 TypeScript、JavaScript 和 Vue SFC |
| `pnpm test` | 通过 | unit 48 files / 392 tests；component 17 files / 181 tests；合计 573/573 |
| `pnpm test:e2e:ui` | 通过 | 35/35；学习端、管理端、controls、renderers、等效重排、长文案、灰度和无障碍检查 |
| `pnpm test:e2e:stack` | 通过 | 4/4；全新临时 D1 应用 8 个 migration；浏览器管理端全生命周期、真实 Worker/Vue、隔离/回流/恢复/幂等闭环 |
| `pnpm test:e2e` | 通过 | 在同一冻结候选上按 UI 35/35 → stack 4/4 聚合执行，整体 exit 0 |
| `pnpm build` | 通过 | isolated release build；Worker 357.14 kB / gzip 72.26 kB；最大 client index 96.65 kB / gzip 37.59 kB |
| `pnpm scan:artifacts` | 通过 | 发布工件 secret 与宿主绝对路径 scan 无命中 |
| `pnpm cf:types:check` | 通过 | `worker-configuration.d.ts` 最新；不加载本地 secret 文件 |
| `pnpm cf:check` | 通过 | Worker startup check 通过；Wrangler 仅提示该命令仍为 alpha |
| `git diff --check` | 通过 | 无空白错误 |

跨 checkout 可复现性复核：token-aware 最终候选在主工作区与 detached worktree 的 Worker SHA-256 均为 `536295906c348b0889877123f12b08e4948f1b677c8f0694477568dbdcb3da97`，生成 Wrangler 配置均为 `753ca8651de673c95a3783b6461c416dca8620729b58de59f111ec8cd2c0fc3b`，client index 均为 `79f7a92637a80d01610073c944cf65d90cefbb4827c50022b8d5379fec8e239f`。

依赖复核：`@lucide/vue` 为 ISC，`jose` 和 `papaparse` 为 MIT；新增测试依赖为 MIT 或 MPL-2.0，未发现 GPL 类许可证。没有引入完整 UI 组件框架。

### 5.1 失败运行的处理

验收没有丢弃失败证据：

1. 一次沙箱内 Playwright 运行因 macOS 拒绝 Chromium Mach port 注册而 25/25 无法启动；该失败属于执行环境，随后按权限规则在沙箱外重跑。
2. 第一次沙箱外运行与最后一个焦点补丁重叠，出现 3 个旧焦点行为失败和 1 个超时；该运行不具备冻结 checkout 前提，因此作废。
3. 阶段 8 扩展前的代码冻结独占重跑，UI 25/25 和真实栈 4/4 全部通过。
4. 扩展阶段 8 后首轮 UI 为 32/35；3 个失败来自新增 fixture 使旧 `role=status` 定位变成多元素歧义。改用专用测试定位后冻结版 UI 为 35/35。
5. 真实管理端浏览器闭环前两次复跑分别暴露发布页和导入页的多 `role=status` 断言歧义；收紧到权威状态文本/标记后真实栈 4/4。
6. 发布包复核发现本机绝对路径；scanner 红测先 2/9 失败。第一版正则净化虽使工件绿色，但独立终审证明它会改写模板字符串，因而作废；TypeScript parser 回归红测 1/2 失败后改为真实 comment range 删除，最终聚焦 11/11。

测试生成的 `.last-run.json`、错误上下文和 `worker-startup.cpuprofile` 已清理，不作为交付文件保留。

## 6. 分阶段验收矩阵

| 阶段 | 本地状态 | 未关闭边界 |
| --- | --- | --- |
| 阶段 0 契约与门禁 | 部分通过 | G-W 产品约束无解；G-A 远端 Access、旧数据审计未完成 |
| 阶段 1 测试底座与设计基础 | 通过 | 无本地阻断 |
| 阶段 2 双端壳、路由、API client | 通过 | 生产管理员身份仍依赖远端 Access 配置 |
| 阶段 3 最薄真实闭环 | 本地通过 | 只验证隔离本地 Worker/D1，不替代 preview |
| 阶段 4 学习码与课程首页 | 本地通过 | 真实设备观察未完成 |
| 阶段 5 S0-S5 | 新契约通过 | 旧版持久化题型需远端只读审计 |
| 阶段 6 恢复、回流与报告 | 部分通过 | 单次与已有可满足序列通过；五词连续全错的 5-8 间隔无解 |
| 阶段 7 管理端内容闭环 | 新内容通过 | 历史 course/lesson 兼容结果未知 |
| 阶段 8 响应式、无障碍、视觉 | 自动化部分通过 | 浏览器 UI 真实 200% 缩放、软键盘/安全区、真实手机/平板、用户视觉基线和目标儿童观察未完成 |
| 阶段 9 发布验收 | 本地门禁通过 | preview、远端 migration、生产 smoke 和真实回滚演练未执行 |

## 7. 生产阻断与待决策事项

### 7.1 五词回流约束

必须由 Solazhu 明确选择一个分支：

- A：重设全局回流调度；lesson snapshot 至少冻结 6 个安全词槽，并同时约束全部 pending obligation。6 词只是必要条件之一，不能只改 `GROUP_SIZE`。
- B：新增不绑定 vocabulary word 的中性 filler task 契约。
- C：修订“同词第一次再次出现前必须隔 5 至 8 题”的产品语义。

条件性推荐为 A＞B＞C：A 保留原教学语义且不新增题型，但必须一并解决 due-only 1 至 5 词课、短词库/尾组、混合 gap、bridge/reflux 答错语义、同时 pending 上限、持续全错终止方式和历史课程兼容。选择前不得把 G-W 标记为通过；选择后必须先修订上位计划、schema 和状态序列测试，再继续实现。

### 7.2 旧版题型与快照

必须在明确目标 D1、明确 `--env` 或独立配置、只读且输出脱敏计数的条件下执行冲突报告中的查询，然后选择：

- A：目标 D1 没有旧版行，移除该阻断。
- B：接受持久化不变、运行时按新交互适配，并在 preview 逐条验证命中课程。
- C：另立 `legacy_v1` 契约、评分器和 renderer 计划。

本轮没有远端目标身份和 preview 配置，因此没有运行这些查询，也没有接触生产 D1。

### 7.3 外部门禁

1. 配置并验证自定义域名、Cloudflare Access application/policy、audience 和 team domain。
2. 创建独立 preview Worker/D1，证明名称、URL、环境标识和 D1 ID 均不命中生产。
3. 在远端 clone/preview 先执行 8 个 additive migration 和旧数据 preflight，再进行 smoke。
4. 使用浏览器 UI 完成人工真实 200% 缩放，并用至少一台真实手机和一台真实平板验证 Cookie、网络、软键盘、焦点和安全区。
5. Solazhu 完成首轮视觉确认后建立截图基线。
6. 在监护人知情同意下完成目标年龄儿童观察。
7. 以上通过后才允许 preview smoke、生产审批、生产 smoke 和回滚演练。

## 8. 发布与回滚边界

- 本轮没有部署 Worker、没有执行远端 migration、没有创建 Access 策略、没有写 preview 或生产 D1。
- migration 0003 至 0008 均为 additive；Worker 回滚不会自动撤销数据库结构，远端执行前必须先在 clone/preview 演练。
- published content 和已有 lesson task snapshot 不原地修改；内容修复继续使用新 version。
- 若 preview 发现身份、历史题型或队列错误，回滚 Worker 到上一已验证 version，保留 additive schema，并停止生产发布。
- 当前没有可验证的上一生产 Worker version 记录，因此报告不能宣称生产回滚步骤已实演。

## 9. Checkout 完整性说明

执行过程中检测到 `HEAD`、`main` 和本地 `origin/main` 引用由外部状态推进到 `3385386`（提交信息：`实施阶段0前置验收与独立任务拆分`，提交时间 2026-07-14 00:13:22 +0800）。本轮根代理和分配的子任务没有执行 stage、commit 或 push，也没有回退该外部变更。

`pdoc/.DS_Store` 已被该 checkout 跟踪且处于修改状态；它不属于本轮实现范围，已原样保留。当前后续深审修复、测试和报告仍为未暂存工作区变更，未替用户创建提交。

## 10. 下一步顺序

1. Solazhu 先确认五词回流冲突分支；当前条件性推荐 A，但必须接受全局调度与历史兼容的完整边界，不能只改分组常量。
2. 明确目标 D1 和 preview 身份，执行旧数据只读审计并选择历史兼容分支。
3. 修订上位计划后关闭 G-W；重新运行状态序列、D1、API 和浏览器闭环。
4. 建立并验证 Access 与隔离 preview；完成 migration preflight。
5. 完成真实设备、视觉确认和目标儿童观察。
6. 所有门禁通过后，再单独授权 preview 和生产发布。
