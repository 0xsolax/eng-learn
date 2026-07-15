# REPORT_0715_CSV词库导入模板下载验收_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：实施验收报告
- 报告版本：v1
- 状态：本地实现与浏览器验收完成
- 日期：2026-07-15
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：`pdoc/plan/PLAN_0714_管理员认证与高效内容工作台落地_v1.md`
- 验收范围：当前 checkout、CSV 解析契约、Vue 管理端、真实 Chromium 下载、回填上传、响应式与项目回归
- 未执行：远端部署、Cloudflare 配置或生产数据操作

## 2. 验收结论

管理员词库导入工作区已经增加“下载 CSV 模板”入口，并关闭以下闭环：

1. 模板只包含 `word`、`meaning`、`exampleSentence`、`partOfSpeech` 四列表头，不包含示例词。
2. 模板内容由现有 CSV 解析器的同一表头契约生成，不复制静态列定义。
3. 下载文件名固定为 `eng-learn-word-import-template.csv`。
4. 实际下载文件使用 UTF-8 BOM 和 CRLF，兼容常见表格软件的 UTF-8 CSV 识别。
5. 在模板中填写一行后重新上传，现有页面显示“预览通过 · 1 个词”。
6. 下载不请求管理 API、不写 D1、不改变导入幂等、结果未知恢复或发布版本边界。
7. 479px 以下继续保持管理业务只读；480px 起下载入口和导入工作区可用。

## 3. 实施范围

- `src/features/admin-content/csvImport.ts`
  - 新增模板文件名、模板内容和下载 URL。
  - 模板表头直接复用 `CSV_HEADERS`。
- `src/pages/admin/SourceVersionsPage.vue`
  - 在导入区标题右侧新增带下载图标的次级链接。
  - 保持“创建草稿版本”为唯一主动作。
- `tests/unit/csvImport.test.ts`
  - 固定模板文件名、BOM、表头、CRLF 和回填解析契约。
- `tests/component/admin/SourceVersionsPage.test.ts`
  - 固定下载入口文案、文件名和浏览器下载内容。
- 管理端设计、实施计划与词库视觉 QA 产物同步更新。

## 4. 验证证据

| 门禁 | 结果 | 证据 |
| --- | --- | --- |
| TDD 红测 | 通过 | 模板契约和页面下载入口各有一条预期失败 |
| 模板与页面定向测试 | 通过 | 12 unit + 12 component |
| 全量单元测试 | 通过 | 61 files / 536 tests |
| 全量组件测试 | 通过 | 19 files / 245 tests |
| 全量类型检查 | 通过 | `pnpm typecheck` |
| 全仓 lint | 通过 | `pnpm lint` |
| 隔离发布构建 | 通过 | `pnpm build`；Worker、Client 与 Secret 产物扫描通过 |
| Cloudflare 类型与启动分析 | 通过 | `pnpm cf:types:check`、`pnpm cf:check` |
| 完整 UI 浏览器测试 | 通过 | 55 passed / 13 skipped / 0 failed |
| 隔离 Worker + D1 整栈 | 通过 | 5 passed / 0 failed |
| 真实浏览器下载 | 通过 | 46 字节；开头 `EF BB BF`，结尾 `0D 0A` |
| 回填上传 | 通过 | 填写一行后显示“预览通过 · 1 个词” |
| 响应式 | 通过 | 1280×800、768×1024、480×812 无重叠；479/480 边界保持 |
| 横向溢出 | 通过 | 480px 下 `clientWidth = scrollWidth = 480`；479px 同样无溢出 |
| 差异与敏感产物 | 通过 | `git diff --check`、`pnpm scan:artifacts` |

受限沙箱内首次启动完整 Playwright 套件时，Chromium 在 macOS Mach port 注册阶段被系统拒绝，测试逻辑尚未开始。同一 `pnpm test:e2e` 在获准环境原样重跑后，UI 与隔离 Worker + D1 整栈全部通过。

## 5. 视觉验收

- 1280×800：下载入口位于导入区标题右侧，不与页面主动作竞争。
- 768×1024：入口保持单行可见，导入表单没有横向溢出。
- 480×812：标题和下载入口按窄桌面规则上下排列。
- 479px：导入工作区和下载入口均不渲染，保持原只读边界。
- 已更新词库主页面生产截图、对照图、词库状态联系表以及空状态、导入展开、预览成功、字段错误和结果未知状态截图。

## 6. 最终决策

- 本地实现：通过。
- CSV 模板下载与回填导入：通过。
- 既有词库导入和管理业务回归：通过。
- 远端发布：未执行，需单独授权。
