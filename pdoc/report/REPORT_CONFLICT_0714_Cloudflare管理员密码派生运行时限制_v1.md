# REPORT_CONFLICT_0714：Cloudflare 管理员密码派生运行时限制

## 1. 文档信息

- 项目：eng-learn
- 文档类型：生产认证冲突与回滚报告
- 报告版本：v1
- 日期：2026-07-14
- 状态：冲突已解决；分支 A 已单版本 100% 发布并通过真实浏览器验收
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0714_管理员认证与高效内容工作台落地_v1.md`
- 关联验收：`pdoc/report/REPORT_0714_管理员认证与高效内容工作台落地验收_v1.md`
- 目标 Worker：`eng-learn`
- 生产入口：`https://eng-learn.0xsolax.workers.dev`

## 2. 冲突结论

原计划冻结的 `PBKDF2-HMAC-SHA256 / 600000` 无法通过当前 Cloudflare Workers 的原生 WebCrypto 或 Node Crypto 执行。

生产零流量诊断分别验证了两条平台原生路径：

1. `crypto.subtle.deriveBits` 拒绝 600000 次 PBKDF2。
2. `node:crypto.pbkdf2` 同样拒绝 600000 次 PBKDF2。

两条路径返回相同的运行时能力错误：

```text
NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).
```

这不是普通 CPU 超时，也不能通过提高 `limits.cpu_ms` 或升级 Workers Paid 解除原生 API 的 100000 次硬上限。计划禁止静默改写 v1 语义，因此任何兼容方案都必须升级配置版本并重新派生 verifier。

继续保留现有 Secret 的技术候选只剩“自有 PBKDF2 实现 + 具备足够 CPU 预算的私有计算边界”。普通 Worker 中的纯 JavaScript 候选已在真实边缘环境返回 1102；Durable Object + 预编译静态 Wasm 尚未验证，且会新增 Durable Object migration、Wasm 构建链和计算边界，属于原计划之外的架构变更。

Solazhu 已批准 Workers Free 下的分支 A：新配置升级为 v2 / PBKDF2-HMAC-SHA256 / 100000，旧 v1 继续严格表示 600000。完整候选 `867a65d1-4191-4a27-bef1-c26079fd070b` 已以稳定版 100% + 候选 0% 进入 deployment；版本覆盖下正确 Origin、路由、D1 限流和合法形状假凭证均通过，凭证请求返回 401 `invalid_admin_credentials`，未出现 500、503、1101 或 1102。探针只新增一条失败计数，已精确删除，两张认证表恢复为空。

当前生产管理员登录仍不可用，因为真实 v2 Secret 尚未由 Solazhu 在终端录入，候选仍为 0%。本报告不把零流量假凭证通过解释为真实账号登录已经完成。

## 3. 验证方案与实际结果

本次按以下顺序逐层定位：

```text
路由与健康
  → Origin
  → ADMIN_AUTH_CONFIG 绑定与解析
  → D1 migration 与限流占位
  → 密码派生
  → 凭证结果
  → Session 与 Cookie
```

| 检查 | 结果 | 定位含义 |
| --- | --- | --- |
| `GET /api/app/health` | 200 | Worker 与应用入口可用 |
| `GET /admin/login` | 200 | 登录文档可达 |
| 错误 Origin 登录请求 | 403 `origin_forbidden` | Origin 门禁生效 |
| 正确 Origin + 空 JSON | 400 `validation_error` | 登录路由和请求校验生效 |
| 无 Cookie / 假 Cookie session | 401 | 负向会话边界生效 |
| 未登录管理文档 | 302 到站内登录页 | 文档保护生效 |
| D1 migration | 0003 至 0010 已应用 | 会话与限流表已存在 |
| 合法形状假凭证 | 500 `internal_error` | 问题进入密码派生阶段 |
| WebCrypto 脱敏诊断 | `NotSupportedError`，上限 100000 | 600000 不受支持 |
| Node Crypto 脱敏诊断 | 同一 `NotSupportedError` | 更换 Node API 不能绕过限制 |
| 独立最小运行时探针 | WebCrypto、Node async、Node sync 均同一错误 | 与业务代码、Secret、D1 无关 |
| 纯 JavaScript 精确 PBKDF2 | 本地逐字节一致；真实边缘 1102 | 算法正确但普通 Worker 资源不足 |
| scrypt 探索探针 | 401，端到端 2.290741 秒 | 算法可执行，但未达到原计划性能门禁 |

假凭证只使用固定测试值，不包含真实管理员密码。诊断响应只暴露平台固定错误类型和错误信息，没有输出账号、密码、salt、verifier、rateLimitKey、Secret 内容或 Cookie。

## 4. 精确运行时证据

### 4.1 WebCrypto

- 候选版本：`a9f2c8a9-91f7-4389-873c-79744b9191c8`
- 脱敏诊断版本：`3269cb76-8ce3-41f4-ab34-3097028dcd29`
- 实际配置：PBKDF2-HMAC-SHA256、600000 次、32 字节派生值
- 结果：运行时在密码派生时拒绝请求，登录返回 500
- 精确错误：迭代次数超过 100000，不支持请求的 600000

### 4.2 Node Crypto

- 候选版本：`d1ab7e4b-1b65-4aea-a94e-66469876d1a3`
- 响应诊断版本：`dbd7ece6-214e-44e8-83fb-40435eb38cff`
- 实际配置：`nodejs_compat`、`node:crypto.pbkdf2`、600000 次
- 结果：登录返回 503 诊断响应
- 精确错误：与 WebCrypto 相同，迭代次数超过 100000

### 4.3 scrypt 探索

- 诊断版本：`512ed35f-0d97-488a-b6ae-79bc57943db4`
- 临时参数：`N=32768`、`r=8`、`p=3`、最大内存 64 MiB
- 结果：固定假凭证完成派生并返回预期 401
- 单次端到端时间：2.290741 秒
- 判断：该结果只证明运行时可执行，不构成性能通过；未测 P50/P95，也未证明五个并发派生在 128 MB isolate 内安全

### 4.4 与业务隔离的原生 API 最小探针

- `nodejs_compat` 版本：`60af4be3-c284-4955-8604-1125f2112457`
- `nodejs_compat_v2` 版本：`f58a14a6-f5bf-40d4-b1e4-1e40009409c1`
- 输入：固定公开测试密码、16 字节全零 salt、600000 次、32 字节派生值
- 路径：WebCrypto、Node async、Node sync
- 结果：三条路径均返回相同的 100000 次上限错误；v2 兼容标志不改变结果
- 生产影响：仅上传不可变版本并调用版本预览 URL，从未进入活动 deployment，未绑定或读取生产 Secret、D1

workerd 源码进一步确认：WebCrypto 和 Node Crypto 最终都调用同一个 PBKDF2 limit check，托管默认上限为 100000；独立本地 workerd 明确取消该限制。因此本地成功不能推翻托管边缘失败，`nodejs_compat_v2`、兼容日期和 Workers Paid 都不能解除该原生 API 上限。

### 4.5 纯 JavaScript 精确实现探针

- 候选库：`@noble/hashes@2.2.0`，同步 PBKDF2-HMAC-SHA256
- 本地输入：ASCII、中文、首尾空格、128 字符四组固定测试向量
- 正确性：全部与 Node `pbkdf2Sync` 的 600000 次结果逐字节一致
- 本地单次时间：约 0.54 秒
- 打包结果：16.25 KiB，gzip 5.34 KiB，Worker startup 15 ms
- 远端版本：`c3f5090f-5b02-4308-b2cf-a9896d8db9e1`
- 远端输入：固定公开测试密码、16 字节全零 salt，不读取生产 Secret
- 远端结果：HTTP 500 / Cloudflare 1102 `Worker exceeded resource limits`
- 外部端到端时间：8.455895 秒；该值是客户端 wall time，不等于 Cloudflare CPU 计费字段
- 生产影响：版本仅上传并调用版本预览 URL，从未进入活动 deployment

该结果排除“在当前普通 Worker 内用纯 JavaScript 原样保留 600000 次 verifier”作为可靠发布方案。它不证明所有预编译 Wasm 实现都会失败，也不证明当前账号订阅类型；它只证明该精确候选在当前真实边缘资源边界内失败。

### 4.6 原生 PBKDF2 / 100000 免费版候选探针

- 远端版本：`006fd17f-dfa3-4161-8fda-4ed8a673fa0c`
- 输入：固定公开测试密码、16 字节全零 salt、100000 次、32 字节派生值
- 正确性基准：Node `pbkdf2Sync` 固定结果 `2fac10ed...9303dd`
- 路径：WebCrypto、Node async、Node sync 和纯 JavaScript 对照
- 初次并发冷探针：四条路径均返回 HTTP 200 和正确结果，未出现 1102
- WebCrypto 连续 10 次版本预览：10/10 返回正确结果，0 个 1101、1102 或 5xx
- 外部 wall time：P50 152.9 ms，P95 1401.8 ms；该值包含预览域名网络与冷启动，不能替代 Cloudflare CPU trace
- 生产影响：候选曾以 `stable 100% + candidate 0%` 进入 deployment 用于版本覆盖验证，未接收自然流量；测试后已恢复 `stable 100%` 单版本部署

该探针证明平台原生 100000 次参数在当前目标 Worker 的真实边缘环境中可以完成，不需要 Durable Object、Wasm 或外部认证服务。它只是 G-CRYPTO 和短样本 G-CPU 通过；正式发布仍需用完整登录候选验证 D1 限流、401、session、Cookie 和退出重放。

所有诊断代码均已从本地源码移除，所有诊断版本均不在当前活动部署中。

## 5. 与原计划的直接冲突

| 原计划约束 | 实测事实 | 结论 |
| --- | --- | --- |
| `ADMIN_AUTH_CONFIG v1` 固定 PBKDF2-SHA256 / 600000 | Worker 原生 API 硬拒绝超过 100000 | 原计划的原生实现不可执行 |
| 使用 Cloudflare Web Crypto | WebCrypto 在派生阶段拒绝 600000 | 技术路径不成立 |
| 不为通过资源限制而降低参数 | 唯一最小兼容参数是 100000 | 未经确认不能降参 |
| 先过 PBKDF2 远端门禁再发布 | 合法形状假凭证在部署后才暴露硬限制 | 执行顺序发生偏差 |
| 远端 P95 低于 1 秒 | scrypt 单次探索端到端已为 2.29 秒 | scrypt 未通过性能门禁 |
| 仅普通 Worker 内解决 | 精确纯 JavaScript 候选远端返回 1102 | 保留 v1 需要新增计算边界 |
| 新版本先 0% 再验证 | 新 Durable Object migration 不能只 upload | DO 首次验证必须独立部署探针或先做 migration-only deployment |
| PBKDF2 门禁失败则阻断发布 | WebCrypto 与 Node Crypto 均失败 | 已触发 NO-GO |

本次远端操作先完成 additive migration、变量候选和负向探针，随后合法形状假凭证才触发密码派生硬限制。以后必须把“目标运行时能否精确执行 KDF 参数”独立为 G-CRYPTO，并置于 migration、Secret 轮换和 100% 部署之前。

## 6. 现有 Secret 为什么不能直接修复

当前 `ADMIN_AUTH_CONFIG` 不保存原始密码，只保存 600000 次 PBKDF2 生成的 salt 和 verifier。

该 verifier 不能转换成以下任一种新校验值：

- PBKDF2-SHA256 / 100000；
- scrypt；
- Argon2id；
- 其他密码 KDF。

选择任何新参数或算法后，都必须由 Solazhu 再次在终端输入密码，重新生成 salt、verifier、credentialId 和 rateLimitKey，并轮换远端 Secret。原始密码仍不得进入命令参数、日志、仓库或报告。

若修改算法或参数，必须升级配置契约版本；不得让冻结为 PBKDF2-600000 的 `v1` 静默改变含义。

## 7. 生产现场收敛结果

### 7.1 Worker

- 当前 100% 生产版本：`42de0530-dbe4-4843-8c95-ed9f8576bcd8`
- 回滚基线版本：`6ceeabb9-ce93-461f-9e81-cf1d1328c0ba`
- 当前活动部署：v2 真实 Secret 版本单版本 100%，没有 0% 候选
- 发布后 `GET /api/app/health`：200
- 发布后 `GET /admin/login`：200、`Cache-Control: no-store`
- 正确 Origin + 空 JSON：400 `validation_error`
- 错误 Origin：403 `origin_forbidden`
- 无 Cookie session：401 `admin_session_required`
- 未登录管理文档：302 到站内登录页

该版本同时绑定 `ADMIN_API_TOKEN`、v2 `ADMIN_AUTH_CONFIG`、D1、Assets、精确 `APP_ORIGIN` 和 `ADMIN_BROWSER_AUTH_MODE=application_session`。真实浏览器登录尚未由 Solazhu 完成，因此不提前宣称端到端验收结束。

### 7.2 D1

- 数据库：`eng-learn-prod`
- migration：0003 至 0010 已应用，当前无待应用 migration
- migration 性质：additive，回滚 Worker 不回滚 D1
- `admin_login_rate_limits`：0 行，失败次数合计 0
- `admin_sessions`：0 行
- 迁移前 Time Travel bookmark：`00000003-00000000-000050a8-b2e957a2e644b7373475de9a15ea7104`

每次假凭证探针产生的限流行都按 `key_hash + window_started_at + failure_count + blocked_until + updated_at` 精确比较并删除；每次删除均确认 `changes() = 1`，最终再次确认表为空。

### 7.3 Secret 与本地现场

- 未读取、输出或记录 `ADMIN_AUTH_CONFIG` 的原始值
- 未读取、输出或记录管理员明文密码
- 已由 Solazhu 在本机 TTY 轮换远端 v2 Secret；未读取或记录其隐藏值
- 临时 Node Crypto、scrypt 和错误响应诊断代码已全部移除
- 本地仍保留已确认的密码最小长度 10 字符修改
- 本地 `wrangler.jsonc` 的精确 Origin 与应用会话模式已在生产版本生效

### 7.4 诊断清理后的本地复核

| 门禁 | 结果 |
| --- | --- |
| 单元测试 | 61 files / 535 tests passed |
| 组件测试 | 19 files / 244 tests passed |
| UI E2E | 55 passed / 13 skipped |
| 隔离 Worker + D1 E2E | 5 passed |
| 类型与发布构建 | `pnpm build` passed |
| Lint | `pnpm lint` passed |
| Cloudflare 类型 | `pnpm cf:types:check` passed |
| Cloudflare 启动分析 | `pnpm cf:check` passed |
| 敏感产物扫描 | `pnpm scan:artifacts` passed |
| 差异完整性 | `git diff --check` passed |

## 8. 可选解决分支

### 分支 A：PBKDF2-SHA256 / 100000，配置升级为 v2

适用：优先恢复单管理员后台，接受明确的安全折中。

要求：

1. 用户明确批准偏离原计划的 600000 次参数。
2. 配置前缀和 JSON schema 升级为 v2，不偷换 v1 语义。
3. 初始化脚本与 Worker 使用完全相同的固定参数。
4. Solazhu 在终端重新输入密码并轮换 `ADMIN_AUTH_CONFIG`。
5. 使用密码管理器生成的长随机密码或长口令；10 字符只是输入下限，不是推荐生产长度。
6. 保留 D1 每 IP 五次、十五分钟的在线限流。
7. 先通过 0% 版本 G-CRYPTO 和 G-CPU，再切到 100%。

代价：离线猜测成本低于原 600000 次设计，不能描述为与原计划等价。

当前证据：固定假数据的真实边缘探针已连续 10/10 成功，未出现 1102；该分支不再有已知平台能力阻断。

### 分支 B：scrypt v2

适用：保持内存困难型密码派生方向，接受额外设计和验证。

要求：

1. 冻结参数、内存、并发和超时模型。
2. 解决同 isolate 多请求并发导致的内存与拒绝服务风险。
3. 完成至少 100 次远端成功/失败 P50、P95 与 1102 验证。
4. 单次和并发均达到计划门禁后才能发布。

当前状态：仅证明单次运行时兼容；端到端单次 2.29 秒，不能立即采用。

### 分支 C：Cloudflare Access

适用：不在 Worker 内执行自管密码 KDF。

要求：重新启用并配置 Access application、policy、身份声明和退出语义，完成 Access 与 service token 的身份优先级验收。

### 分支 D：迁出密码验证层

适用：必须保留 PBKDF2-600000 或采用当前 Worker 不适合承载的 KDF。

要求：引入独立认证服务或受控验证边界，重新设计可用性、费用、Secret、网络信任和故障降级。本分支超出第一版最小范围。

### 分支 E：私有 Durable Object + 预编译静态 Wasm

适用：必须保留现有 `ADMIN_AUTH_CONFIG v1`、salt、verifier 和 600000 次参数，同时不把密码发送到 Cloudflare 之外。

候选边界：

1. 主 Worker 继续负责 Origin、schema、D1 原子限流、恒时比较、session 和 Cookie。
2. 私有 Durable Object 只接收当前请求内的 UTF-8 密码字节、16 字节 salt 和固定参数，执行自有 PBKDF2-HMAC-SHA256 / 600000。
3. PBKDF2 整段循环必须在预编译静态 Wasm 内完成；不得使用运行时 `WebAssembly.compile`、不得以 600000 次 JavaScript 调用拼接 HMAC、不得自写未经审计的密码算法。
4. Durable Object 不提供公开路由、不持久化输入、不记录请求体、不接收 username、credentialId、rateLimitKey 或整个 Secret。
5. 主 Worker收到 32 字节派生值后继续使用现有 `timingSafeEqual` 比较 verifier；配置契约保持 v1，不轮换 Secret。

远端验证必须分两段：

1. 先部署独立临时 probe Worker；它只含最终 DO 类、`new_sqlite_classes` migration 和固定公开测试向量，不绑定生产 Secret、D1 或路由。
2. probe 必须证明结果与 Node 初始化脚本逐字节一致，且无 1101、1102、5xx；再测串行和并发的 P50/P95。
3. probe 通过后，生产先做行为不变的 migration-only deployment：包含最终 DO 实现，但主登录路径仍不调用 DO。
4. migration 已应用后，再上传无 migration 的登录候选，以 `stable 100% + candidate 0%` 和 Version Override 完成假凭证探针。
5. 最后才允许切到 100%，并由 Solazhu 输入真实密码完成登录、退出和 Cookie 重放验收。

限制：`wrangler versions upload` 不会应用新 Durable Object migration；含新 migration 的首次版本必须真实 deploy。独立 probe Worker 会新增并随后清理 Cloudflare Worker/DO 资源；生产 migration-only deployment 会新增不可通过普通 Worker 回滚消除的 DO namespace。该分支尚未获得授权，不能直接执行。

## 9. 已批准方案与长期边界

Solazhu 已明确当前使用 Workers Free，并允许采用普通、平台原生的密码派生方式。基于 100000 次真实边缘探针已通过，当前推荐改为分支 A，停止分支 E；Durable Object + Rust/Wasm 对单管理员免费版 MVP 没有必要。

分支 A 必须明确放弃“保留现有 Secret”，接受离线派生成本从 600000 次降到 100000 次，并由 Solazhu 在终端重新输入一次密码。安全补偿边界保持不变：随机 salt、32 字节 verifier、恒时比较、统一错误、D1 每来源 5 次/15 分钟限流、HttpOnly + Secure + SameSite Cookie、会话撤销。10 字符只是输入下限，生产密码仍推荐使用密码管理器生成的 16 字符以上随机密码或等强度长口令。

后续维护继续遵守以下边界：

- 不使用会立即部署的普通 `wrangler secret put`；
- 不把 PBKDF2 迭代次数继续降到 100000 以下；
- 不切换 KDF；
- 不复用 `v1` 表示新参数；
- 不重复发送已知必败的 600000 次生产登录探针；
- 不创建 Durable Object、临时 probe Worker 或 Wasm 构建链。

## 10. 验收进度与剩余顺序

1. 已完成：更新计划和配置契约，明确算法、参数、版本与回滚边界。
2. 已完成：写失败测试，再实现脚本与 Worker 的同一固定 KDF。
3. 已完成：通过单元、组件、类型、Lint、构建、Cloudflare 启动和敏感产物扫描。
4. 已完成：上传完整 0% 分支 A 候选，并确认代码、Assets、D1、Secret 与普通变量绑定完整。
5. 已完成：使用版本覆盖执行一次合法形状假凭证，返回 401，未出现 500、503、1101 或 1102。
6. 已完成：精确清理限流探针行并确认 D1 恢复为空。
7. 已完成：切换 100%，再次完成健康、Origin、session、文档保护和部署状态 smoke。
8. 已完成：Solazhu 在生产页面输入真实凭证，确认登录跳转、工作台和管理员名称。
9. 已完成：D1 只保存会话 token hash；退出后会话撤销，浏览器后退和刷新不能恢复工作台；隔离整栈覆盖原始旧 Cookie 重放返回 401。
10. 已完成：更新验收报告并关闭 NO-GO。

## 11. 依据

- Cloudflare Workers Web Crypto：<https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
- Cloudflare Workers Node.js crypto：<https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/>
- Cloudflare Workers limits：<https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare Durable Objects limits：<https://developers.cloudflare.com/durable-objects/platform/limits/>
- Cloudflare Durable Objects pricing：<https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Cloudflare Workers WebAssembly：<https://developers.cloudflare.com/workers/runtime-apis/webassembly/>
- Cloudflare Durable Object migrations：<https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#durable-object-migrations>
- Cloudflare version overrides：<https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/>
- workerd PBKDF2 issue：<https://github.com/cloudflare/workerd/issues/1346>
- workerd PBKDF2 600000 PR：<https://github.com/cloudflare/workerd/pull/3541>
- OWASP Password Storage Cheat Sheet：<https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
