# REPORT_CONFLICT_0713：旧版题型快照与新交互契约冲突

## 1. 文档信息

- 状态：生产发布阻断
- 日期：2026-07-13
- 责任人：Solazhu
- 修改人：Solazhu
- 操作人：Solazhu
- 关联计划：`pdoc/plan/PLAN_0713_前端视觉落地与双工作台交互闭环_v1.md`

## 2. 冲突结论

旧版持久化题目与本轮冻结的六类前端交互契约不能在所有历史数据上同时做到以下三点：

1. 历史 `exercise_items` 和 `lesson_tasks` 的 JSON 字节不变。
2. 旧版题目的交互与评分语义完全不变。
3. 所有题目都满足本轮共享判别联合、答案防泄漏和 S4/S5 新交互约束。

当前实现不得把“数据库 JSON 未改写”表述为“旧交互和评分语义完全等价”。在完成远端数据审计并作出兼容决策前，生产发布保持阻断。

## 3. 证据

旧版构建器对六个 stage 统一保存：

```text
answer = { word, meaning }
```

其中：

- 旧 S3 只执行一次普通字符串替换；例句不含目标词时不会生成 `____`。
- 旧 S4 直接使用 `exampleSentence.split(' ')`；可能得到单词块、空词块，或视觉上无法区分顺序的重复词块。
- 旧 S5 通过通用字符串答案比较评分，没有“先保存草稿、再显示参考句、最后自评”的两段式状态。
- 旧 S1/S2 的 `meaning` 可以包含目标词，可能在提交前直接泄漏答案。

本轮契约要求：

- S3 prompt 必须含合法空位且不得残留目标词。
- S4 使用不透明 piece ID、至少形成可操作的拼句任务，并按完整 piece 顺序评分。
- S5 先持久化草稿和参考句揭示状态，再按 0 至 3 分自评。
- 学习者未提交前不得从 prompt 读取正确答案。

因此，退化旧 S3/S4 无法在不改变运行时 prompt 的情况下进入新 renderer；旧 S5 也无法在不改变评分语义的情况下进入新交互。

## 4. 已完成的安全收口

- 当前新建、编辑、批准和发布仍只接受新 strict schema，没有放宽写入契约。
- 旧持久化 JSON 只通过独立读取适配处理，不原地更新 published 数据或 lesson task snapshot。
- 可确定映射的旧题允许管理员读取、编辑或丢弃。
- 旧 S1/S2 在管理员读取边界可见，但进入学习者边界前再次执行目标词 whole-token 防泄漏检查；检查会统一 Unicode 规范形式并折叠连续空白。
- 无法安全映射的旧 S3/S4，以及 S1/S2 或 S5 会泄漏答案的旧题，在学习者边界 fail-closed，不把有风险的 prompt 发给浏览器。
- 旧 lesson queue 与可无歧义关联的 review log 由 additive migration 恢复；有歧义的 NULL `task_id` 保持未关联，由报告完整性检查阻断，不猜测写入。

这些措施只证明“不会静默改写或泄漏”，不证明所有旧课都可继续按旧语义完成。

## 5. 部署前只读数据审计

以下查询只能在明确指定且已确认身份的目标 D1 上只读执行。不得让命令回退到默认生产配置，也不得把查询结果中的 prompt、answer、学习码或会话信息写入日志或报告。

### 5.1 旧版题目数量

```sql
SELECT 'exercise_items' AS dataset, task_type, COUNT(*) AS row_count
FROM exercise_items
WHERE json_type(answer_json, '$.meaning') = 'text'
GROUP BY task_type
UNION ALL
SELECT 'lesson_tasks' AS dataset, task_type, COUNT(*) AS row_count
FROM lesson_tasks
WHERE json_type(answer_json, '$.meaning') = 'text'
GROUP BY task_type
ORDER BY dataset, task_type;
```

### 5.2 不可直接进入新 renderer 的旧 S3/S4

```sql
SELECT 'exercise_items_s3_without_blank' AS finding, COUNT(*) AS row_count
FROM exercise_items
WHERE task_type = 'fill_blank'
  AND json_type(answer_json, '$.meaning') = 'text'
  AND instr(COALESCE(json_extract(prompt_json, '$.sentence'), ''), '____') = 0
UNION ALL
SELECT 'lesson_tasks_s3_without_blank' AS finding, COUNT(*) AS row_count
FROM lesson_tasks
WHERE task_type = 'fill_blank'
  AND json_type(answer_json, '$.meaning') = 'text'
  AND instr(COALESCE(json_extract(prompt_json, '$.sentence'), ''), '____') = 0
UNION ALL
SELECT 'exercise_items_s4_degenerate' AS finding, COUNT(*) AS row_count
FROM exercise_items AS item
WHERE item.task_type = 'sentence_build'
  AND json_type(item.answer_json, '$.meaning') = 'text'
  AND (
    json_array_length(item.prompt_json, '$.pieces') < 2
    OR EXISTS (
      SELECT 1 FROM json_each(item.prompt_json, '$.pieces')
      WHERE trim(CAST(value AS TEXT)) = ''
    )
    OR NOT EXISTS (
      SELECT 1
      FROM json_each(item.prompt_json, '$.pieces') AS forward_piece
      INNER JOIN json_each(item.prompt_json, '$.pieces') AS reverse_piece
        ON CAST(reverse_piece.key AS INTEGER) =
           json_array_length(item.prompt_json, '$.pieces') - 1 -
           CAST(forward_piece.key AS INTEGER)
      WHERE CAST(forward_piece.value AS TEXT) <>
            CAST(reverse_piece.value AS TEXT)
    )
  )
UNION ALL
SELECT 'lesson_tasks_s4_degenerate' AS finding, COUNT(*) AS row_count
FROM lesson_tasks AS task
WHERE task.task_type = 'sentence_build'
  AND json_type(task.answer_json, '$.meaning') = 'text'
  AND (
    json_array_length(task.prompt_json, '$.pieces') < 2
    OR EXISTS (
      SELECT 1 FROM json_each(task.prompt_json, '$.pieces')
      WHERE trim(CAST(value AS TEXT)) = ''
    )
    OR NOT EXISTS (
      SELECT 1
      FROM json_each(task.prompt_json, '$.pieces') AS forward_piece
      INNER JOIN json_each(task.prompt_json, '$.pieces') AS reverse_piece
        ON CAST(reverse_piece.key AS INTEGER) =
           json_array_length(task.prompt_json, '$.pieces') - 1 -
           CAST(forward_piece.key AS INTEGER)
      WHERE CAST(forward_piece.value AS TEXT) <>
            CAST(reverse_piece.value AS TEXT)
    )
  );
```

### 5.3 旧 S5 与潜在答案泄漏

```sql
SELECT 'exercise_items_legacy_s5' AS finding, COUNT(*) AS row_count
FROM exercise_items
WHERE task_type = 'sentence_output'
  AND json_type(answer_json, '$.meaning') = 'text'
UNION ALL
SELECT 'lesson_tasks_legacy_s5' AS finding, COUNT(*) AS row_count
FROM lesson_tasks
WHERE task_type = 'sentence_output'
  AND json_type(answer_json, '$.meaning') = 'text'
UNION ALL
SELECT 'exercise_items_legacy_s1_s2_meaning_contains_word_review_required' AS finding,
       COUNT(*) AS row_count
FROM exercise_items AS item
INNER JOIN words ON words.id = item.word_id
WHERE item.task_type IN ('recall_word', 'multiple_choice')
  AND json_type(item.answer_json, '$.meaning') = 'text'
  AND instr(
    lower(COALESCE(json_extract(item.prompt_json, '$.meaning'), '')),
    lower(words.word)
  ) > 0
UNION ALL
SELECT 'lesson_tasks_legacy_s1_s2_meaning_contains_word_review_required' AS finding,
       COUNT(*) AS row_count
FROM lesson_tasks AS task
INNER JOIN words ON words.id = task.word_id
WHERE task.task_type IN ('recall_word', 'multiple_choice')
  AND json_type(task.answer_json, '$.meaning') = 'text'
  AND instr(
    lower(COALESCE(json_extract(task.prompt_json, '$.meaning'), '')),
    lower(words.word)
  ) > 0;
```

最后一项是保守候选集，仍需使用与服务端相同的 Unicode whole-token 规则复核，不能把普通子串命中直接当成泄漏结论。

### 5.4 迁移后仍未关联的历史日志

```sql
SELECT COUNT(*) AS unresolved_review_log_count
FROM review_logs
WHERE task_id IS NULL;
```

结果大于 0 时，历史报告完整性不能验收通过。不得为消除阻断而猜测关联。

## 6. 必须由用户确认的处理分支

### 分支 A：目标 D1 不存在旧版行

若审计中旧版题目、退化 S3/S4、旧 S5、答案泄漏候选和未关联日志均为 0，可移除此冲突阻断，继续 preview 验收。

### 分支 B：接受“持久化不变、运行时按新交互适配”

适用于只存在可确定映射的旧题。需要明确接受旧 S0/S4/S5 的交互或评分可能与旧服务实现不同，并在隔离 preview 逐条验证历史 course 与 started lesson。

### 分支 C：要求旧交互和评分完全不变

需要另立计划实现显式 `legacy_v1` 判别、旧提交契约、旧评分器、旧 renderer 与迁移 E2E。该方案会扩展当前冻结的六类交互契约，不纳入 PLAN_0713 的隐式修改范围。

## 7. 解除阻断的验收标准

同时满足以下条件后才能关闭本报告：

1. 在明确目标 D1 上完成只读审计并保存脱敏计数证据。
2. 用户明确选择 A、B 或 C，不由实现者静默代选。
3. 若选择 B，所有命中的历史 course、started lesson 和 S0-S5 在隔离 preview 通过恢复、提交、刷新和报告验证。
4. 若选择 C，新的独立计划、契约和回归矩阵已获确认并完成。
5. 任一方案都不得原地修改 published content 或重新生成历史 lesson task snapshot。
