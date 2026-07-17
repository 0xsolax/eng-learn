# VISUAL_QA_0717_学习版本双路径审阅与反馈闭环_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：真实浏览器视觉与交互 QA 记录
- 版本：v1
- 状态：本地验收通过
- 日期：2026-07-17
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 实施计划：`pdoc/plan/PLAN_0717_学习版本双路径审阅与反馈重构闭环_v1.md`
- 设计说明：`pdoc/design/DESIGN_0717_学习版本双路径审阅与反馈闭环_v1.md`
- 可渲染审阅稿：`pdoc/design/DESIGN_0717_学习版本双路径审阅与反馈闭环视觉审阅稿_v1.html`

## 2. 验收环境

- 浏览器：Playwright Chromium
- Playwright：1.61.1
- 页面：当前生产 Vue 组件与路由
- 审阅交互数据：确定性管理端 API route fixture
- 真实后端补充：隔离 Worker + D1 整栈测试
- 远端环境：未访问

route fixture 只用于稳定复现视觉、键盘、请求次数和交互状态；真实持久化、迁移、原子性和学生运行态隔离由独立整栈用例验证。

## 3. 浏览器结果

### 3.1 当前工作区非覆盖回归

```text
pnpm exec playwright test --config playwright.ui.config.ts --grep-invert @visual-qa
```

- 61 passed
- 13 skipped
- 0 failed

该命令在当前工作区执行，避免覆盖用户已有的 `PLAN_0714` 截图改动。

### 3.2 隔离副本完整 UI 回归

将当前完整工作区复制到 `/tmp`，离线准备依赖后执行：

```text
pnpm test:e2e:ui
```

- 63 passed
- 13 skipped
- 0 failed
- 两项 `@visual-qa` 均通过
- 35 个历史管理端状态矩阵在隔离副本内生成
- 临时副本已删除，工作区中的 `PLAN_0714` 文件未被覆盖

## 4. 审阅专用交互证据

专用用例：`tests/e2e/ui/admin-review.spec.ts`

| 视口 | 结果 |
| --- | --- |
| 375px | 只读；无表单、反馈、批准；无横向溢出 |
| 479px | 只读；无可变入口 |
| 480px | 完整题目、反馈和批准交互恢复 |
| 768–1440px | 管理端布局、导航与题目交互通过 |
| 1280×900 | 完成答题、判题、反馈、Escape、打回、返回、更正、重答、批准 |

1280px 决策写请求顺序严格为：

```text
request_rework -> correct -> approve
```

- 每个决定只触发一次写请求。
- 写入后均权威重读。
- 审阅网络中 `/api/app/*` 请求数量为 0。
- 审阅路径控制台 error 数量为 0。
- 审阅路径 page error 数量为 0。
- 反馈面板打开后获得焦点；Escape 关闭后焦点回到“反馈”按钮。
- 直接更正后通过按钮重新禁用，完成新一次模拟判题后才启用。

## 5. 截图证据

| 文件 | 尺寸 | 核验内容 |
| --- | --- | --- |
| `version-detail-desktop-1280-dual-path.png` | 1280×1067 | 双路径、审阅摘要、无逐项 checkbox |
| `review-desktop-1280-feedback.png` | 1280×1021 | 反馈输入、计数、打回与更正入口 |
| `review-desktop-1280-correction.png` | 1280×1392 | 当前反馈、结构化编辑器、保存动作 |
| `review-mobile-375-readonly.png` | 375×812 | 小屏只读、无表单和写入口 |

截图均由 `admin-review.spec.ts` 对生产 Vue 页面生成。更正图使用 full-page 截图，固定侧栏在拼接图中的纵向位置属于截图拼接表现；实际 1280px 交互视口布局与导航测试通过。

## 6. 可渲染审阅稿验证

Chromium 直接打开：

`pdoc/design/DESIGN_0717_学习版本双路径审阅与反馈闭环视觉审阅稿_v1.html`

结果：

- 页面标题正确。
- 4 张图片全部 `complete = true`。
- 图片自然宽度分别为 1280、1280、1280、375。
- 控制台 error 数量为 0。
- page error 数量为 0。

## 7. 验收边界

- 本记录不代表 Cloudflare 生产部署验收。
- 本记录不代表远端 D1 已应用 0012。
- 登录视觉 QA 中预期的未认证 401 只属于历史登录状态捕获，不属于审阅路径错误。
- 生产数据 smoke 未执行。
