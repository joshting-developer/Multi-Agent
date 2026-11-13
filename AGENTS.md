# 專案工作規範

## TaskTracker 是本專案的工作紀錄來源

使用者已要求：之後所有工作都必須在 TaskTracker 交代。功能、Bug、UI、研究、文件、依賴、測試及交付都適用；以可驗收的工作目的建立卡片, 細節記錄在描述／留言, 不需要為每次讀檔另開卡

例行 commit／push 等日常 Git 操作不另開卡。先查詢有無既有對應工項；有則更新成果, 符合該卡驗收條件才結案。不要因為提交或推送成功, 就關閉仍未完成的功能或公開發行工項

- 網站：`http://localhost:5174`；工作區：`SideProject`
- 專案：[Multi-Agent／MA](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b), Project ID `796d764a-e7fb-4eb2-a99d-8b7cc249b98b`
- 看板：[看板列表](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b/boards) 依主要驗收目的分 11 個主題看板, 每張 Task／Bug 只收進一個, 新卡依看板簡述歸類；[里程碑總覽](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b/board/f122abb0-d322-474e-bcb1-158963ac1029) 收全部 Epic, 依 Epic 看進度。未完成項目以目前卡片及 v0.2 規格為準

### 帳號與工具

操作方式統一用共用 Skill [task-tracker-usage](/Users/josh/workspace/side-project/skills/01-common/task-tracker-usage/SKILL.md) 的公開 PAT CLI, 每個 Agent 用自己的帳號：

```bash
TT_CLI=/Users/josh/workspace/side-project/skills/01-common/task-tracker-usage/scripts/tasktracker_api.py
python3 $TT_CLI --agent claude todos --state open
python3 $TT_CLI --agent claude notifications
python3 $TT_CLI --agent claude --project MA list --state open
python3 $TT_CLI --agent claude --project MA --issue MA-79 get
python3 $TT_CLI --agent claude --project MA --issue MA-79 claim
```

- Claude 帶 `--agent claude`, Codex 帶 `--agent codex`；同一次工作的 list／claim／status／comment 都用同一個 Agent。完整命令用 `--help` 查
- 憑證放在共用庫被 Git 忽略的 `.private/tasktracker/<agent>.json`, 不要抄進本專案、卡片、日誌或安裝包
- 2026-11-14 確認：claude 已是 MA 專案成員, codex 還不是。Codex 看不到 MA 時停下來回報, 請 Josh 加權限, 不要改用別人的帳號、Owner 或舊的 Multi-Agent 帳號
- 舊工具 `npm run tracker`（[scripts/tasktracker.mjs](scripts/tasktracker.mjs), 走 session／CSRF RPC, 登入資料在 `.local/tasktracker.json`）和 **Multi-Agent** 專用帳號不再用於新工作, 只保留到 `MA-79` 收尾。既有指派給 Multi-Agent 的歷史卡片不用改；之後誰開工就指派給誰
- TaskTracker 無法連線或拒絕操作時, 保留待同步內容並回報阻礙, 不宣稱已更新。禁止直接寫 TaskTracker 資料庫或繞過權限；沒有另行要求時不擅自修改 TaskTracker 功能

### 卡片流程

claim、狀態、留言、待驗收、小待辦、分類與工時都照 task-tracker-usage 及它的 [分類與工時](/Users/josh/workspace/side-project/skills/01-common/task-tracker-usage/references/classification-and-time.md) 執行, 這裡只補本專案的規則：

1. 開工前先看 `todos` 和 `notifications`, 有交辦先處理。新需求先查重再建卡, 填目標、範圍、來源及驗收條件；沒開工的卡保持 `open` 未指派
2. 真的動手才 `claim`, 同一個 Agent 同時只留一張 `inprogress`。新 Bug 用 Bug；功能／研究／文件用 Task；里程碑用 Epic 並正確連結
3. 途中把重要決策、範圍變動、驗證證據及後續問題留言到卡片。真正卡關用 `blocked`, 註明原因、等待對象及解除條件
4. 做完且需要 Josh 認可（視覺、驗收、決策）的卡改 `review`, 留言寫清楚做了什麼、實測、commit 和要確認什麼；Josh 認可才 `closed`。部分完成的 Epic 不得關閉, 不以預留介面或 mock 當完成
5. 預估與實際工時用正式欄位填, 不以留言數字代替；缺介面就明記未填及原因
6. 回覆使用者前確認狀態已寫回, 附上卡號或連結

## Skill 來源

使用者 2026-11-12 已取代原本「只用專案內 `skills/`」的規則, 改用 Side Project 共用庫：`/Users/josh/workspace/side-project/skills`（換機可用 `SIDE_PROJECT_SKILLS_ROOT` 指定）

- 開工先讀共用庫的 [README](/Users/josh/workspace/side-project/skills/README.md)、[PROJECT-BASELINE](/Users/josh/workspace/side-project/skills/PROJECT-BASELINE.md) 及 [registry.json](/Users/josh/workspace/side-project/skills/registry.json), 再依本次任務挑需要的 Skill, 不要全部載入
- 選 Skill 用共用庫的選擇工具, 有間接畫面或資料影響就加 `ui`／`data-access` 標籤；標籤只能加門檻, 不能拿來略過：

  ```bash
  python3 /Users/josh/workspace/side-project/skills/tools/select_skills.py --consumer . --base HEAD --tag implementation
  ```

- 所有開發／review／重構／測試都用 `01-common/side-project-development-standards`；Vue 用共用庫的 `03-frontend/vue-best-practices`, UI／效能依 registry 選讀
- 跨專案規則直接讀 common-skills 原檔：寫給人看的中文文字（docs、卡片描述／留言、給使用者的回覆）前讀 [josh-writing-style](/Users/josh/workspace/common-skills/josh-writing-style/SKILL.md)；commit 或 PR 文字前讀 [commit-without-ai-attribution](/Users/josh/workspace/common-skills/commit-without-ai-attribution/SKILL.md)
- 缺共用庫或連結失效要回報, 不靜默改用全域同名 Skill。Skill 內的來源／沿革紀錄不代表授權載入其他專案的規範
- 專案內 `skills/` 只放本專案專用的 Skill, 目前只有 [quiet-workspace-ui](skills/quiet-workspace-ui/SKILL.md)；通用規則不要再複製進來

## Git

- Git 操作前先讀 `/Users/josh/workspace/piextract/skills/01-common/git-delivery-workflow/SKILL.md` 的「Git 工作位置（所有專案）」一節, 只套用這一節；直接在原 repository 操作, 保護使用者既有修改
- 卡片的 commit 訊息格式為 `<卡號> <卡片標題>`, 例如 `MA-26 拆分 Conversation、Participant、Message 與原生 Session 關聯`；一張卡分多次提交時沿用同一格式。無卡的規範整理用繁中 Conventional Commits
- Commit 不帶任何 AI 署名, 規則依 commit-without-ai-attribution, 優先於工具預設
- 不自行 amend、squash、改寫歷史或 push

## 前端介面

修改或新增 Webview UI 時, 先讀並套用 [quiet-workspace-ui](skills/quiet-workspace-ui/SKILL.md)。本專案明確避免冗餘的操作教學、空狀態填充及常駐技術說明。Vue 實作依共用庫的 vue-best-practices, 使用者明確要求優先於 Skill
