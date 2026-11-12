---
name: git-workspace
description: Multi-Agent 專案的 Git 工作位置規則：在原 repository 切換分支、修改與交付，不在 /private 或暫存目錄建立 clone／worktree。Use before any Git operation in this project, including branch switching, comparison, commit, and push.
---

# Git Workspace

本專案的 Git 工作位置規則。commit 訊息格式、卡片狀態與禁止 AI 署名等規則由根目錄 `AGENTS.md` 擁有，本 skill 不重複規定。

## 工作位置

- 直接在本專案既有的 repository（`/Users/josh/Projects/workspace/SideProjects/Multi-Agent`）切換分支、整合、修改與交付。
- 禁止在 `/private` 下進行 Git 操作或建立 clone／worktree，包括 `/private/tmp`、`/private/var`，以及解析後指向這些位置的 `/tmp` 或其他別名路徑。也不要為了切換分支或避開原專案限制，在其他暫存目錄另建 clone／worktree。
- 操作前確認 repository 根目錄、目前 branch 與 dirty state；切換時保護使用者既有修改，只 stage 明確路徑。
- 分支被其他 worktree 占用時，在原專案檢查 `git worktree list` 與占用資訊，確認資料保留方式後在原專案處理；不可直接忽略占用限制、強制移除工作區，或改到 `/private` 繼續操作。
- 原專案因 sandbox 或權限限制無法操作時，針對原路徑申請必要權限，不搬到暫存工作區繞過限制。
- 比對其他分支優先在原專案用 `git show`、`git diff`、`git log` 或 `git range-diff`，不為唯讀比對建立另一份 checkout。
