# 專案 skills

已從 TaskTracker 複製 `vendor/vue-best-practices` 完整原文、references 和 MIT LICENSE。
來源：https://github.com/vuejs-ai/skills，固定 commit `198f0cd8f7f9c0a3d9b566ccc16de6677519ee78`。
採 Vue 3 Composition API、TypeScript、props/emits 與聚焦的 composables。原始 SPEC 優先於 skill。
未安裝全域 skill，未引入 Laravel 或無關設計流程。

## 介面文案與資訊層級

[quiet-workspace-ui](quiet-workspace-ui/SKILL.md) 為本專案撰寫，已在根目錄 AGENTS.md 列為 Webview UI 工作規範。

已閱覽 TaskTracker 的 Taste Skill、UI UX Pro Max 與 Unslop。Taste 的 Components 規則已要求控制項自行表達操作，app-screens §4.3 也反對介紹介面的副標；但其空狀態規則仍會放說明句，因此另補本專案的留白、刪除填充文字與技術細節逐步揭露要求。沒有修改或安裝 TaskTracker／全域 skills，也沒有引入整套行銷頁風格流程。

## Git 工作位置

[git-workspace](git-workspace/SKILL.md) 是專案內的改寫副本，只取共用 skill `git-delivery-workflow` 的「Git 工作位置（所有專案）」一節（2026-11-12 複製；來源 `/Users/josh/Projects/workspace/skills` commit `9fe7948`，SKILL.md SHA-256 `ef6bb8e8a5ad0ffc1a36d418a2c1f554402bf192a48f0f98f1959ef29f975c5f`）。改寫內容：移除 CLM 專案名稱並固定為本專案路徑。未複製其餘 CLM 專用的 commit、MR、Jest pipeline 與分支封存規則；本專案 commit 格式以根目錄 AGENTS.md 為準。共用來源後續變更不會自動套用。
