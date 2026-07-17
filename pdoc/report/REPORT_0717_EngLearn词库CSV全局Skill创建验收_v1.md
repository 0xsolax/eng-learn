# REPORT_0717_EngLearn词库CSV全局Skill创建验收_v1

## 1. 文档信息

- 项目：eng-learn
- 文档类型：Skill 创建与验收报告
- 报告版本：v1
- 状态：全局安装与本地验收完成
- 日期：2026-07-17
- 修改人：Solazhu
- 负责人：Solazhu
- 操作人：Solazhu
- 执行依据：当前会话 `/goal`、`pdoc/plan/PLAN_0717_三层语境与学习阶段递进优化_v1.md`
- 安装位置：`/Users/solazhu/.agents/skills/build-eng-learn-word-csv`
- 未执行：生产数据导入、远端 Cloudflare 操作、应用代码修改

## 2. 交付结论

已创建全局 Skill `build-eng-learn-word-csv`。它接收用户提供的英文单词列表，为每个单词补全中文释义、短语、基础句、扩展句和词性，并输出应用当前可导入的六列 CSV：

```text
word,meaning,examplePhrase,exampleSentence,exampleSentenceExtended,partOfSpeech
```

Skill 只安装在全局共享目录 `~/.agents/skills`。初始化过程中误建在 `~/.codex/skills` 的未完成骨架已经删除，最终不存在 Codex 专用副本。

## 3. Skill 结构

```text
build-eng-learn-word-csv/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/
│   └── csv-contract.md
└── scripts/
    └── build_word_csv.py
```

- `SKILL.md`：规定单词解析、义项选择、三级语境生成、校验和交付流程。
- `csv-contract.md`：冻结六列表头、字段语义、应用限制、整词匹配和递进语境规则。
- `build_word_csv.py`：确定性校验 JSON 行并输出带 UTF-8 BOM、CRLF 和 RFC4180 转义的 CSV。
- `openai.yaml`：提供全局 Skill 的显示名称、说明和默认调用提示。

## 4. 关键规则

1. 保留用户输入顺序，不静默新增、删除、合并、纠错或重排单词。
2. 每个词只选择一个适合初学者的义项和词性，三级语境不得改变义项。
3. 多义词默认采用最常用的初级义项，并在交付摘要中列为人工复核项。
4. `examplePhrase`、`exampleSentence`、`exampleSentenceExtended` 都必须包含目标词的完整独立词元。
5. `meaning` 不得包含目标英文词，避免 S1/S2 直接泄露答案。
6. 三段语境不得重复；长度递进以生成指导和警告实现，不用词数硬拒绝合法表达。
7. Skill 生成时要求填写 `partOfSpeech`，但不伪造应用不存在的词性枚举。
8. 未识别词或疑似拼写错误必须先向用户确认，不允许编造。

## 5. 验证结果

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| Skill 结构 | 通过 | `quick_validate.py` 返回 `Skill is valid!` |
| Python 语法 | 通过 | `python3 -m py_compile scripts/build_word_csv.py` |
| 全局安装一致性 | 通过 | 暂存成品与 `~/.agents/skills` 全局副本 `diff -ru` 无差异 |
| 安装边界 | 通过 | `~/.codex/skills/build-eng-learn-word-csv` 不存在 |
| 正常与 RFC4180 内容 | 通过 | 4 行样例含中文、重音字符、逗号和双引号，成功生成 402 字节 CSV |
| BOM 与 CRLF | 通过 | 字节检查以 `EF BB BF` 开头，表头末尾为 `0D 0A` |
| 重复与整词边界 | 通过 | `Apple/apple`、`he/hero`、目标词缺失均被拒绝并指出行与字段 |
| 答案泄露 | 通过 | 中文释义中出现目标英文完整词元时被拒绝 |
| 必填与长度 | 通过 | 空词性、121 长度单词分别被拒绝 |
| 行数边界 | 通过 | 500 行成功；501 行被拒绝 |
| 文件边界 | 通过 | 338,544 字节输出被 256 KiB 门禁拒绝 |
| 防覆盖 | 通过 | 目标文件已存在时默认拒绝；仅显式 `--force` 允许覆盖 |
| 递进提醒 | 通过 | 非严格增长样例成功生成但返回明确复核警告 |
| 应用真实解析 | 通过 | 当前 `parseAdminCsv` 与原 CSV 回归共同执行，2 files / 13 tests 通过 |
| 自应用 | 通过 | `apple/watch/bank/light/run` 生成 5 行，零结构警告，并通过应用解析器 |

`quick_validate.py` 所需的 `PyYAML` 仅安装在 `/tmp` 临时验证目录，没有修改项目依赖或全局 Python 环境。

## 6. 风险边界

- 脚本可以确定性校验格式、长度、重复、整词匹配和构建所需的基础结构，无法机械证明三句话语义完全一致；该项由 Skill 生成流程和人工复核清单共同控制。
- 一到两行 CSV 可以导入，但应用无法为多项选择构造至少两个干扰项；脚本会警告，不会伪造额外单词。
- 应用 CSV 契约若再次变化，必须同步修改 `references/csv-contract.md` 与 `scripts/build_word_csv.py`，重新执行结构、边界和应用解析验证。
- 本次未上传任何词库、未写入 D1，也未修改应用运行时代码。

## 7. 最终决策

- 全局 Skill 创建：通过。
- 六列 v2 CSV 契约：通过。
- 三级语境生成流程：通过。
- 确定性格式与边界校验：通过。
- 应用解析兼容：通过。
- 全局安装且无 Codex 专用副本：通过。
