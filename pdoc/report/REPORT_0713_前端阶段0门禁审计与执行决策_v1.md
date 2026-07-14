# REPORT_0713_前端阶段0门禁审计与执行决策_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：阶段 0 审计与执行决策
- 日期：2026-07-13
- 状态：本地门禁实现与内部验证完成；G-W、旧数据审计与外部门禁阻断生产
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0713_前端视觉落地与双工作台交互闭环_v1.md`
- 上位边界：`pdoc/plan/PLAN_0706_云端MVP后台构建与课时训练闭环_v1.md`
- 代码约束：`pdoc/rule/RULE_前后端代码规范_v1.md`
- 实施验收：`pdoc/report/REPORT_0713_前端视觉落地与双工作台交互闭环验收_v1.md`
- 产品约束冲突：`pdoc/report/REPORT_CONFLICT_0713_五词首课与错词回流间隔约束冲突_v1.md`
- 历史数据冲突：`pdoc/report/REPORT_CONFLICT_0713_旧版题型快照与新交互契约冲突_v1.md`

## 2. 严谨目标

本轮目标不是把两个占位页替换成静态视觉稿，而是在不突破第一版范围的前提下，完成可恢复、可授权、可测试的管理端与学习端闭环。

完成必须同时满足：

1. 浏览器不持有静态管理员令牌，管理端真实 API 只接受可验证的管理员身份。
2. 学习者请求由服务端 session 绑定 learner 和 course，不能通过猜测 ID 访问其他资源。
3. 六类 lesson task 使用共享判别联合，前端不读取 `unknown` 后猜 prompt。
4. 同一 source 可以创建递增 draft version；published version 和已有 task snapshot 保持不可变。
5. build 只生成 draft exercise item；批准、禁用和覆盖率全部由服务端状态决定。
6. 错词在同一 lesson 内隔 5 至 8 道题回流，最后一题答错不能利用 80% 比例跳过回流。
7. 失败、刷新、重复提交和重复完成均有稳定、可恢复且幂等的行为。
8. 本地真实栈测试每次使用全新 D1 状态，不复用旧服务，也不可能连接生产 D1。
9. 类型、lint、单元、组件、API、真实 D1、E2E、构建与 Cloudflare 检查均有真实执行证据。
10. 远端 Access、preview 和目标儿童观察未完成时，报告必须保持阻断，不能用本地通过替代。

## 3. 当前基线与已证实缺口

### 3.1 当前基线

阶段 0 编码前已执行：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

结果：类型检查、lint、4 个测试文件共 17 项测试、构建和 1 个浏览器 smoke 均能通过。E2E 在受限沙箱中第一次因 Wrangler 全局注册目录不可写而无法启动；获准使用本机 Wrangler 目录后，真实浏览器用例通过。

这组结果只证明原有占位基线可运行，不证明新计划门禁已经满足。

### 3.2 安全缺口

- `/api/app/*` 当前没有 learner session；裸 `courseId`、`sessionId`、`taskId` 即可访问写接口。
- `submitAnswer` 在归属校验之前读取幂等结果，未来若只在后面补权限仍可能泄露答案和状态。
- 完成课时后仍可提交剩余 pending task，继续修改 word state 和 review log。
- 管理端只支持 `x-admin-token`，该令牌不能交给浏览器；`/admin` 静态入口尚无已验证的 Cloudflare Access 保护。
- 当前错误大多退化为 HTTP 409 和原始 message，前端无法按稳定机器码恢复。

### 3.3 内容与版本缺口

- 每次导入都创建新 source，`versionNo` 固定为 1。
- build 直接生成 approved exercise item，绕过人工审阅。
- 重复 build 会删除全部 exercise item，可能抹掉人工编辑和审核状态。
- coverage 只检查 word 和 stage，没有同时校验 taskType、prompt schema 和 approved 状态。
- 版本列表、详情、coverage 读取、exercise 编辑/批准/禁用 API 均不存在。

### 3.4 Task 与回流缺口

- `LessonTaskView.stage`、`taskType` 是 `string`，`prompt` 是 `unknown`。
- 六类任务共用 `{ word, meaning }` 答案结构；S0、S4、S5 无法表达计划中的评分语义。
- S2 干扰项是字符串后缀，S4 词块按正确顺序生成。
- 回流任务只追加到队尾；首题答错可能隔 9 题，末题答错隔 0 题。
- 服务端不限制只能回答当前任务，调用者可以绕过回流间隔。
- 初始 5 题全部提交且最后一题答错后，当前比例为 `5 / 6 = 83.3%`，现有 complete 逻辑会直接结课。

### 3.5 测试与构建缺口

- Vitest 只有 Node project，没有 Vue 组件环境。
- ESLint 没有实际解析 Vue SFC。
- Playwright 允许复用 5173 旧服务，只有一个标题 smoke。
- 默认 Wrangler 配置绑定生产 D1 名称，`.wrangler/state` 也可能保留旧本地数据。
- 当前构建会加载 `.dev.vars`，并在 `dist/eng_learn` 生成同名文件；整个 dist 目录不能直接当作安全发布工件。

## 4. 已冻结的实施决策

### 4.1 管理员身份

- 采用 Cloudflare Access 作为生产管理员身份来源。
- Access 必须同时覆盖 `/admin*` 和 `/api/admin/*`。
- Worker 必须验证 JWT 签名、issuer、audience 和 expiry，不信任任意同名 header。
- `ADMIN_API_TOKEN` 只保留给受控的 service-to-service 或运维调用，不进入浏览器 bundle、storage 或普通 Cookie。
- 本地真实栈使用独立测试 Worker 入口注入测试管理员身份；生产入口不包含测试绕过。
- 在自定义域名和 Access 应用未验证前，生产 G-A 保持阻断。

### 4.2 Learner session 与学习码

- 学习码保持当前 10 位大写字符契约，排除易混淆字符。
- by-code 成功后创建高熵 opaque session；浏览器只持有 HttpOnly、SameSite Cookie，HTTPS 环境必须 Secure。
- D1 只保存 session token hash，不保存 raw token。
- session 绝对有效期为 30 天，允许同一 learner 多设备并行会话。
- logout 撤销当前 session；学习码轮换时撤销该 learner 的全部 session。
- 新学习码只保存 hash；旧明文学习码在首次成功兑换时惰性迁移，不做破坏性表重建。
- app 写请求校验精确 Origin；资源校验顺序为 session、course、lesson、task，再读取幂等结果。

### 4.3 六类任务提交语义

| Task type | Prompt | 提交 | 服务端评分 |
| --- | --- | --- | --- |
| `recognize_meaning` | 单词、释义、例句 | `known` / `learning` | 2 / 0 |
| `recall_word` | 释义 | 字符串 | 规范化精确匹配，2 / 0 |
| `multiple_choice` | 释义、真实词选项 | 选项值 | 规范化精确匹配，2 / 0 |
| `fill_blank` | 缺词句子 | 字符串 | 规范化精确匹配，2 / 0 |
| `sentence_build` | 带稳定 ID 的乱序词块 | 有序 piece ID 数组 | 与服务端顺序一致，2 / 0 |
| `sentence_output` | 中文含义和短指令 | 先提交草稿查看参考，再提交 `selfScore` 0–3 | 使用用户自评 |

通用要求：

- 未提交 task 响应不含正确答案。
- S5 的参考答案只在用户提交草稿后返回，预览不修改 word state 或 review log。
- 最终 answer feedback 才携带该 learner 本题的正确答案和评分结果。
- 前端不提交 stage、nextDueLessonNo 或自己计算的业务结果。

### 4.4 Source/version 与审核

- 导入必须显式选择 `new_source` 或 `next_version`，禁止按 sourceName 猜测归属。
- 同一 source 同时最多存在一个 draft；下一版本号由 repository 在服务端确定。
- build 只补齐不存在的 draft item；重复 build 不删除或覆盖人工编辑记录。
- 编辑 approved/disabled item 后回到 draft；disabled 不能直接恢复 approved，必须再次批准。
- published version 的 build、edit、approve、disable 全部拒绝。
- coverage 必须同时校验 word、stage、taskType、prompt/answer schema 和 approved。
- 发布资格在服务端重新计算；前端 coverage 只用于展示。

### 4.5 回流与结课

- lesson task 增加 `primary`、`bridge`、`reflux` 角色和 reflux 来源。
- 回流间隔由服务端选择并持久化，只能是 5 至 8。
- 后续任务不足时，从当前 lesson 已激活词的 approved snapshot 生成 bridge；不使用未来组、不跨 lesson、不由前端造题。
- bridge 和 reflux 答题写审计日志，但不重复调用 StageEngine 推进 mastery。
- 服务端只允许回答当前第一个 pending task。
- 80% 比例只计算 primary task；所有 required bridge/reflux 必须完成。
- complete 原子地把允许跳过的剩余 primary task 标为 skipped，并且 session/course 只推进一次。
- reflux 再次答错会产生新的强制回流义务。

### 4.6 CSV 导入

- 编码：UTF-8，可含 BOM；发现替换字符时拒绝。
- 表头：`word,meaning,exampleSentence,partOfSpeech`。
- 格式：支持 RFC 4180 引号、逗号和字段内换行。
- 上限：256 KiB、500 个数据行。
- `word`、`meaning` 必填；`exampleSentence` 允许空，但会形成 S3/S4/S5 coverage 阻断。
- 前端预览只改善体验，服务端继续执行完整 schema、重复词和业务校验。

## 5. 独立实施任务与门禁

| 任务 | 主要范围 | 红测 | 关闭门禁 |
| --- | --- | --- | --- |
| F1 测试底座与双端壳 | Vue lint、组件测试、UI E2E、token、layout、router | SFC lint、组件 ARIA、旧服务拒绝、目标视口 | 阶段 1/2 基础 |
| B1 Source/version | content service/repository | v1→v2、单 draft、published 拒绝 | G-V 一部分 |
| B2 审核与 coverage | draft/edit/approve/disable/query | build 后阻断、批准后发布、重复 build 保留编辑 | G-V |
| B3 Learner session | session service/repository/migration | 伪造、过期、撤销、越权、轮换 | G-L |
| B4 Task schema | shared Zod、snapshot parse、反馈 DTO | 六类合法/非法组合、答案不泄露 | G-S/G-T |
| B5 回流状态机 | CourseRuntime、course repository、migration | 首/中/末答错、gap 5/8、5/6 反例 | G-W |
| B6 稳定错误与读取 | Worker routes/query service | field issues、404/401/409/500、刷新恢复 | G-E/G-R |
| F2 真实 walking skeleton | API client、admin/app 最薄 UI | admin→learner→S0 一次提交 | 阶段 3 |
| F3 完整双端闭环 | S0-S5、恢复、报告、管理流水线 | 计划第 12 节全部场景 | 阶段 4–7 |
| Q1 隔离真实栈 | 临时 D1、独占端口、sentinel | API 写入与 CLI 同库读回 | 本地 E2E |
| Q2 Preview/Access/真机 | 独立远端资源和外部观察 | fail-closed 身份、目标设备与儿童脚本 | G-P/生产 |

## 6. TDD 测试缝隙

测试只通过以下公共边界观察行为：

1. 纯业务规则：Service 公共方法。
2. 数据一致性：Repository 接口和全新本地 D1。
3. HTTP 契约：Worker API 请求/响应及 Cookie。
4. 前端行为：Vue 组件公开 props、事件和可访问 DOM。
5. 用户闭环：Playwright 浏览器与真实 Worker/D1。

禁止：

- 测试私有函数或内部调用次数。
- 通过前端重新计算后端期望值得出同一个断言。
- 用内存 repository 通过替代 D1 并发和唯一约束测试。
- 用 mocked UI E2E 宣称真实业务闭环完成。
- 用生产 D1 或旧 `.wrangler/state` 运行测试。

## 7. 每轮执行与验证顺序

每个纵向切片固定执行：

```text
确认进入门禁
-> 写一个失败行为测试
-> 运行并记录红测
-> 写最小实现
-> 运行定向测试
-> 运行 typecheck 与 lint
-> 运行受影响 API/组件/E2E
-> 复核 diff 与下一步风险
-> 才进入下一切片
```

最终本地门禁顺序：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
干净环境 wrangler types --check
pnpm cf:check
preview dry-run（配置存在后）
```

## 8. 停止与回滚

出现以下任一情况，停止对应切片：

- 任何浏览器 bundle、storage、trace、HAR 或失败产物含管理员 secret、Access JWT、session Cookie 或学习码。
- learner 可以读取或修改其他 course/session/task。
- renderer 仍需 `as` 猜测 prompt。
- published version 的任何写操作成功。
- 最后一题答错后可以在 reflux 完成前结课。
- 本地真实栈无法证明正在使用全新本地 D1。
- preview URL、Worker、环境或 D1 身份无法证明不是生产。

回滚遵循：

- migration 只 additive，不删除或重命名旧字段。
- 每个切片保持小范围，可独立回滚。
- 新版本修复内容，不原地修改 published version。
- 历史 course 和 lesson task snapshot 不跟随新版本变化。

## 9. 外部门禁

以下工作需要当前仓库以外的资源或人员，不能由本地代码自动宣称完成：

1. 提供并验证可用于 Cloudflare Access 的自定义域名。
2. 创建 Access application/policy，并取得 audience/team domain。
3. 创建独立 preview Worker 和 preview D1，配置受控测试身份。
4. 使用至少一台真实手机和一台真实平板完成 smoke。
5. 由 Solazhu 在监护人知情同意下安排目标年龄儿童观察。

本地实现完成后，如果上述任一门禁未关闭，最终状态只能是“本地实现与内部验证完成，生产发布阻断”。

## 10. 执行结果回写

用户在本报告形成后明确授权继续实施。当前本地结果如下：

- G-L、G-S、G-V、G-R、G-T 和 G-E 已完成实现并通过单元、组件、API、真实 D1 和浏览器验证。
- G-A 的 Worker JWT 校验与无静态 secret 本地门禁已完成；远端 Access application/policy 和自定义域名仍未验证。
- G-W 的单次可满足序列、结课阻断和队列持久化已验证，但固定 5 词首课的五词连续全错序列在既定约束下无解，保持生产阻断。
- G-P 未关闭；没有创建或访问远端 preview/生产 Worker、D1 或 Access 资源。
- 目标远端 D1 的旧版题型和 lesson snapshot 尚未完成只读审计，历史数据兼容保持阻断。

完整测试计数、阶段验收矩阵、失败运行说明、回滚边界和下一步决策见实施验收报告。
