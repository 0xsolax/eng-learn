# REPORT_0714_管理员认证与高效内容工作台落地验收_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：实施验收报告
- 报告版本：v1
- 状态：本地实现与内部验收完成；远端发布 NO-GO
- 日期：2026-07-14
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0714_管理员认证与高效内容工作台落地_v1.md`
- 视觉验收：`design-qa.md`
- 验收范围：当前 checkout、终端初始化、应用会话、D1、Worker/API、Vue 管理端、真实浏览器、隔离本地 Worker + D1
- 未执行：远端 Secret、远端 migration、远端变量、Cloudflare Access 策略、部署和生产 smoke

## 2. 验收结论

本轮计划的本地实施范围已经完成并通过内部验收：

1. 管理员使用终端初始化的账号和密码登录，不再复用学生 10 位学习码。
2. 原始密码不落盘；`.dev.vars` 和远端 Secret 只接收版本化不可逆校验配置，远端值只通过标准输入传给 Wrangler。
3. 应用会话使用随机令牌和 `Secure`、`HttpOnly`、`SameSite=Strict` Cookie；D1 只保存令牌哈希，并支持过期、撤销、配置轮换失效和持久冷却。
4. `application_session`、Cloudflare Access 和 service token 的身份边界保持互斥；无效高优先身份不能降级到低优先身份。
5. 未登录可打开 `/admin/login`，业务文档安全跳转到登录页，管理 API 返回 `no-store` JSON 而不是 HTML 重定向。
6. 登录恢复、退出、路由白名单、会话失效广播、网络错误和结果未知状态均有稳定恢复路径。
7. 管理壳只保留词库与课程两个导航入口，并显示真实管理员名称、页面上下文和明确退出动作。
8. 词库、版本详情、练习审核和课程页面已按高密度工作台方案重排；已有数据列表优先，发布阻断先于矩阵，练习使用双栏审核，一次性学习码不会回到长期列表或截图。
9. 479/480px 写入口边界、键盘关键链路、退出后后退/刷新隔离、状态焦点、aXe 和页面级横向溢出均已覆盖。
10. 六组同视口视觉对照和 35 个状态截图已验收，`design-qa.md` 状态为 `passed`。

远端发布仍为 NO-GO。原因是目标 Worker 的 PBKDF2 CPU/1102 门禁尚未实测，且远端 Secret、migration、变量与部署均未获得本轮授权；本报告不构成远端发布授权。

## 3. 实施结果

### 3.1 配置型管理员与终端初始化

- `ADMIN_AUTH_CONFIG` 使用固定 `v1.<base64url JSON>` 格式，包含账号、显示名、随机 `credentialId`、PBKDF2 参数、salt、verifier 和随机限流密钥，不包含原始密码。
- PBKDF2-HMAC-SHA256 固定 600000 次；错误账号和错误密码统一执行完整校验并返回同类错误。
- 账号、显示名和密码使用脚本与 Worker 共用的边界规则；显示名按 Unicode code point 限长，并拒绝控制、格式和不可见分隔字符。
- 本地初始化使用真实交互式终端读取两次密码，密码输入不回显；非 TTY 环境在读取凭证前失败关闭。
- 本地配置采用同目录临时文件、原子 rename 和 `0600` 权限；重复定义、冲突 Origin、写入失败或非法配置不会猜测或留下半写文件。
- LF、CRLF 和无末尾换行的已有 `.dev.vars` 均保持原有结尾风格；其他变量、注释和顺序不被覆盖。
- 远端初始化仅通过标准输入调用 `wrangler secret put ADMIN_AUTH_CONFIG`；配置值不会进入 argv。

### 3.2 应用会话与服务端边界

- 新增 additive migration `0010_add_admin_sessions.sql`，提供管理员会话、登录冷却和必要索引。
- 会话 token 仅在 Cookie 返回给浏览器，D1 保存 SHA-256 哈希；查询、撤销、过期清理和 credentialId 轮换都由 service/repository 边界完成。
- 登录冷却使用 D1 原子占位控制并发校验名额；成功登录清除失败状态，失败、冷却和依赖故障使用稳定错误码。
- D1 会话或冷却存储失败统一返回依赖故障，不误报为凭证错误、成功退出或未登录。
- 请求携带合法格式 Cookie 但应用会话配置暂时不可用时，退出返回 `admin_not_configured` 且不清 Cookie，避免未撤销 D1 会话却伪称安全退出；无 Cookie 退出仍保持幂等。
- 登录、退出和浏览器写请求精确校验 `APP_ORIGIN`；service token 只保留 API-only 边界，不能加载管理端 HTML 或建立浏览器会话。
- 受保护管理文档只接受当前 `ADMIN_BROWSER_AUTH_MODE` 对应的浏览器身份，不把另一种浏览器模式或 service token 当降级备选。
- Access 的 email/sub 在输出会话 DTO 前按共享 schema 归一化；显示名优先使用合法 email，否则回退 subject，最多 64 个可见 Unicode code point，非法 email 不进入响应。
- 只有稳定的会话缺失、过期、撤销和身份失效错误会卸载业务壳；Origin 拒绝、业务冲突和普通服务异常保留当前页面。

### 3.3 管理端交互与视觉

- 登录页覆盖初始检查、提交、凭证错误、冷却、未初始化、网络失败、服务异常、会话过期和退出完成状态，并把恢复焦点落到正确入口。
- 词库页在已有版本时优先显示表格，导入区按需展开；导入预览、字段错误和结果未知保持原有 operation token 恢复语义。
- 版本详情按命令条、流水线、发布阻断、覆盖率矩阵和审批列表组织；DOM 与视觉阅读顺序一致。
- 练习页在 768px 以上保持编辑与审核双栏，字段错误就近且汇总显示，dirty 离开保护、并发冲突重读和 published 只读均有明确状态。
- 课程页优先显示课程表格；一次性学习码通过可访问对话框展示，复制成功/失败和轮换确认靠近触发对象，长期截图只使用遮罩。
- 键盘测试在任何断言退出前都把一次性学习码 DOM 替换为遮罩；产物扫描器同时识别 Playwright `error-context.md` 的 `code:` 与 HTML `<code>` 形态，失败产物不能静默保存裸码。
- 320 至 479px 登录仍可用，业务页发布、丢弃、审批、练习编辑、创建课程和轮换学习码等写入口不渲染；480px 起恢复计划允许的操作。

### 3.4 本地调试闭环

新增本地闭环命令：

    pnpm admin:setup:local
    pnpm dev:admin:local

第一条命令按顺序应用本地 D1 migration、补齐固定 HTTPS Origin 与 `application_session` 运行配置，再在终端中提示 Solazhu 输入管理员账号、显示名和两次密码。第二条命令完成隔离构建、复核本地 migration，并在 `https://127.0.0.1:8787` 启动真实 Worker、D1 和静态管理端。

本轮已把当前本地 D1 应用到 `0010`，并在 Git 忽略的 `.dev.vars` 中补齐 `APP_ORIGIN` 与 `ADMIN_BROWSER_AUTH_MODE`；文件权限为 `0600`。没有代填或生成默认管理员账号密码，`ADMIN_AUTH_CONFIG` 仍需由 Solazhu 亲自在终端执行第一条命令后写入。

真实本地启动 smoke 结果：

| 请求 | 结果 |
| --- | --- |
| `GET /admin/login` | 200，登录页面可加载 |
| `GET /api/app/health` | 200，Worker 与应用健康 |
| 未登录 `GET /admin/sources` | 302 到站内 `/admin/login?returnTo=...` |
| 未登录 `GET /api/admin/auth/session` | 401，稳定 `admin_session_required` JSON |

## 4. 验证证据

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| 全量类型检查 | 通过 | `pnpm typecheck`，三组 TypeScript 检查通过 |
| 全仓 lint | 通过 | `pnpm lint`；首次发现一处测试 callback 写法，修正后同命令通过，0 error / 0 warning |
| 全量单元测试 | 通过 | 61 files / 526 tests |
| 全量组件测试 | 通过 | 19 files / 244 tests |
| 管理员初始化定向测试 | 通过 | 1 file / 13 tests；包含原子写入、权限、非 TTY、stdin Secret、LF/CRLF 与无 EOF 换行 |
| 完整 UI 浏览器测试 | 通过 | 55 passed / 13 skipped / 0 failed；68 total，覆盖多视口、键盘、aXe、重排、状态矩阵与视觉对照 |
| 隔离 Worker + D1 整栈 | 通过 | 5 passed / 0 skipped / 0 failed；真实登录、工作台、退出、旧 Cookie 重放和完整业务闭环 |
| 同视口视觉与状态矩阵 | 通过 | 2/2 Playwright visual QA；6 组对照、35 个状态、5 张联系表 |
| 浏览器运行质量 | 通过 | 35 个状态 `pageerror = 0`、非预期应用 Console 错误 0、页面级横向溢出 0 |
| 隔离发布构建 | 通过 | Worker 178 modules、Client 1966 modules；发布构建和产物扫描通过 |
| Cloudflare 类型与启动分析 | 通过 | `pnpm cf:types:check`、`pnpm cf:check` |
| 敏感产物扫描 | 通过 | `pnpm scan:artifacts`；随机 canary 自测覆盖 Secret、Cookie、verifier、rateLimitKey 和学习码 |
| 本地 PBKDF2 基准 | 通过 | 成功 P50/P95 56.74/60.89ms；失败 P50/P95 56.75/60.53ms，均低于本地 1 秒门禁 |
| 当前本地调试入口 | 通过 | migration 0010、`.dev.vars` 0600、HTTPS Worker 启动与四个 HTTP smoke 结果 |
| 差异完整性 | 通过 | `git diff --check` 通过；最终安全与范围复核无未关闭本地阻断项 |

受限沙箱内首次启动本地 Wrangler 时，日志目录、注册表和文件监视被 macOS 权限限制拦截；同一 `pnpm dev:admin:local` 在获准环境原样重跑后启动成功。浏览器套件在受限沙箱内同样会在 Chromium MachPort 注册阶段失败，测试逻辑尚未开始；最终验收只采用沙箱外同一命令的结果，不缩小断言或跳过用例制造通过。

## 5. 重点异常与安全验收

| 场景 | 结果 |
| --- | --- |
| Secret 缺失、非法、未知版本 | fail closed，不建立会话 |
| 错误账号与错误密码 | 完整 PBKDF2，统一外部错误 |
| 第 5 次失败、冷却、冷却过期 | D1 持久且响应含稳定冷却语义 |
| 20 个并发失败请求 | 最多 5 个进入凭证校验 |
| D1 会话/限流读写失败 | 503 依赖故障，不误报身份结果 |
| 配置暂时缺失且 logout 携带 Cookie | 503，不清 Cookie、不伪称已撤销 |
| Cookie 缺失、非法、不存在、过期、撤销 | 稳定会话错误；不降级到其他身份 |
| 配置 credentialId 变化 | 旧会话失效 |
| Access assertion 无效并携带其他凭证 | 拒绝，不降级 |
| Access email/sub 超出显示契约 | 显示名归一化到 64 个可见码点，响应可被共享 schema 解析 |
| Cookie 无效并携带 service token | 浏览器身份拒绝，不降级 |
| Origin 缺失、错误、精确匹配 | 浏览器写请求按矩阵拒绝或通过 |
| logout 无 Cookie、过期、撤销、D1 故障 | 幂等/稳定错误语义，故障时不伪称退出成功 |
| 外部 returnTo、未知管理路径、登录页自身 | 清洗为安全默认路径 |
| 浏览器退出后后退与刷新 | 私有壳和业务内容不恢复 |
| 479/480px 边界 | 479 写入口不可达，480 按计划恢复 |
| 学习码复制 | 成功、权限拒绝、API 不可用均有反馈；测试随机值不进入长期产物 |
| bundle、storage、trace、HAR、日志和截图 | 未发现管理员密码、Secret、Cookie、静态管理员令牌或真实学习码 |

Playwright 默认禁用真实 BFCache，因此本轮真实浏览器证明的是退出后的后退与刷新隔离；`pageshow.persisted = true` 的恢复分支由组件测试覆盖，不把普通后退测试夸大为真实 BFCache 命中。

## 6. 视觉验收

`design-qa.md` 最终状态为 `passed`：

- 登录页：375×812、1280×800 两组同视口对照。
- 词库、版本详情、练习审核和课程工作台：四组桌面同视口对照。
- 状态矩阵：登录 10、词库 6、版本 6、练习 7、课程 6，共 35 个状态。
- `pageerror` 0、非预期应用 Console 错误 0、页面根节点横向溢出 0。
- 版本矩阵只在标记的 `matrix-scroll` 容器内部横向滚动；表格滚动也限制在允许容器内。
- 词库列表优先、版本阻断先于矩阵、真实结构化练习字段和课程真实对话框属于计划优先于早期视觉稿的有意差异，不声明像素级完全一致。

## 7. 远端发布阻断

以下门禁未关闭，不得把本地通过解释为生产可发布：

1. 未在目标 workers.dev Worker 上验证 PBKDF2 600000 次登录不会触发 1102 CPU 超限，也未证明远端 P95 与 CPU 余量。
2. 未确认目标计划是否需要升级 Workers Paid 并配置足够的 `limits.cpu_ms`；不得通过降低 PBKDF2 参数绕过门禁。
3. 未执行 `pnpm admin:init:remote`，目标环境没有由本轮写入或轮换 `ADMIN_AUTH_CONFIG`。
4. 未在远端设置并实时复核 `APP_ORIGIN` 与 `ADMIN_BROWSER_AUTH_MODE=application_session`。
5. 未执行远端 migration 0010、部署、生产登录/退出 smoke 或旧 Cookie 重放验证。
6. 未修改 Cloudflare Access application/policy；未来切换 Access 模式仍需单独设计和授权。

## 8. 最终决策

- 本地实现：通过。
- 本地 D1、Worker/API、Vue、浏览器和视觉语义：通过。
- 本地调试运行配置：通过；管理员账号密码等待 Solazhu 在终端亲自初始化。
- 学生端业务、课时排程、错词回流和发布不可变规则：未扩大修改范围。
- 远端 Secret、migration、变量与部署：未执行。
- 生产发布：NO-GO，等待第 7 节门禁逐项关闭并获得单独授权。
