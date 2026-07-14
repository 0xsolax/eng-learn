# PLAN_0706_云端MVP后台构建与课时训练闭环_v1

## 1. 文档信息

- 项目：eng-learn
- 计划版本：v1
- 创建日期：2026-07-06
- 更新日期：2026-07-14
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 当前仓库状态：本地目录为空，当前目录不是 Git 仓库；远端 `https://github.com/0xsolax/eng-learn.git` 可访问但未发现 refs。

## 2. 当前结论

本项目第一版应做云端 MVP，但第一版的验证中心不是完整儿童英语学习平台，而是后台内容构建流程和课时制训练引擎。

推荐第一版只打通这一条链路：

```text
管理员导入词表
-> 系统按每 5 词分组
-> 后台构建每个词的练习项目
-> 管理员检查并发布词库版本
-> 客户端绑定已发布版本创建课程
-> 学生按课时完成任务
-> 答题结果更新单词状态
-> 下一课按 lesson_no 调度复习
-> 输出课后报告和错词列表
```

本计划不建议第一版接入 AI 自动出题、语音识别、支付、多租户 SaaS、R2 资源管理或完整 S6/S7 阅读巩固链路。它们会显著扩大耦合面，降低第一版验证课时制调度和后台构建流程的成功率。

## 3. 调研依据

### 3.1 仓库现状

- 本地路径：`/Users/solazhu/software/eng-learn`
- 当前本地目录为空。
- 当前目录不是 Git 仓库。
- 未发现项目内 `AGENTS.md`、`CLAUDE.md`、`.claude/rules/*.md`、`pdoc/rule`、`docs/rules`、`README`、`package.json`、`wrangler` 或 `vite` 配置。
- 因为没有既有代码和既有功能，当前不存在“改动破坏现有功能”的直接耦合风险；真正风险来自第一版架构如果边界切错，会让后续后台、客户端、调度、内容版本互相污染。

### 3.2 官方技术依据

- Vue 官方提供 TypeScript 一等支持，官方脚手架支持 Vite + TypeScript 项目。
- Cloudflare Workers 官方 Vue 指南支持 `src/` 前端、`server/index.ts` Worker 后端、`wrangler` 配置和 SPA 路由。
- Cloudflare D1 是托管 serverless SQL 数据库，提供 SQLite SQL 语义，支持从 Workers 访问，适合存结构化词库、课程、课时、任务、答题日志和单词状态。
- Cloudflare Access 可作为后台工作台的认证层，适合第一版先保护 `/admin` 和 `/api/admin/*`，避免过早自建完整账号系统。

参考链接：

- https://vuejs.org/guide/typescript/overview
- https://developers.cloudflare.com/workers/framework-guides/web-apps/vue/
- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/

## 4. 产品边界

### 4.1 第一版建设目标

第一版建设一个有前后工作台的云端 MVP：

- 管理员工作台：管理词库、导入单词、自动分组、构建练习项目、检查覆盖率、发布词库版本。
- 客户端工作台：学生通过学习码进入课程，完成课时任务，提交答题评分，查看课后报告。
- 后端 API：负责内容构建、课程创建、课时任务生成、答题状态更新、报告生成。
- 数据存储：D1 保存结构化数据；第一版不保存大文件资源。

### 4.2 第一版不建设内容

- 不做 AI 自动生成正式练习内容。
- 不做语音识别、跟读评分、音频上传、图片上传。
- 不做完整账号注册、支付、订阅、班级管理。
- 不做多租户后台、组织空间、角色权限矩阵。
- 不做教材版本市场和复杂教材对比。
- 不做 S6/S7 阅读长链路的自动评分。
- 不做离线 IndexedDB 同步。
- 不做 R2 文件存储；只在数据模型中保留未来资源字段。

## 5. 主框架

### 5.1 系统分层

```text
Vue SPA
  /admin 管理员工作台
  /app 学生客户端
        |
        v
Cloudflare Worker API
  admin routes
  app routes
  content builder service
  lesson scheduler service
  task generator service
  answer evaluator service
  stage engine service
  report service
        |
        v
Cloudflare D1
  content version data
  course runtime data
  task snapshots
  review logs
  word states
```

### 5.2 核心边界

后台内容构建和客户端学习运行必须分离：

- 后台可以修改草稿词库、草稿练习项目。
- 客户端只能使用已发布词库版本。
- 已开始课程绑定发布版本，不读取后台草稿。
- 已生成课时任务保存快照，不被后续练习包修改影响。
- 答题状态更新只写运行态表，不反写词库内容表。

## 6. 严格耦合调研

### 6.1 当前直接耦合风险

当前仓库为空，因此不存在已有页面、API、数据库迁移、测试或部署配置会被本方案直接破坏。第一版的主要风险不是兼容旧功能，而是把新系统的边界做错，导致后续功能互相牵连。

### 6.2 未来高风险耦合点

| 风险点 | 可能后果 | 控制方式 |
| --- | --- | --- |
| 词库草稿和已发布内容共用同一读取路径 | 管理员改词后，学生历史课程和报告被污染 | 引入 `source_versions`，课程只绑定已发布版本 |
| 练习包和课时任务不分离 | 后台修改题目后，正在上的课内容变化 | `lesson_tasks` 保存题目快照 |
| 调度逻辑直接读取日期 | 停学几天后复习节奏被误推进 | 所有调度只看 `current_lesson_no` 和 `next_due_lesson_no` |
| 答题提交和课时完成无幂等控制 | 重复点击导致课时多推进或计数重复 | 每个 task 只允许一次有效完成；lesson complete 使用状态机 |
| 管理后台和学生端共用接口权限 | 学生可访问构建或发布接口 | `/api/admin/*` 与 `/api/app/*` 分命名空间和认证 |
| 内容生成逻辑混入运行态调度 | 后续接 AI 或人工审核时改动会影响上课 | `ContentBuilder` 只产出练习项目；`TaskGenerator` 只消费已批准项目 |
| 阶段规则散落在组件和 API 中 | 调整 S0-S5 规则时容易漏改 | `StageEngine` 作为唯一阶段状态机 |
| D1 schema 初期无唯一约束 | 重复导入、重复状态、重复日志难排查 | 对 source/order、course/word、session/task 设置唯一约束 |

### 6.3 依赖失败攻击

如果 Cloudflare D1 不可用，客户端无法保存答题和推进课程。第一版不做离线学习，因为离线同步会增加复杂度；处理方式是所有答题提交失败时保留当前页面状态并提示重试，不推进课时。

如果 Cloudflare Access 配置未完成，管理员后台不能安全上线。处理方式是第一版本地开发仍可使用开发模式管理员保护；部署验收前必须完成 Access 或等价保护，否则 `/admin` 不允许公网访问。

如果后续 AI 生成内容失败，不影响第一版，因为第一版练习包由规则模板生成并允许人工编辑。

### 6.4 10 倍规模攻击

第一版按家庭和小规模试用设计。若从 1 个孩子扩到 10 个孩子、从 50 词扩到 500 词，最先承压的是任务生成查询和练习包覆盖率检查。

控制方式：

- 对 `user_word_states(course_id, next_due_lesson_no, status)` 建索引。
- 对 `exercise_items(source_version_id, word_id, stage, status)` 建索引。
- 每课限制任务量，不一次性加载全部词。
- 管理端覆盖率按 source_version 聚合，不在客户端实时计算。

### 6.5 回滚攻击

代码回滚容易，数据回滚困难。第一版必须避免破坏性迁移：

- 迁移只做新增表、新增字段、新增索引。
- 不在第一版写删除历史课程、删除 review log 的功能。
- 发布后的 `source_version` 不允许原地修改，只能创建新版本。
- 课程绑定旧版本继续运行，新版本只影响新课程。

## 7. 推荐数据模型

### 7.1 内容构建域

- `word_sources`：词库主记录，例如“自定义测试词库”。
- `source_versions`：词库版本，状态为 `draft`、`published`、`archived`。
- `words`：某版本下的单词。
- `word_groups`：按顺序每 5 个词形成一组。
- `exercise_packs`：每个词的一套练习包。
- `exercise_items`：具体练习项目，保存阶段、题型、题干、答案、难度、审核状态。

### 7.2 学习运行域

- `learners`：学习者。
- `courses`：学习者绑定某个已发布词库版本后的课程。
- `user_word_states`：每个课程里每个词的掌握状态。
- `lesson_sessions`：一次课时会话。
- `lesson_tasks`：本课任务快照。
- `review_logs`：答题日志。

### 7.3 状态约束

- `source_versions.status`：`draft`、`published`、`archived`。
- `exercise_items.status`：`draft`、`approved`、`disabled`。
- `courses.status`：`active`、`paused`、`completed`。
- `lesson_sessions.status`：`started`、`completed`、`abandoned`。
- `lesson_tasks.status`：`pending`、`completed`、`skipped`。
- `user_word_states.stage`：MVP 只使用 `S0`、`S1`、`S2`、`S3`、`S4`、`S5`。

## 8. 推荐 API 边界

### 8.1 管理端 API

- `POST /api/admin/sources`：创建词库。
- `POST /api/admin/sources/:sourceId/import`：导入词表，生成草稿版本。
- `GET /api/admin/source-versions/:versionId`：查看词库版本详情。
- `POST /api/admin/source-versions/:versionId/build`：按规则构建练习包和练习项目。
- `GET /api/admin/source-versions/:versionId/coverage`：查看每个词、每个阶段、每种题型的覆盖情况。
- `PATCH /api/admin/exercise-items/:itemId`：编辑练习项目。
- `POST /api/admin/exercise-items/:itemId/approve`：批准练习项目。
- `POST /api/admin/source-versions/:versionId/publish`：发布版本。
- `POST /api/admin/learners`：创建学习者。
- `POST /api/admin/courses`：为学习者创建课程。

### 8.2 学生端 API

- `POST /api/app/session/by-code`：使用学习码进入学生端。
- `GET /api/app/courses/:courseId`：查看课程首页。
- `POST /api/app/courses/:courseId/lessons/start`：开始当前课。
- `GET /api/app/lessons/:sessionId/tasks`：获取本课任务。
- `POST /api/app/lessons/:sessionId/tasks/:taskId/answer`：提交答题结果。
- `POST /api/app/lessons/:sessionId/complete`：完成课时。
- `GET /api/app/courses/:courseId/report`：查看课程报告。
- `GET /api/app/courses/:courseId/wrong-words`：查看错词列表。

## 9. 实施计划

### 阶段一：项目基线和数据边界

目标：建立可部署的 Vue + Worker + D1 工程基线，明确内容构建域和学习运行域的数据边界。

实施内容：

1. 使用 Cloudflare 官方 Vue Workers 模板初始化项目。
2. 配置 TypeScript、Vue Router、Pinia、Vitest、Playwright、Wrangler。
3. 建立 `src/` 前端、`server/` 后端、`migrations/` 数据库迁移、`pdoc/` 文档目录。
4. 建立 D1 初始迁移，包含内容构建域和学习运行域的最小表。
5. 建立 API 路由命名空间：`/api/admin/*` 和 `/api/app/*`。

耦合控制：

- 不在阶段一实现业务页面，只建立工程和数据边界。
- 所有 schema 字段以 additive 方式设计，不写破坏性迁移。
- 管理端和学生端路由从第一天分开。

测试方式：

- TypeScript 类型检查通过。
- 单元测试能运行空测试和 schema 常量测试。
- D1 本地迁移可重复执行在干净数据库上。
- Worker 本地启动后 `/api/health` 返回正常。

验收标准：

- 本地开发服务可启动。
- D1 本地数据库可初始化。
- `/admin` 和 `/app` 两个前端入口可访问。
- `/api/admin/health` 和 `/api/app/health` 分别可访问。

### 阶段二：后台词库导入和自动分组

目标：管理员能导入一套词表，系统生成草稿词库版本，并按每 5 个词自动分组。

实施内容：

1. 实现管理端词库创建和词表导入 API。
2. 支持最小导入字段：`word`、`meaning`、`example_sentence`、`part_of_speech`。
3. 导入后创建 `source_version=draft`。
4. 按 `order_index` 每 5 个词生成 `word_groups`。
5. 管理端提供词库预览页面，显示总词数、分组数、缺失字段、重复词。

耦合控制：

- 导入只写草稿版本，不影响已发布版本。
- 重复导入创建新草稿版本，不覆盖旧版本。
- 分组由数据层持久化，后续调度不重新按前端列表推算。

测试方式：

- 单元测试：20 个词生成 4 组，22 个词生成 5 组。
- 单元测试：重复词、空 word、空 meaning 被识别。
- API 测试：导入后 `source_versions`、`words`、`word_groups` 数量正确。
- 页面手测：管理员能看到导入结果和异常提示。

验收标准：

- 导入 20 个测试词后，后台显示 4 个分组。
- 每个单词保留原始顺序。
- 错误数据不会进入发布状态。

### 阶段三：后台练习项目构建

目标：后台能基于词库版本构建 S0-S5 的练习项目，管理员能检查覆盖率并批准发布。

实施内容：

1. 实现 `ContentBuilder` 服务，只负责从词库生成练习包和练习项目。
2. 为每个词生成 MVP 题型：
   - S0：看词识义、基础句展示。
   - S1：中文到英文、看释义选词。
   - S2：同类或异类干扰选择题。
   - S3：短句填空、短句理解。
   - S4：句子拼装。
   - S5：中文到英文短句输出。
3. 实现 `exercise_packs` 和 `exercise_items` 持久化。
4. 实现覆盖率页面：按词、阶段、题型展示是否满足 MVP 最低题量。
5. 实现练习项目编辑、批准、禁用。
6. 实现版本发布；发布前必须覆盖率达标。

耦合控制：

- 构建服务不读取 learner、course、lesson、review log。
- 发布后的版本不允许原地修改。
- 客户端任务生成只消费 `approved` 项目。
- 练习项目题干和答案使用 JSON 字段，但服务层提供类型校验，避免前端直接拼 JSON。

测试方式：

- 单元测试：每个词至少生成 S0-S5 的最低练习项目。
- 单元测试：缺少 example_sentence 的词不能生成 S3/S4/S5 合格项目，覆盖率显示缺口。
- API 测试：未达覆盖率无法 publish。
- API 测试：已发布版本不能被修改，只能创建新版本。
- 页面手测：管理员能从导入到发布完成一次内容构建。

验收标准：

- 20 个测试词能生成可发布练习包。
- 覆盖率报告能指出每个不合格词的缺口。
- 发布后客户端只读已批准练习项目。

### 阶段四：课程创建和课时任务生成

目标：管理员能创建学习者和课程，客户端能开始当前课并获取任务。

实施内容：

1. 实现 learner 创建和学习码生成。
2. 实现 course 创建，绑定 `learner_id` 和 `published source_version_id`。
3. 创建课程时不一次性激活所有词，只记录课程和当前课时。
4. 实现 `LessonScheduler`：
   - 查询 `next_due_lesson_no <= current_lesson_no` 的旧词。
   - 如果复习压力允许，激活下一组 5 个新词。
   - 新词进入 S0，旧词按当前 stage 获取练习项目。
5. 实现 `TaskGenerator`：
   - 从 `approved exercise_items` 中抽取任务。
   - 写入 `lesson_tasks` 快照。
   - 保证同词任务尽量间隔出现。
6. 学生端实现课程首页和任务页基础流程。

耦合控制：

- `LessonScheduler` 不生成题干，只选择词和阶段。
- `TaskGenerator` 不修改单词状态，只生成任务快照。
- `lesson_tasks` 保存题干、答案、阶段和题型快照，后续内容版本变化不影响当前课。
- 未完成课时再次进入时复用未完成 session，不新建重复任务。

测试方式：

- 单元测试：Lesson 1 激活 Group 1 S0。
- 单元测试：Lesson 2 出现 Group 1 S1，并在压力允许时激活 Group 2 S0。
- 单元测试：停学 5 天后仍停留在同一个 `current_lesson_no`。
- API 测试：重复调用 start lesson 不生成重复 session。
- 页面手测：学生能使用学习码进入课程并看到任务。

验收标准：

- `current_lesson_no` 只在完成课时后推进。
- 任务生成完全基于课时编号，不基于自然日期。
- 同一个未完成课时再次打开可继续。

### 阶段五：答题提交、升降级和错词回炉

目标：学生答题后，系统按 0-3 分更新单词状态，支持升降级、错词延迟回炉和课时完成。

实施内容：

1. 实现 `AnswerEvaluator`，处理评分、正确计数、错误计数、答题日志。
2. 实现 `StageEngine`，作为唯一阶段升级、降级、跨课间隔和下一课到期计算入口；课内回流间隔由下一项的唯一队列策略负责。
3. 实现唯一课内队列策略，按学习者实际完成的可评分任务计算间隔；答错词首次再次出现前必须完整间隔 3-6 道题。
4. 同一单词在同一课的全部用户可见任务总数最多为 3，统一统计 `primary + bridge + reflux`；pending 和 skipped task 也占用次数预算。
5. 达到每词上限时写入 `deferred_cap`；精确可行性判断证明当前队列无合法 3-6 排程时写入 `deferred_capacity`。两者都不再追加本课 required task，并把该词收紧为下一课到期。
6. 实现课时完成规则：
   - 完成本课 80% 以上 primary task。
   - 完成所有已经生成的 required task。
   - `deferred_cap` 和 `deferred_capacity` 不作为 pending obligation，不永久阻断本课结束。
   - 满足条件后 `current_lesson_no + 1`。
7. 实现课后报告：完成数、正确率、错词、本课升级词、需复习词；达到上限或容量不足而顺延的词必须可解释。

耦合控制：

- 答题提交只允许更新当前 session 的当前 task。
- 同一 task 重复提交返回已有结果，不重复累计。
- 课时完成和单词状态更新必须通过服务层状态机，不由前端决定。
- review log 只追加，不更新历史记录。

测试方式：

- 单元测试：score 3 增加熟练度并拉长间隔。
- 单元测试：score 0 增加 lapse，连续错误触发降级。
- 单元测试：S0 到 S1、S1 到 S2 的升级门槛正确。
- 单元测试：primary 完成率不足 80% 不推进课时。
- 单元测试：错词不会立即重复，首次同词再次出现前完整间隔 3-6 道实际完成题。
- 单元测试：五词连续全错恰好生成 15 个 task，每词总出现 3 次且不会生成第 4 次。
- 单元测试：第三次仍错写入 `deferred_cap`、下一课到期且本课可以有限结束。
- 单元测试：冻结词不足 4 个时写入 `deferred_capacity`，不借未来词、不造 filler、不形成无限课时。
- API 测试：重复提交同一 task 不重复计数。
- 端到端测试：学生完成 Lesson 1 后进入 Lesson 2。

验收标准：

- 每个答题结果都有 review log。
- 每个词的 `next_due_lesson_no` 只由课时和阶段规则决定。
- 已经生成的 required 回流任务未完成前不能结束本课；达到上限或容量不足而明确顺延的错词不继续阻断。
- 课后报告能解释本课表现和下一步复习。

### 阶段六：最小部署和验收环境

目标：云端 MVP 可部署到 Cloudflare，管理员可在受保护后台构建内容，学生可通过客户端完整上课。

实施内容：

1. 配置 Wrangler 环境和 D1 binding。
2. 配置生产和本地 D1 数据库分离。
3. 配置 Cloudflare Access 或等价访问控制保护 `/admin` 和 `/api/admin/*`。
4. 部署到 Workers。
5. 使用 20 个测试词完成一次从后台构建到学生上课的验收。

耦合控制：

- 生产部署前不连接真实大词库。
- 生产 Access 未生效时不开放管理员后台。
- 生产数据库迁移先在本地和预览环境跑通。

测试方式：

- 本地：类型检查、单元测试、API 测试、端到端测试。
- 预览：D1 迁移、后台导入、练习包发布、学生上课。
- 生产：只做最小 smoke，不写大批测试数据。

验收标准：

- 访问 `/admin` 需要管理员认证或等价保护。
- 学生端无需管理员权限即可通过学习码进入课程。
- 20 词测试集可完成至少 3 个连续课时。
- 关闭浏览器后重新进入，未完成课时可继续。
- 停学多天不会改变 `current_lesson_no`。

## 10. 测试矩阵

| 测试层级 | 覆盖内容 | 必测场景 |
| --- | --- | --- |
| 单元测试 | 分组、阶段、间隔、覆盖率、错词队列 | 20 词分组、S0-S5 升级、连续错误降级、错词延迟 |
| API 测试 | 管理端和学生端接口 | 导入、构建、发布、创建课程、开始课时、提交答题、完成课时 |
| 集成测试 | D1 + Worker 服务 | 版本发布后不可变、课程绑定旧版本、lesson task 快照稳定 |
| 端到端测试 | 浏览器真实流程 | 管理员发布词库、学生完成 Lesson 1 和 Lesson 2 |
| 回归测试 | 关键业务不被破坏 | 停学不跳课、重复提交不重复计数、未完成课不推进 |

## 11. 验收用例

### 11.1 后台内容构建验收

输入：20 个单词，每个词包含 `word`、`meaning`、`example_sentence`。

预期：

- 系统创建 1 个草稿版本。
- 系统创建 20 个 words。
- 系统创建 4 个 groups。
- 系统为每个词生成 S0-S5 的练习项目。
- 覆盖率达标后可发布版本。
- 发布后版本不可原地修改。

### 11.2 客户端课时制验收

输入：一个 learner，一个绑定已发布版本的 course。

预期：

- 初始 `current_lesson_no = 1`。
- Lesson 1 激活第一组 5 个新词。
- 完成 Lesson 1 后 `current_lesson_no = 2`。
- 停学 5 天后再次打开仍是 Lesson 2。
- Lesson 2 可出现第一组复习任务和第二组新词任务。

### 11.3 错词回流验收

输入：学生在某个词上答错。

预期：

- 该词写入 review log。
- primary 答错时 `wrong_streak` 按 StageEngine 规则增加；bridge/reflux 不重复推进阶段状态。
- 本课后续不会立即重复同词。
- 若实际安排回流，答错后第一次再次完成相同 `wordId` 前必须完整间隔 3-6 道实际完成题；skipped task 不计入间隔。
- 同一单词同一课的 `primary + bridge + reflux` 总数不得超过 3，pending 和 skipped task 均占预算。
- 第三次仍错时不生成第 4 个 task，写入 `deferred_cap` 并收紧为下一课到期。
- 冻结词不足 4 个或精确可行性判断证明无合法排程时，写入 `deferred_capacity`；不借未来词、不新增中性 filler。
- 本课结束前必须完成所有已经生成的 required task；`deferred_cap`、`deferred_capacity` 不形成永久阻断。
- primary 连续错误达到阈值时阶段降级或停留；非 primary 错误只在最终 defer 时收紧下一课到期。

### 11.4 幂等和异常验收

输入：重复点击提交答题、重复点击完成课时、刷新页面。

预期：

- 同一 task 不会重复累计答题次数。
- 同一 session 不会重复推进课时。
- 刷新后仍能继续当前未完成课时。
- 网络失败时不推进课时，不写半完成状态。

## 12. 发布和回滚策略

### 12.1 发布策略

- 每个阶段独立合并，阶段验收通过后再进入下一阶段。
- 数据库迁移只做新增，不做删除和重命名。
- 管理端后台保护未完成前，不允许公开部署管理员入口。
- 发布版本和课程运行态分离，避免内容变更影响历史课程。

### 12.2 回滚策略

- 代码问题：回滚 Worker 部署版本。
- 练习包内容问题：禁用有问题的 `source_version`，创建新版本修复。
- 单个练习项目问题：对新版本禁用该题；已生成 lesson task 保留快照，用报告解释历史数据。
- schema 问题：第一版禁止破坏性迁移，降低回滚难度。

## 13. 外部依赖和账号

| 依赖 | 用途 | 第一版是否必须 |
| --- | --- | --- |
| Cloudflare account | Workers、D1、Access 部署 | 是 |
| D1 database | 结构化数据存储 | 是 |
| Cloudflare Access | 管理后台保护 | 部署公开访问时必须 |
| R2 | 图片、音频、导入文件存储 | 否 |
| LLM API | 自动生成题目 | 否 |
| 邮件/短信服务 | 登录、通知 | 否 |

## 14. 风险清单

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| 第一版范围膨胀成完整教育平台 | 高 | 严格限制为后台构建和课时训练闭环 |
| 词库内容修改污染历史课程 | 高 | 版本化和任务快照 |
| 课时调度误用日期 | 高 | 测试固定覆盖停学场景 |
| 输出类题目评分过早复杂化 | 中 | S5 第一版用人工/自评 0-3 分，不做 AI 批改 |
| 管理端未保护就部署 | 高 | Access 或等价保护作为部署验收条件 |
| D1 查询后期变慢 | 中 | MVP 初期建关键索引，避免全表实时扫描 |

## 15. 最小成功标准

第一版完成后，必须能证明：

1. 管理员可以导入一套词表，并构建成可学习的练习项目。
2. 系统可以按每 5 个词分组，并按课程逐步解锁。
3. 学生学习节奏由课时推进，不受自然日期影响。
4. 每个词有独立状态，答题后能升级、停留或降级。
5. 错词按 3-6 道实际完成题延迟回流；每词同课总出现不超过 3，达到上限或容量不足时明确顺延而不形成无限课时。
6. 已发布内容、已开始课程、已生成任务之间不会互相污染。
7. 停学、刷新、重复提交、未完成退出都有明确行为。

## 16. 执行前确认项

在进入编码前，需确认以下决策：

1. 第一版阶段范围固定为 S0-S5。
2. 第一版练习项目由规则模板生成，管理员人工检查后发布。
3. 第一版学生端使用学习码进入，不做完整账号注册。
4. 第一版部署 Cloudflare Workers + D1，公开后台必须配置 Cloudflare Access 或等价保护。
5. 第一版不接 R2、不接 LLM、不做语音识别。
6. 第一版编码必须遵守 `pdoc/rule/RULE_前后端代码规范_v1.md`，尤其是前后端分层、API 契约、D1 访问、课时制状态机、测试门禁和发布版本不可变约束。

确认以上 6 点后，可以按本计划进入实现。
