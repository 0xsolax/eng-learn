# RULE_前后端代码规范_v1

## 1. 文档信息

- 项目：eng-learn
- 规则版本：v1
- 创建日期：2026-07-06
- 更新日期：2026-07-14
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 适用范围：Vue 3 + TypeScript 前端、Cloudflare Worker 后端、D1 数据访问、共享类型、测试与交付。

## 2. 规则目标

本规范用于约束第一版云端 MVP 的前后端编码方式，防止后续开发出现以下问题：

- 页面直接拼接口数据，导致 API 契约漂移。
- 路由层直接写业务逻辑，导致服务边界失控。
- 前端、后端、数据库各自定义一套字段名，导致维护成本上升。
- 调度逻辑散落在多个文件，导致课时制规则被破坏。
- 草稿内容、发布内容、运行态课程互相污染。
- 测试只覆盖 happy path，无法防住停学、重复提交、未完成退出等关键场景。

本项目第一版代码必须服务于一个目标：稳定验证“后台构建练习项目 + 客户端课时制训练闭环”。任何与此目标无关的抽象、配置化、平台化能力都不进入第一版。

## 3. 总体原则

### 3.1 单一事实来源

- 领域类型只允许在共享类型层定义一次。
- API 请求和响应必须使用共享 schema 校验。
- 阶段、题型、状态、评分枚举必须集中定义。
- 跨课阶段与 `nextDueLessonNo` 只允许由 `StageEngine` 提供；课内错词回流间隔、任务次数预算和 obligation 只允许由唯一队列策略提供。
- 前端不得自行推导阶段升级、降级或下次复习课时。

### 3.2 分层边界

必须保持以下边界：

```text
Vue Page
-> Vue Feature Component
-> Pinia Store / Composable
-> API Client
-> Worker Route
-> Service
-> Repository
-> D1
```

禁止跨层访问：

- Vue 组件不得直接拼 Worker URL 和裸 fetch。
- Worker route 不得直接写复杂业务规则。
- Service 不得返回 D1 原始行给前端。
- Repository 不得包含业务判断。
- 数据库字段名不得直接泄漏成 UI 文案。

### 3.3 最小实现

- 不为未来多租户、支付、AI、R2、语音识别提前设计复杂抽象。
- 不引入未使用的框架、插件、状态管理层或代码生成工具。
- 一个规则只有一个调用点时，不提前抽成可配置策略。
- 如果一个功能可以用 50 行清晰代码完成，不写 200 行“可扩展框架”。

### 3.4 显式契约

- 每个 API 必须有请求 schema、响应 schema、错误码定义。
- 每个数据库状态字段必须有枚举约束和服务层校验。
- 每个任务类型必须声明 prompt 和 answer 的结构。
- 每个跨模块函数必须有清晰输入输出类型。

## 4. 推荐目录结构

第一版采用单仓单应用结构：

```text
/
  src/
    app/
      router/
      layouts/
      providers/
    pages/
      admin/
      app/
    features/
      admin-content/
      learner-course/
      lesson-runner/
      reports/
    components/
      ui/
      task-renderers/
    stores/
    api/
    types/
    utils/

  server/
    index.ts
    routes/
      admin/
      app/
    services/
      ContentBuilder.ts
      LessonScheduler.ts
      LessonQueuePolicy.ts
      TaskGenerator.ts
      AnswerEvaluator.ts
      StageEngine.ts
      ReportService.ts
    repositories/
    schemas/
    types/
    utils/

  shared/
    domain/
    schemas/
    api/
    constants/

  migrations/
  tests/
    unit/
    integration/
    e2e/

  pdoc/
    plan/
    rule/
```

目录职责：

- `shared/`：前后端共同使用的领域类型、API schema、常量。
- `src/pages/`：路由级页面，只组合 feature，不写业务规则。
- `src/features/`：业务功能模块，如后台内容构建、学习课程、课时运行。
- `src/components/ui/`：无业务语义的基础 UI。
- `src/components/task-renderers/`：按 task type 渲染题目，不决定答案如何更新状态。
- `server/routes/`：HTTP 入参解析、权限检查、调用 service、返回响应。
- `server/services/`：业务规则唯一落点。
- `server/repositories/`：D1 SQL 和数据映射唯一落点。
- `server/schemas/`：后端内部 schema；跨端 schema 放 `shared/schemas/`。

## 5. 命名规范

### 5.1 文件命名

- Vue 组件：`PascalCase.vue`，例如 `LessonTaskCard.vue`。
- TypeScript 普通文件：`camelCase.ts`，例如 `lessonApi.ts`。
- 后端 service：`PascalCase.ts`，例如 `LessonScheduler.ts`。
- repository：`camelCaseRepository.ts`，例如 `courseRepository.ts`。
- schema：`camelCase.schema.ts`，例如 `lesson.schema.ts`。
- 测试文件：`*.test.ts` 或 `*.spec.ts`。

### 5.2 领域命名

统一使用以下领域词：

- `source`：词库主记录。
- `sourceVersion`：词库版本。
- `word`：单词。
- `wordGroup`：按每 5 个词形成的入口组。
- `exercisePack`：某个词的一整套练习包。
- `exerciseItem`：一道可复用练习项目。
- `learner`：学习者。
- `course`：学习者绑定词库版本后的课程。
- `lessonSession`：一次课时会话。
- `lessonTask`：某次课里的任务快照。
- `reviewLog`：答题日志。
- `userWordState`：某课程下某词的掌握状态。

禁止混用：

- 不用 `user` 指代 learner。
- 不用 `day`、`date`、`reviewDate` 表达调度。
- 不用 `question` 替代 `exerciseItem` 或 `lessonTask`，除非只是 UI 文案。
- 不用 `wordList` 替代 `sourceVersion`。

## 6. TypeScript 规范

### 6.1 必须启用的约束

TypeScript 必须使用严格模式：

- `strict: true`
- `noImplicitAny: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noFallthroughCasesInSwitch: true`

禁止：

- 禁止使用隐式 `any`。
- 禁止用 `as any` 绕过类型。
- 禁止在业务代码使用 `unknown` 后不校验直接读取字段。
- 禁止在跨层接口中使用宽泛 `Record<string, unknown>` 代替明确 schema。

允许：

- 与第三方库边界交互时可使用 `unknown`，但必须立刻用 schema parse。
- 测试中可在局部使用类型辅助，但不得影响生产代码。

### 6.2 类型定义位置

- 领域枚举放 `shared/domain/`。
- API 请求响应类型放 `shared/api/`。
- Zod schema 或等价运行时校验放 `shared/schemas/`。
- 后端数据库行类型放 `server/types/`，不得直接导出给前端。
- 前端视图模型放具体 feature 目录，不放 shared。

## 7. API 规范

### 7.1 路由分区

必须按访问主体分区：

```text
/api/admin/*
/api/app/*
```

规则：

- `/api/admin/*` 只服务管理后台。
- `/api/app/*` 只服务学生客户端。
- 不允许新增模糊接口，如 `/api/common/save`、`/api/data/update`。
- 跨端复用逻辑放 service，不通过复用 HTTP 路由实现。

### 7.2 请求响应格式

统一响应结构：

```ts
type ApiSuccess<T> = {
  ok: true
  data: T
}

type ApiFailure = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}
```

规则：

- 前端必须先判断 `ok`。
- 后端不得返回裸数组或裸字符串作为正式 API 响应。
- 错误码必须稳定，不使用完整英文句子作为错误码。
- 用户可见错误文案由前端决定，后端返回机器可识别 code 和必要上下文。

### 7.3 API 校验

- 所有 POST、PATCH 请求必须校验 body。
- 所有 path param 必须校验格式。
- 所有 query param 必须校验并转换类型。
- 校验失败返回统一错误，不进入 service。

## 8. 后端代码规范

### 8.1 Route 层

Route 只做：

- 解析请求。
- 认证和权限检查。
- 调用 service。
- 返回统一响应。

Route 禁止：

- 禁止写 SQL。
- 禁止计算阶段升级、降级。
- 禁止拼 lesson task。
- 禁止直接修改多个表。
- 禁止吞掉 service 错误后返回成功。

### 8.2 Service 层

Service 是业务规则唯一落点。

核心服务职责：

- `ContentBuilder`：从词库版本生成练习包和练习项目。
- `LessonScheduler`：选择本课应出现的词和阶段。
- `LessonQueuePolicy`：唯一负责课内错词回流、全局可行性排程、每词次数预算和 obligation。
- `TaskGenerator`：把练习项目转为本课任务快照。
- `AnswerEvaluator`：处理答题提交、计数和日志。
- `StageEngine`：阶段升级、降级、跨课间隔、下一课到期和掌握度计算；不负责课内任务排程。
- `ReportService`：生成课程和课后报告。

规则：

- 一个 service 不得直接调用前端概念。
- 一个 service 可以调用 repository 和同层纯规则模块。
- service 返回领域对象或 DTO，不返回数据库原始行。
- 涉及多表写入的 service 必须考虑失败后的状态一致性。

### 8.3 Repository 层

Repository 只做：

- SQL 查询。
- SQL 参数绑定。
- D1 行到后端内部类型的映射。

Repository 禁止：

- 禁止判断一个词是否应该升级。
- 禁止判断是否可以解锁新组。
- 禁止构造前端展示文案。
- 禁止把未校验 JSON 字段直接返回给 service。

### 8.4 D1 与 SQL

规则：

- 所有 SQL 必须使用参数绑定。
- 禁止字符串拼接 SQL 条件。
- 关键查询必须有索引支撑。
- migration 文件只做可追踪 schema 变更。
- 第一版 migration 禁止删除表、删除字段、重命名字段。
- JSON 字段只能存题干、答案等结构化快照，不存不可控大文本或文件。

必须设置唯一约束或索引的方向：

- `words(source_version_id, order_index)`
- `word_groups(source_version_id, group_index)`
- `exercise_packs(source_version_id, word_id)`
- `exercise_items(source_version_id, word_id, stage, status)`
- `courses(learner_id, source_version_id)`
- `user_word_states(course_id, word_id)`
- `lesson_sessions(course_id, lesson_no, status)`
- `lesson_tasks(session_id, order_index)`
- `review_logs(course_id, word_id, lesson_no)`

## 9. 前端代码规范

### 9.1 页面职责

Page 只做：

- 路由参数读取。
- 页面布局。
- 调用 feature 组件。
- 处理页面级 loading、empty、error 状态。

Page 禁止：

- 禁止直接写复杂表单规则。
- 禁止直接决定任务生成和阶段更新。
- 禁止直接操作 localStorage 保存业务状态。
- 禁止直接拼 API URL。

### 9.2 Feature 组件职责

Feature 组件可以：

- 组合业务 UI。
- 调用 store 或 composable。
- 处理本功能的交互状态。

Feature 组件禁止：

- 禁止写跨功能共享业务规则。
- 禁止复制 API response 类型作为本地私有类型。
- 禁止直接修改全局 store 中不属于自己的状态。

### 9.3 基础 UI 组件

`components/ui` 中的组件必须无业务语义：

- 可以有 Button、Input、Dialog、Tabs、Table。
- 不得有 Word、Lesson、Course、Source 等领域概念。
- 不得调用 API。
- 不得读取 Pinia store。

### 9.4 任务渲染组件

每种题型一个 renderer：

- `MultipleChoiceTask.vue`
- `FillBlankTask.vue`
- `SentenceBuildTask.vue`
- `RecallTask.vue`
- `SentenceOutputTask.vue`

规则：

- renderer 只负责展示题目、收集答案、提交用户操作。
- renderer 不判断单词是否升级。
- renderer 不计算 `score` 的业务含义，只提交明确评分或答案。
- 新增 task type 必须新增 schema、renderer、测试和后台生成逻辑。

### 9.5 Pinia 和前端状态

Pinia 只保存客户端运行状态：

- 当前登录/学习码会话。
- 当前课程摘要。
- 当前 lesson session。
- 当前任务列表和页面进度。

Pinia 禁止保存：

- 权威课程进度。
- 权威单词状态。
- 权威答题日志。
- 可从服务端恢复的长期业务数据。

刷新页面后，前端必须能从 API 恢复当前课时状态。

## 10. 领域规则硬约束

### 10.1 课时制

调度只允许使用：

- `current_lesson_no`
- `next_due_lesson_no`
- `lesson_no`

禁止：

- 禁止使用自然日期决定复习是否到期。
- 禁止使用 `created_at`、`updated_at` 推进学习节奏。
- 禁止出现 `next_review_date` 作为调度字段。

日期只用于日志、排序和审计。

### 10.2 版本化

- 草稿版本可编辑。
- 发布版本不可原地修改。
- 已开始课程绑定发布版本。
- 课程运行中不得读取草稿内容。
- 已生成 lesson task 必须保存快照。

### 10.3 状态机

以下行为只能通过 service 完成：

- source version publish。
- course create。
- lesson start。
- answer submit。
- lesson complete。
- word stage upgrade。
- word stage downgrade。
- next due lesson calculate。

前端不得自行写这些状态变更。

### 10.4 错词回流队列

- 错答后第一次再次完成相同 `wordId` 前，必须完整间隔 3-6 道实际完成且产生 review log 的可评分任务；skipped task 不计入间隔。
- 同一单词在同一课的 `primary + bridge + reflux` 总 task 数最多为 3；pending 和 skipped task 均占预算。
- 任一用户可见、可评分 role 答错都必须进入唯一队列策略，不得按 role 静默忽略。
- 达到上限时持久化 `deferred_cap`；精确可行性判断证明无合法 3-6 排程时持久化 `deferred_capacity`。两者均不得追加新的 required task，并必须通过 `StageEngine` 收紧为下一课到期。
- `primary` 是同课唯一完整推进 StageEngine 的任务；`bridge` 和 `reflux` 不重复升降级。
- 完成课时必须同时满足至少 80% primary 已完成和所有已生成 required task 已完成。deferred outcome 不是 pending obligation，不得形成无限课时。
- 前端只渲染服务端权威队列，不计算 gap、cap、obligation 或 defer。

## 11. 错误处理规范

### 11.1 后端错误

后端错误分为：

- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `BUSINESS_RULE_VIOLATION`
- `EXTERNAL_DEPENDENCY_FAILED`
- `INTERNAL_ERROR`

规则：

- 可预期业务失败不得抛成 `INTERNAL_ERROR`。
- 用户重复提交、重复完成课时属于幂等或冲突场景，必须显式处理。
- D1 写入失败不得返回成功。

### 11.2 前端错误

前端必须区分：

- 页面级错误。
- 表单字段错误。
- 网络重试错误。
- 权限错误。
- 业务规则阻断。

学习页网络失败时：

- 不推进本地课时。
- 不清空当前答案。
- 显示可重试状态。

## 12. 测试规范

### 12.1 单元测试必测

必须覆盖：

- 20 个词生成 4 组。
- 22 个词生成 5 组。
- Lesson 1 激活第一组。
- Lesson 2 复习旧组并可激活新组。
- 停学多天不改变 `current_lesson_no`。
- score 0、1、2、3 对 streak、wrong count、ease factor 的影响。
- S0-S5 升级门槛。
- 连续错误降级。
- 错词首次同词回流前完整间隔 3-6 道实际完成题，gap 2/7 均拒绝。
- 五词连续全错恰好 15 个 task，每词总 task 不超过 3。
- 第三次仍错不生成第 4 个 task，持久化 `deferred_cap` 并收紧为下一课到期。
- 冻结词不足 4 个时持久化 `deferred_capacity`，不借未来词或生成中性 filler。
- 重复或并发 answer 不重复消耗次数预算，不生成重复 obligation。
- primary 完成率不足 80% 不推进课时。

### 12.2 API 测试必测

必须覆盖：

- 管理端导入词库。
- 构建练习项目。
- 未达覆盖率禁止发布。
- 发布版本不可修改。
- 创建 learner。
- 创建 course。
- 开始 lesson。
- 重复开始 lesson 不生成重复 session。
- 提交 answer。
- 重复提交 task 不重复计数。
- 完成 lesson。
- 重复完成 lesson 不重复推进。

### 12.3 端到端测试必测

必须覆盖：

- 管理员导入 20 个词，构建并发布。
- 学生用学习码进入课程。
- 学生完成 Lesson 1。
- 学生进入 Lesson 2。
- 刷新后继续未完成课时。
- 已生成 required 回流任务完成前不能结束课程；达到上限或容量不足而明确 defer 后可有限结束。

### 12.4 提交前检查

每次进入合并前必须通过：

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

如果某个命令尚未建立，当前阶段必须在实施计划或 PR 说明中明确原因，并补上该阶段可执行的替代验证。

## 13. 安全与权限规范

- `/admin` 和 `/api/admin/*` 必须有管理员保护。
- `/app` 学生端只允许访问学习码绑定的 learner/course。
- 学生端不得访问 source draft、coverage、publish、exercise edit API。
- 后端不得信任前端传入的 learnerId、courseId 权限关系。
- 所有写接口必须在服务端重新校验权限和状态。
- 第一版不保存儿童敏感扩展信息，只保存学习所需最小字段。

## 14. UI 和交互规范

后台工作台：

- 以表格、筛选、状态标记、覆盖率提示为主。
- 不做营销页式大图和装饰。
- 所有发布阻断必须能看到具体原因。
- 编辑练习项目必须显示当前词、阶段、题型、题干、答案。

学生客户端：

- 一屏只聚焦当前任务。
- 答题反馈要明确，但不展示复杂内部指标。
- 课时进度清晰显示。
- 未完成退出后再次进入应继续当前课。
- 移动端优先保证按钮、输入框和任务卡不挤压、不重叠。

## 15. 禁止事项

第一版禁止：

- 禁止把教材词表硬编码进业务逻辑。
- 禁止在前端写阶段升级或调度规则。
- 禁止在 route 层写 SQL。
- 禁止绕过 schema 直接读取 JSON 字段。
- 禁止发布版本原地修改。
- 禁止用日期推进复习。
- 禁止把大文件放 D1。
- 禁止引入未使用的 UI 库、ORM、状态库、后端框架。
- 禁止为了未来商业版提前做多租户权限矩阵。
- 禁止没有测试就改 `StageEngine`、`LessonScheduler`、`AnswerEvaluator`。

## 16. 新功能准入标准

新增功能必须满足：

1. 能说清属于后台内容构建、学生学习运行、报告展示或基础设施中的哪一类。
2. 不破坏 `draft -> published -> course snapshot` 边界。
3. 不让前端成为业务状态权威。
4. 有对应 schema、service、repository、测试。
5. 不扩大第一版非目标范围。

不满足以上任一条，不进入第一版。

## 17. 代码评审检查清单

每次 review 至少检查：

- 是否出现日期调度。
- 是否绕过 `StageEngine` 更新跨课阶段，或绕过唯一队列策略计算课内回流。
- 是否绕过 service 直接写多表。
- 是否让学生端访问管理端数据。
- 是否破坏发布版本不可变。
- 是否缺少幂等处理。
- 是否新增了无测试的核心规则。
- 是否出现未解释的新依赖。
- 是否把视图模型、数据库行、API DTO 混为一谈。

## 18. 与实施计划的关系

本规范约束 `pdoc/plan/PLAN_0706_云端MVP后台构建与课时训练闭环_v1.md` 的所有编码实现。若实施计划与本规范冲突，以本规范对代码边界、权限、测试和状态机的约束为准；若产品目标冲突，先更新计划再改代码。
