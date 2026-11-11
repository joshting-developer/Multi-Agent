# 專案工作規範

## TaskTracker 是本專案的工作紀錄來源

使用者已要求：之後所有工作都必須在 TaskTracker 交代。功能、Bug、UI、研究、文件、依賴、測試及交付都適用；以可驗收的工作目的建立卡片，細節記錄在描述／留言，不需要為每次讀檔另開卡。

例行 commit／push 等日常 Git 操作不另開卡。先查詢有無既有對應工項；有則更新成果，符合該卡驗收條件才結案，沒有就直接執行。不要因為提交或推送成功，就關閉仍未完成的功能或公開發行工項。

- 網站：`http://localhost:5174`；工作區：`SideProject`。
- 專案：[Multi-Agent／MA](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b)。Project ID：`796d764a-e7fb-4eb2-a99d-8b7cc249b98b`。
- 專用帳號：`multi_agent@example.com`。工作區一般成員，僅 Multi-Agent 專案的 Developer；不要改用 Owner 或自行放大權限。
- Agent 承擔的 Epic／Task／Bug，包含匯入的已完成項目及待辦，負責人預設為 **Multi-Agent** 專用帳號，不是建立者 Josh。Josh 保留產品／專案 Owner 身分；只有使用者明確指定由人執行的工項才指派 Josh。不要以建立者或專案 lead 自動推定卡片負責人。
- 本機私有登入設定：`.local/tasktracker.json`，目錄 0700、檔案 0600；`.local/` 已排除版本控制。密碼、session、Token 不得放在 AGENTS、卡片、一般日誌或安裝包。
- 找不到登入資料時，先讀取[本機私有設定](.local/tasktracker.json) 的 `email` 與 `password` 欄位；此檔案就是目前專用 Developer 的登入資料來源，不需要猜密碼或向 Owner 借用帳號。設定檔不存在時才請使用者提供，不將真實密碼抄入受版本控制的範本。

工作流程：

1. 開始前查詢既有工項，確認需求與目前狀態；新需求先建卡並填目標、範圍、來源及驗收條件，避免重複卡片。
2. 實際開始才轉 `inprogress`（進行中）；未開始用 `open`（待辦），不是因為有需求就標進行中。
3. 實作途中把重要決策、範圍變動、驗證證據及後續問題寫入卡片。新 Bug 用 Bug；功能／研究／文件用 Task；里程碑用 Epic 並正確連結。
4. 真正卡關時用 `blocked`（受阻），註明原因、等待對象及解除條件；待人工驗收用 `review`（待驗收）。部分完成的 Epic 不得關閉。
5. 完成後記錄實際改動、測試命令與結果、交付物及限制，再轉 `closed`（已完成）。未通過驗收或尚待完成的工作保留待辦，不以預留介面或 mock 當完成。
6. 回覆使用者前確認狀態已寫回，提供工項編號／連結。沒有實際工時與期限依據時不填造實績或日期。

目前有 [里程碑總覽](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b/board/3c976a6d-580f-49d0-bd38-a08648f42646) 與 [M2 討論 MVP](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b/board/01669d16-4eed-448e-a6b8-dcba4da63262) 看板。未完成項目以目前卡片及 v0.2 規格為準，先推進 M2。

暫時使用既有 session／CSRF RPC 的本機工具：

```bash
npm run tracker -- list
npm run tracker -- get MA-78
npm run tracker -- create /path/to/issue.json
npm run tracker -- update MA-78 /path/to/update.json
npm run tracker -- comment MA-78 /path/to/comment.json
```

JSON 輸入檔也可用 `-` 從 stdin 讀取。更新自動先讀目前 revision；若自行帶 revision，衝突時不覆蓋。建立時可提供固定 `requestId`，遇到不確定結果先讀回核對，以同一識別重送，避免重複建卡。工具限定此專案，使用受限帳號，執行後登出。

TaskTracker 無法連線或拒絕操作時，保留待同步內容並回報阻礙，不宣稱已更新。禁止直接寫 TaskTracker 資料庫或繞過權限。正式外部 API／Webhook 的缺口交接於 TaskTracker 根目錄 `Multi-Agent-To-Tracker.md`，本專案對應 `MA-79`；沒有另行要求時不擅自修改 TaskTracker 功能。

## Git Workspace Rules — All Projects

Before Git operations in any project, read and apply the “Git 工作位置（所有專案）” section in `/Users/josh/Projects/workspace/skills/git-delivery-workflow/SKILL.md`. The shared skill owns repository-location rules.

## 前端介面

修改或新增 Webview UI 時，先閱讀並套用 [quiet-workspace-ui](skills/quiet-workspace-ui/SKILL.md)。此專案明確避免冗餘的操作教學、空狀態填充及常駐技術說明。

Vue 實作沿用 [vue-best-practices](skills/vendor/vue-best-practices/SKILL.md)。使用者明確要求優先於 skill。
