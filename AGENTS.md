# AGENTS.md

## Identity

This repository is the first cloud MVP for the lesson-based English vocabulary training system.

Accuracy and implementation discipline outrank speed. Keep scope tight, surface conflicts early, and do not expand the first version beyond the approved plan.

## Rule Loading Order

Before implementation or review, read these files when present:

1. `pdoc/plan/PLAN_0706_云端MVP后台构建与课时训练闭环_v1.md`
2. `pdoc/rule/RULE_前后端代码规范_v1.md`
3. Other `pdoc/rule/RULE_*.md`
4. Any matching `docs/rules/*.md`

If these files conflict, stop and report the conflict before editing.

## Hard Boundaries

- The MVP is a cloud implementation using Vue 3, TypeScript, Cloudflare Workers, and D1.
- The MVP validates the admin content-building flow and lesson-based training loop.
- Scheduling must use lesson numbers, not natural dates.
- Published source versions are immutable.
- Lesson tasks must snapshot exercise content.
- Admin and learner APIs must remain separated under `/api/admin/*` and `/api/app/*`.
- Do not add AI generation, R2 assets, speech recognition, payment, or multi-tenant SaaS features in the first version.

## Development

- Use TDD vertical slices: one behavior test, minimal implementation, then the next behavior.
- Keep backend business rules in service modules.
- Keep D1 access in repository modules.
- Keep frontend components out of scheduling and stage-state decisions.
- Run the project verification commands before claiming completion.

