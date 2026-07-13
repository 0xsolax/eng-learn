# RESEARCH_0713_学习类产品UI设计调研_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：学习类产品 UI/UX 一手资料调研
- 文档版本：v1
- 创建日期：2026-07-13
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 适用范围：`/admin` 管理员工作台、`/app` 学习端，以及后续设计语言与视觉审阅稿
- 研究目标：建立可审阅的 UI 设计基线，不直接产出页面实现

## 2. 研究结论摘要

eng-learn 不应制作成“低成本 Duolingo 复刻版”。应迁移 Duolingo 已验证的学习体验机制，但必须建立独立的品牌表达，并服从本项目的课时制调度与儿童使用场景。

推荐基调如下：

```text
共享设计语言：清晰、亲和、直接、可恢复

学习端：明亮但克制、单任务聚焦、即时反馈、轻量庆祝
管理端：安静、紧凑、可扫描、可审计、低装饰
```

第一版最重要的设计决策：

1. 学习端采用“一屏一个主要任务”，让题目、答案区、反馈区和下一步操作保持稳定位置。
2. 学习过程只展示课时进度，不采用自然日连续学习作为核心进度，更不以中断天数惩罚儿童。
3. 正确与错误都提供即时、具体、可继续的反馈；错误不是失败页，也不扣除“生命值”。
4. 角色、插画、音效和动效只承担定向提示与阶段性庆祝，不进入答题判定所依赖的信息层。
5. 管理端与学习端共享颜色、字体、间距和状态语义，但不共享信息密度和页面构图。
6. 管理端以列表、表格、筛选、覆盖率和版本状态为主，不做儿童化大卡片工作台。
7. 无障碍基线采用 WCAG 2.2 AA；儿童高频操作进一步采用不小于 48×48 CSS px 的内部目标，而不是只满足 24×24 CSS px 的最低要求。

## 3. 调研方法与证据边界

### 3.1 来源选择

本调研仅使用以下类型的资料：

- 产品方官方设计指南、官方产品说明与官方研究文章；
- W3C Web Accessibility Initiative 的 WCAG 2.2 与认知无障碍资料；
- Apple Human Interface Guidelines；
- IBM Carbon Design System 的工作台组件规范。

未使用应用榜单、设计图库点评、竞品拆解自媒体或无法追溯到产品方的二手结论。

### 3.2 证据边界

- Duolingo 公开的是品牌指南和部分产品/学习研究，不是完整内部组件设计系统。因此本文只从官方截图和官方说明提炼可观察机制，不把尺寸、按钮深度或组件 token 描述成 Duolingo 的公开规范。
- Khan Academy Kids 的官方文章包含儿童实测与产品团队观察，可用于约束干扰、音效和回答方式，但不能替代 eng-learn 自己的儿童可用性测试。
- Quizlet 的产品研究主要面向更广泛的学生群体，可用于题型递进和主动回忆，不直接决定低龄儿童的视觉密度。
- 本文给出的字号、触控尺寸、间距和布局是“来源证据 + eng-learn 产品边界”形成的项目决策，仍需在视觉审阅稿和真实设备上验证。

## 4. Duolingo：可迁移机制与不可复制边界

### 4.1 可迁移的产品机制

| 机制 | 一手证据 | 对 eng-learn 的迁移方式 |
| --- | --- | --- |
| 单一、清晰的下一步 | Duolingo 将首页改为线性路径，目标是减少“该学什么”的疑问，并把练习直接编入路径。[Duolingo：The Science Behind Duolingo's Home Screen Redesign](https://blog.duolingo.com/new-duolingo-home-screen-design/)（访问日期：2026-07-13） | 课程首页只突出“继续第 N 课”；历史报告、错词和设置保持次级，不让儿童自行决定调度顺序。 |
| 小步学习与渐进难度 | Duolingo Method 将互动练习、小体量课程、由易到难、可选提示列为核心方法。[Duolingo：The Duolingo Method](https://blog.duolingo.com/duolingo-teaching-method/)（访问日期：2026-07-13） | 每次只显示一个任务；S0-S5 从认识、识别逐步走向主动输出，提示在需要时展开，不与主问题竞争注意力。 |
| 稳定的单题结构 | Duolingo 官方文章中的课程截图把提示和作答放在主体区域，把 Check 操作固定在屏幕底部。[Duolingo：The Duolingo Method](https://blog.duolingo.com/duolingo-teaching-method/)（访问日期：2026-07-13） | 学习页固定为“顶部进度、题目、作答区、反馈区、底部主操作”，不同题型不得改变主操作的位置与语义。 |
| 学习与复习混排 | Duolingo 的线性路径把新内容、故事和复习编排到同一路径中，避免把复习表达为“退回旧内容”。[Duolingo：首页改版说明](https://blog.duolingo.com/new-duolingo-home-screen-design/)（访问日期：2026-07-13） | 不在学生端暴露调度算法；用“本课练习”统一承载新词、到期旧词和错词回炉。 |
| 即时且可解释的反馈 | Duolingo 的 Explain My Answer 在答题后给出正确形式和针对本次错误的解释，并允许学习者主动展开。[Duolingo：Explain My Answer](https://blog.duolingo.com/explain-my-answer-now-free/)（访问日期：2026-07-13） | 第一版反馈至少包含“结果、正确答案、一个短提示、继续”；解释应按需展开，不能用整屏长文阻断节奏。 |
| 愉悦作为反馈层 | Duolingo 把角色、鼓励语和阶段庆祝用于提升温度与成就感。[Duolingo：The Duolingo Method](https://blog.duolingo.com/duolingo-teaching-method/)（访问日期：2026-07-13） | 角色或插画只在欢迎、阶段切换、课时完成等节点出现；答题中不持续占据视线，也不承载正确答案。 |
| 可见但不过度复杂的进度 | Duolingo 用路径和 Score 给学习者提供清晰的进度表征。[Duolingo：How to Use Duolingo](https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo/)（访问日期：2026-07-13） | 学习端显示“第 N 课”和本课完成比例；掌握度、阶段覆盖率等复杂指标留给管理端。 |
| 关键流程优先性能 | Duolingo 将到达首页和开始学习视为关键转化步骤，并减少启动时的阻塞请求。[Duolingo：Android App Performance](https://blog.duolingo.com/android-app-performance/)（访问日期：2026-07-13） | 课程首页和当前课任务应优先加载；排行榜、装饰资源和非关键统计不得阻塞开始学习。第一版没有这些附加模块时更应保持轻量。 |

### 4.2 可借鉴的视觉原则

Duolingo 的公开品牌指南显示出三条可以抽象迁移、但不能照抄的原则：

1. **颜色有层级，不是所有区域都高饱和。** Duolingo 以主品牌色、辅助色和大组中性色分别承担品牌、强调和信息层级。[Duolingo Brand Guidelines：Color](https://design.duolingo.com/identity/color)（访问日期：2026-07-13）
2. **标题与正文分工明确。** Duolingo 使用展示字体承担短标题，较克制的圆体承担正文，并限制展示字体用于长文本。[Duolingo Brand Guidelines：Typography](https://design.duolingo.com/identity/typography)（访问日期：2026-07-13）
3. **角色必须表达具体情绪或动作。** 官方指南要求角色姿态具有情绪与叙事作用，而不是静态填充。[Duolingo Brand Guidelines：Imagery](https://design.duolingo.com/identity/imagery)（访问日期：2026-07-13）

对 eng-learn 的含义是：可以采用“中性学习表面 + 独立主色 + 少量状态色 + 有目的的角色反馈”，但不能用满屏高饱和色、随机插画或处处圆润来模拟“儿童感”。

### 4.3 不可复制的品牌资产与商业机制

| 不复制内容 | 依据 | eng-learn 的处理 |
| --- | --- | --- |
| Duo 猫头鹰、角色造型和插画语言 | Duolingo 将 Duo 和角色定义为核心、可识别品牌资产。[Duolingo Brand Guidelines：Imagery](https://design.duolingo.com/identity/imagery)（访问日期：2026-07-13） | 建立独立角色概念；视觉审阅稿阶段即禁止猫头鹰轮廓、相近姿态和复制式角色表情。 |
| Feather Green 主品牌绿及其整套命名色盘 | 官方将 `#58CC02` 定义为与 Duolingo 关联的核心品牌色。[Duolingo Brand Guidelines：Color](https://design.duolingo.com/identity/color)（访问日期：2026-07-13） | 不以该绿色或近似组合建立品牌识别；先确定独立主色，再做对比度验证。 |
| Feather Bold 字体与相似化字标 | 官方明确 Feather Bold 是 Duolingo 的定制字体，其他主体不能使用。[Duolingo Brand Guidelines：Typography](https://design.duolingo.com/identity/typography)（访问日期：2026-07-13） | 使用许可明确、中文覆盖稳定的字体；不仿制 Duolingo 字标曲线。 |
| 自然日连续学习 Streak | Duolingo 用连续自然日完成课程来延长 streak。[Duolingo：How the Streak Builds Habit](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)（访问日期：2026-07-13） | 与本项目课时制冲突，第一版不显示自然日连续天数，不因停学数日制造“进度损失”。 |
| Hearts、Gems、商店与社交竞争 | Duolingo 官方使用说明描述了答错消耗 Hearts、Gems 消费、好友任务等机制。[Duolingo：How to Use Duolingo](https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo/)（访问日期：2026-07-13） | 第一版不建设生命值、虚拟货币、排行榜或竞争。错误只影响学习调度，不限制儿童继续学习。 |
| 角色催促、羞耻或 guilt 表达 | Duolingo 官方品牌指南把 Duo 的持续催促和 guilt trip 作为其角色个性的一部分。[Duolingo Brand Guidelines：Imagery](https://design.duolingo.com/identity/imagery)（访问日期：2026-07-13） | 儿童端只使用中性、支持性反馈，不以失望、羞耻、损失恐惧推动学习。 |

## 5. 一手对照产品

### 5.1 Khan Academy Kids：儿童界面的“趣味与任务纯度”

Khan Academy Kids 的官方产品页强调角色引导、互动活动、故事和按儿童水平成长的学习路径。[Khan Academy Kids 官方产品页](https://www.khanacademy.org/kids)（访问日期：2026-07-13）这些机制说明，儿童产品可以有持续角色和丰富内容，但“有趣”不能等同于“所有元素同时活动”。

更关键的证据来自 Khan Academy Kids 对学龄前测评的官方复盘：[Prototyping Playful and Nimble Pre-K Assessments](https://blog.khanacademy.org/prototyping-playful-and-nimble-pre-k-assessments/)（访问日期：2026-07-13）：

- 不规则背景会干扰部分视觉比较任务，因此团队按任务删减背景，而不是维持统一的高装饰度。
- 怪物音效会诱导儿童反复点击并偏离任务；移除音效、保留视觉角色后，仍可维持趣味。
- 过多选项会增加工作记忆负担，并可能把执行功能差异误判为知识差异。
- 拖拽比轻点可能产生更有意图的回答，但这一观察来自特定测评场景，不能变成所有题型都必须拖拽的规则。

对 eng-learn 的直接约束：

1. 答题画布使用纯净背景；插画不得穿过文本、选项或排序轨迹。
2. 音效默认短促且与状态一一对应，不能让插画本身成为可反复触发的“声音玩具”。
3. 选择题初期优先 2-3 个清晰选项；只有当辨析目标需要时才提高到 4 个。
4. 句子拼装可以支持拖拽，但必须同时支持“点词、点位置”或点击排序。

### 5.2 Quizlet：题型递进与学习状态可见性

Quizlet Learn 官方说明其学习流程会根据既往表现调整题目，并从选择、判断逐步进入书写类任务。[Quizlet：Learn](https://quizlet.com/features/learn)（访问日期：2026-07-13）

Quizlet 的官方工程文章进一步区分识别与主动回忆：选择题更容易，书写回忆更难；合理流程应先用识别建立基础，再逐步进入回忆，同时避免把难度提升到持续失败。[Quizlet：Selecting Question Formats to Maximize the Testing Effect](https://quizlet.com/blog/selecting-question-formats-to-maximize-the-testing-effect)（访问日期：2026-07-13）

对 eng-learn 的直接约束：

1. S0-S5 不只改变文案，还要改变交互要求：浏览/识别 → 选择 → 补全 → 拼装 → 主动输入。
2. 难度不通过缩小按钮、增加干扰动画或隐藏提示制造，而通过回忆深度和语言产出要求提升。
3. 学习端只展示儿童能理解的当前进度；按词、阶段、题型的详细掌握数据放在管理员工作台。

### 5.3 对照结论

| 产品 | 最值得迁移 | 需要避免 |
| --- | --- | --- |
| Duolingo | 清晰下一步、单题流、线性进度、即时反馈、轻量庆祝 | 复制品牌色和角色；照搬自然日 streak、hearts、货币与竞争 |
| Khan Academy Kids | 角色引导、趣味内容、按任务删减干扰、儿童实测 | 把“儿童感”理解为持续动画、复杂背景和密集音效 |
| Quizlet | 识别到回忆的题型递进、短学习回合、弱项优先 | 把面向较大学生的高信息量界面直接缩小给低龄儿童 |

## 6. 儿童认知负荷、反馈、动效与无障碍约束

### 6.1 认知与页面结构

W3C 的认知与学习无障碍指南建议使用清楚的词语、短句、独立指令、明确页面结构、留白、一致视觉设计和及时反馈。[W3C：Making Content Usable for People with Cognitive and Learning Disabilities](https://www.w3.org/TR/coga-usable/)（访问日期：2026-07-13）

Apple 的认知无障碍指南同样要求使用简单、一致、易记的操作，减少限时元素，并把多步骤流程拆成每屏一个主要交互。[Apple HIG：Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（访问日期：2026-07-13）

eng-learn 学习端据此采用以下内部约束：

- 一屏只有一个主问题和一个主操作。
- 指令控制为一个短句；补充说明放入可展开提示。
- 题目、选项、反馈和继续按钮保持固定视觉顺序。
- 不在课时中显示管理数据、阶段算法、下一次到期课时或错词排名。
- 不使用倒计时推动普通练习；网络等待也不造成答题内容消失。
- 中途退出后保留已完成状态，返回时继续当前课时，而不是重新开始。

### 6.2 反馈与错误恢复

答题反馈应回答三个问题：

```text
刚才结果如何？
正确内容是什么？
下一步做什么？
```

具体规则：

- 正确：使用图标、文字和状态色共同表达；反馈简短，不强制播放长动画。
- 错误：明确展示正确答案和一个可执行提示，不只显示红色或“答错了”。
- 自由输入：轻微拼写问题与完全错误应使用不同文案，避免儿童无法判断问题所在。
- 网络提交失败：保留答案和当前题，提供“重新提交”，不得把失败当成答错。
- 管理端导入、构建和发布错误必须指出具体字段或项目；W3C 要求自动检测到的输入错误以文本标识和描述。[W3C WCAG 2.2：Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)（访问日期：2026-07-13）
- 不移动焦点的正确/错误、保存完成和构建完成信息应通过可被辅助技术识别的状态消息发布。[W3C WCAG 2.2：Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages)（访问日期：2026-07-13）

### 6.3 颜色与对比度

最低基线：

- 普通文本与背景对比度至少 4.5:1；大号文本至少 3:1。[W3C WCAG 2.2：Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)（访问日期：2026-07-13）
- 识别控件和状态所需的边界、图标等非文本信息与相邻颜色至少 3:1。[W3C WCAG 2.2：Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)（访问日期：2026-07-13）
- 颜色不能成为区分正确、错误、已选、禁用或发布状态的唯一方式；必须同时使用文字、图标或形状。[W3C WCAG 2.2：Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color)（访问日期：2026-07-13）

视觉审阅稿必须同时展示：默认、悬停、键盘聚焦、选中、正确、错误、禁用和加载状态，不能只审默认画面。

### 6.4 触控与输入方式

WCAG 2.2 AA 对指针目标的最低要求为 24×24 CSS px 或满足间距例外。[W3C WCAG 2.2：Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)（访问日期：2026-07-13）WCAG AAA 的增强要求为 44×44 CSS px。[W3C WCAG 2.2：Target Size Enhanced](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)（访问日期：2026-07-13）

eng-learn 的项目约束高于最低标准：

- 学习端高频点击目标不小于 48×48 CSS px。
- 相邻选项之间至少保留 8 px 可视间隔，点击热区不得重叠。
- 整个答案选项行可点击，不要求儿童精确点击单选圆点。
- 图标按钮必须有可访问名称；不熟悉的图标提供 tooltip。
- 所有学习任务同时支持键盘操作和清晰聚焦样式。

句子拼装不得依赖拖拽。WCAG 2.2 AA 要求拖拽功能提供无需拖动的单指针替代方式。[W3C WCAG 2.2：Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)（访问日期：2026-07-13）推荐实现为：点击词块后点击目标位置，或通过上移/下移按钮调整顺序。

### 6.5 动效与音频

动效只允许承担以下作用：

- 表示状态变化；
- 说明对象从哪里来到哪里；
- 在课时完成等低频节点表达庆祝。

禁止：持续漂浮装饰、视差背景、循环跳动角色、每题全屏彩屑、无法跳过的长庆祝和闪烁反馈。

W3C 要求自动开始、持续超过 5 秒并与其他内容并行的运动内容可暂停、停止或隐藏。[W3C WCAG 2.2：Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)（访问日期：2026-07-13）对交互触发的非必要运动，应支持用户减少或关闭。[W3C WCAG 2.2：Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)（访问日期：2026-07-13）Apple 也要求响应 Reduce Motion，并减少自动、重复、缩放和外围运动。[Apple HIG：Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（访问日期：2026-07-13）

因此：

- 必须支持 `prefers-reduced-motion`；减少动效时，以颜色、边框和淡入替代位移与缩放。
- 答题反馈动画不阻塞“继续”，并允许立即操作。
- 默认不自动播放背景音乐。
- 自动播放超过 3 秒的音频必须可暂停、停止或独立控制音量。[W3C WCAG 2.2：Audio Control](https://www.w3.org/WAI/WCAG22/Understanding/audio-control)（访问日期：2026-07-13）
- 发音播放是用户主动操作；音频状态同时用可见图标或文字表达。Apple 也建议用视觉或触觉提示补充音频提示。[Apple HIG：Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)（访问日期：2026-07-13）

## 7. 管理端与学习端的视觉密度分工

### 7.1 总体差异

| 维度 | `/admin` 管理员工作台 | `/app` 学习端 |
| --- | --- | --- |
| 核心用户 | 家长或内容管理员 | 儿童学习者 |
| 核心任务 | 导入、检查、构建、筛选、审核、发布 | 开始课程、完成单题、理解反馈、完成课时 |
| 主要设备 | 桌面优先，兼容平板 | 手机与平板优先，兼容桌面 |
| 信息密度 | 中高密度，可同时比较多行数据 | 低密度，一屏一个主任务 |
| 导航 | 稳定侧栏或顶部工作区导航 | 课时中隐藏全局导航，只保留退出与进度 |
| 主要构图 | 全宽表格、工具栏、筛选、详情面板 | 居中任务面、答案区、底部操作区 |
| 色彩 | 中性色为主，品牌色用于主操作，状态色语义化 | 中性答题表面 + 更明亮的品牌强调 + 少量角色反馈 |
| 动效 | 只做状态过渡、加载和成功确认 | 允许短促反馈和课时完成庆祝，但不持续运动 |
| 成功标准 | 高效、准确、可追溯 | 容易理解、愿意继续、错误后能恢复 |

### 7.2 管理端约束

IBM Carbon 将数据表格用于高效组织和显示数据，并规定搜索、筛选、排序、批量操作、分页和渐进展开等行为；其指南还建议给表格足够宽度，不把表格嵌套到狭窄容器或另一张表格中。[IBM Carbon：Data Table Usage](https://carbondesignsystem.com/components/data-table/usage/)（访问日期：2026-07-13）

eng-learn 管理端据此采用：

1. 词库、版本、单词和练习项目以表格或结构化列表为主，不以装饰卡片墙为主。
2. 表格工具栏集中搜索、筛选、显示设置和主操作；批量选择后再出现批量操作条。
3. 行内只保留高频操作；低频操作进入菜单，危险操作使用明确文字。
4. 详情使用独立页面或侧边详情面板，不把卡片、表格和弹窗多层嵌套。
5. 覆盖率同时提供总览和缺口列表，颜色之外还显示数量、阶段和状态文字。
6. 草稿、已发布和归档使用稳定状态标记；已发布版本不可编辑时，界面应直接移除编辑入口，而不是等提交后报错。
7. 发布前展示版本号、词数、分组数、覆盖缺口和不可逆影响，并要求确认。
8. 长任务使用骨架、阶段状态或进度文案；不以无限转圈代替构建状态。

推荐管理端基础密度：

- 页面正文：14-16 px；页面标题：24-28 px。
- 表格行高：40-48 px，表头与数据行保持一致密度。
- 主内容区优先使用宽表；桌面断点下不把关键列强制截断为省略号。
- 卡片圆角不超过 8 px，只用于独立重复项、模态框或真正需要框定的工具。
- 中性色承担主要层级，品牌色仅突出当前导航、主操作和明确选择状态。

### 7.3 学习端约束

学习端页面骨架固定为：

```text
课时页头：退出 / 第 N 课 / 进度
任务提示：一个短指令
学习内容：单词、句子、图片或音频入口
作答区域：大尺寸、明确状态
反馈区域：结果 + 正确答案 + 短提示
底部操作：检查 / 继续 / 完成本课
```

推荐学习端基础密度：

- 题目正文：24-30 px；辅助文字：16-18 px；按钮文字：16-18 px。
- 内容最大宽度约 720 px；桌面只增加留白，不横向摊开更多题目。
- 答案选项单列优先；只有短选项且空间充足时使用双列。
- 主操作在移动端贴近底部安全区，但不得遮挡内容或键盘。
- 本课进度条只表达本课完成比例，不显示自然日、排名、货币或复杂掌握分。
- 正误反馈后由儿童点击“继续”；不在反馈尚未读完时自动跳题。
- 错词回炉在视觉上仍是正常任务，不显示“惩罚题”“第几次答错”等标签。

## 8. eng-learn 设计语言基调建议

### 8.1 核心词

```text
亲和，但不幼稚
明亮，但不喧闹
直接，但不冷漠
有反馈，但不惩罚
有趣，但不干扰
紧凑，但不拥挤
```

### 8.2 共享视觉规则

| 项目 | 基线建议 |
| --- | --- |
| 色彩结构 | 独立品牌主色 + 1 个辅助强调色 + 语义成功/警告/错误/信息色 + 完整中性色阶；不使用 Duolingo 品牌绿作为识别核心 |
| 背景 | 学习与管理的主要工作表面保持白色或低彩度浅色；不使用渐变球、光斑和持续运动背景 |
| 字体 | 选择授权清晰、中文与英文覆盖稳定的无衬线字体；展示字仅用于短标题，正文优先可读性 |
| 字号 | 学习端明显大于管理端；不通过视口宽度连续缩放字号 |
| 字距 | 正文和按钮保持 0 字距，不用负字距制造紧凑感 |
| 圆角 | 容器与卡片不超过 8 px；答案选项可使用清晰边框，但不以极端胶囊形作为默认 |
| 图标 | 使用统一图标库；工具操作优先熟悉图标，陌生图标提供 tooltip 和可访问名称 |
| 插画 | 只用于欢迎、空状态、提示和课时完成；不得成为答题信息的唯一载体 |
| 层级 | 通过字号、字重、留白、边框和有限色彩建立，不依赖多层阴影或卡片套卡片 |
| 状态 | 每个状态同时具备文字、形状/图标和颜色；键盘焦点始终可见 |
| 动效 | 短、可中断、尊重 reduced motion；不使用循环装饰动效 |

### 8.3 第一版应先设计的视觉审阅状态

后续视觉审阅稿至少应包含以下画面，避免只审“漂亮的默认首页”：

1. 管理端：词库列表，包含空状态、正常状态和导入失败状态。
2. 管理端：版本详情与分组预览，包含草稿与已发布状态。
3. 管理端：练习覆盖率与练习项目审核，包含缺口、筛选和批量操作。
4. 管理端：发布确认，明确不可变版本和失败恢复。
5. 学习端：课程首页，包含首次开始和继续当前课。
6. 学习端：S0 认识、S2 选择、S3 填空、S4 拼装、S5 主动输入。
7. 学习端：正确、错误、提示后正确、网络提交失败和错词回炉。
8. 学习端：课时完成报告。
9. 响应式：390 px 手机、768 px 平板、1440 px 桌面。
10. 无障碍：键盘焦点、200% 缩放、reduced motion、高对比和无音频状态。

## 9. 反模式清单

以下设计不得进入第一版视觉基线：

1. 使用 Duolingo 近似绿色、猫头鹰角色、相似字标和同构学习路径，形成品牌复刻。
2. 用自然日 streak、断签损失、爱心耗尽或角色失望制造儿童压力。
3. 让排行榜、金币、宝箱或商城比学习任务更醒目。
4. 每道题都触发全屏庆祝、彩屑、震动或音效。
5. 在答题区域放置复杂背景、漂浮角色、循环动画或可反复触发的无关音效。
6. 用红绿颜色独立表达错误与正确。
7. 自动跳题、自动关闭反馈或使用普通练习倒计时。
8. 句子拼装只能拖拽，或者要求精确点击很小的词块。
9. 将桌面管理后台缩小后直接作为儿童端布局。
10. 将儿童端的大卡片、角色和明亮色彩直接搬进管理员工作台。
11. 管理端采用卡片套卡片、表格套卡片或每行多个始终可见按钮，降低扫描效率。
12. 隐藏草稿/发布版本边界，让管理员误以为修改会作用于正在学习的课程。
13. 网络错误后清空答案、推进任务或把提交失败记成答错。
14. 仅为“看起来像游戏”添加与学习结果无关的互动。

## 10. 视觉方案进入编码前的验收标准

视觉审阅稿只有同时满足以下条件，才适合进入组件和页面实现：

- 管理端与学习端明显属于同一品牌，但信息密度与构图明确不同。
- 学习端任一页面均能在 3 秒内识别主问题和主操作。
- 课时中没有自然日调度文案，也没有 streak、hearts、货币和排行榜。
- 不依靠颜色即可辨认正确、错误、选中、禁用和发布状态。
- 学习端高频操作目标达到 48×48 CSS px，管理端最低满足 WCAG 2.2 AA。
- 句子拼装存在非拖拽操作路径。
- reduced motion 下不丢失状态信息，也不阻塞操作。
- 正确、错误、网络失败和恢复路径均有视觉稿。
- 管理端清楚展示 source version、覆盖率、草稿/发布边界和不可变状态。
- 所有页面在目标手机、平板和桌面宽度下无文字截断、内容遮挡或操作重叠。
- 设计使用独立配色、字体和角色语言，不能被误认为 Duolingo 官方产品。
- 至少安排一次由目标年龄儿童完成 5-10 道任务的观察测试，并记录误触、停顿、求助和错误恢复情况。

## 11. 来源清单

本调研共使用 27 个一手来源，统一访问日期为 2026-07-13。

### 11.1 Duolingo 官方来源（9）

1. [The Duolingo Method](https://blog.duolingo.com/duolingo-teaching-method/)
2. [The Science Behind Duolingo's Home Screen Redesign](https://blog.duolingo.com/new-duolingo-home-screen-design/)
3. [Explain My Answer](https://blog.duolingo.com/explain-my-answer-now-free/)
4. [How to Use Duolingo](https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo/)
5. [How the Duolingo Streak Builds Habit](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)
6. [Duolingo Android App Performance](https://blog.duolingo.com/android-app-performance/)
7. [Duolingo Brand Guidelines：Color](https://design.duolingo.com/identity/color)
8. [Duolingo Brand Guidelines：Typography](https://design.duolingo.com/identity/typography)
9. [Duolingo Brand Guidelines：Imagery](https://design.duolingo.com/identity/imagery)

### 11.2 学习产品官方来源（5）

10. [Khan Academy Kids 官方产品页](https://www.khanacademy.org/kids)
11. [Khan Academy Kids：Prototyping Playful and Nimble Pre-K Assessments](https://blog.khanacademy.org/prototyping-playful-and-nimble-pre-k-assessments/)
12. [Quizlet Learn](https://quizlet.com/features/learn)
13. [Quizlet：Selecting Question Formats to Maximize the Testing Effect](https://quizlet.com/blog/selecting-question-formats-to-maximize-the-testing-effect)
14. [IBM Carbon Design System：Data Table Usage](https://carbondesignsystem.com/components/data-table/usage/)

### 11.3 无障碍与认知官方来源（13）

15. [W3C：Making Content Usable for People with Cognitive and Learning Disabilities](https://www.w3.org/TR/coga-usable/)
16. [W3C WCAG 2.2：Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color)
17. [W3C WCAG 2.2：Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
18. [W3C WCAG 2.2：Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
19. [W3C WCAG 2.2：Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
20. [W3C WCAG 2.2：Target Size Enhanced](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced)
21. [W3C WCAG 2.2：Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
22. [W3C WCAG 2.2：Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
23. [W3C WCAG 2.2：Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)
24. [W3C WCAG 2.2：Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages)
25. [Apple Human Interface Guidelines：Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
26. [W3C WCAG 2.2：Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification)
27. [W3C WCAG 2.2：Audio Control](https://www.w3.org/WAI/WCAG22/Understanding/audio-control)

## 12. 下一步建议

本调研完成后，下一步应单独产出设计方案和视觉审阅稿，顺序为：

```text
确认独立品牌方向与配色策略
-> 确认管理端/学习端信息架构
-> 建立共享 token 与关键组件状态
-> 绘制管理端和学习端关键流程
-> 输出多视口视觉审阅稿
-> 做无障碍与儿童可用性审阅
-> 用户确认后再进入编码
```

视觉审阅不应从首页单屏开始，而应优先并排审阅“管理端练习构建工作流”和“学习端完整答题状态”，确保设计语言同时支持第一版的两个验证中心。
