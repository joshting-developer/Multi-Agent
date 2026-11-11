# Multi-Agent Workspace · 0.1.4

在 VS Code 右側聊天分頁使用官方本機 Claude Code / Codex，沿用既有登入。TypeScript、Vue 3、SQLite；不用另外提供 API Key。

目前為個人本機版本，正式方向以 [v0.2 規格](Multi_Agent_AI_Workspace_SPEC_v0.2.md) 為準。[功能里程碑](docs/roadmap.md)

## 安裝使用

1. 安裝官方 CLI，分別完成 `claude auth login`、`codex login`；只使用其中一個也可以。
2. VS Code Extensions → `…` → **Install from VSIX…**，選擇 `multi-agent-workspace-0.1.4.vsix`，重新載入視窗。
3. 用 **Open Folder** 開啟單一本機資料夾並信任它。執行 `Multi-Agent: Open Chat`，或點右側 **Multi-Agent** 分頁。
4. 首次使用授權工作區的資料分類與 Provider。
5. 在輸入框選擇 Agent、明確的模型與推理強度，以及檔案權限與核准模式。Enter 送出、Shift+Enter 換行；執行中可按 Stop。

頂部時鐘圖示開啟**歷史對話**，可搜尋標題和訊息內容、重新開啟續聊、重新命名或刪除；新增圖示建立獨立對話。

齒輪開啟完整設定頁：**一般／Agent 與模型／工作區與資料／帳號**。帳號頁顯示 CLI 提供的電子郵件、登入方式、方案與組織；未提供的欄位不會猜測。切換官方 CLI 帳號後重新整理。

## 模型與核准

模型和推理強度沒有「預設」選項；每次任務會擷取並傳入實際顯示的值。首次載入 Codex 清單時會選定一個具體模型；清單失敗且未選模型時不執行，可以重試或在設定輸入 ID。Claude 的官方別名明確標示「別名」。[資料來源](docs/models.md)

| 核准模式 | Codex | Claude Code |
| --- | --- | --- |
| 要求核准 | 官方 `on-request`；額外權限以聊天卡片核准／拒絕 | 官方 Manual；需要確認的工具以聊天卡片核准／拒絕 |
| 代我核准 | 官方 `auto_review` reviewer | 官方 `auto` 模式 |
| 完整存取 | 官方完整存取 profile | 官方 `bypassPermissions` |

完整存取第一次執行會顯示原生確認，授權限本次視窗。**唯讀仍為唯讀**，不因核准模式擴大權限。自動核准依 CLI、模型、帳號與組織政策決定是否可用；失敗不自動切換成完整存取。普通工作區操作不一定需要核准。

Codex 透過官方 App Server 的 thread / turn / delta / approval 執行。Claude 透過官方 stream-json 控制協定執行；可編輯時提供檔案及 Bash 工具。MCP、自訂 hooks 與自動多 Agent 功能尚未啟用。具體權限邊界見 [security](docs/security.md)。

## 歷史資料

- SQLite 位於 VS Code `globalStorageUri/conversations.sqlite`，資料依 canonical workspace 路徑隔離。資料庫不放進 Git 專案。
- 自動遷移原本 workspaceState 保留下來的紀錄；原資料保留作遷移前備份。舊版已修剪掉的紀錄無法還原。
- 對話不再以 60 筆或 2 MB 刪除舊資料；每個任務輸出仍限 512 KB。開始／完成時立即保存，串流中每 500ms 合併保存。
- 搜尋目前採 SQLite 標題／訊息子字串比對，支援中文及英文錯誤碼；尚未實作 FTS5、語意搜尋與跨專案搜尋。
- 原生 Session ID 記錄在任務中；續聊目前重播同對話、同 Provider 最近 6 筆完成訊息的有限上下文，未承接官方完整 Session resume。
- 本機資料為明文。刪除對話會刪除相關 run；不會刪除官方 CLI 的歷史或登入。

## 開發

需要 VS Code Desktop 1.95+、Node.js 22.12+，主要驗證平台 macOS。VS Code 1.106 前使用 Activity Bar fallback。

```bash
npm ci
npm run build
npm run lint
npm test
npm run test:host
npm run test:models
npm run test:approvals
npm run package:vsix
```

`test:models`／`test:approvals` 使用官方帳號少量額度及隔離合成資料；`test:host` 暫時啟動隔離 VS Code。可用 `VSCODE_EXECUTABLE` 指定執行檔。開發時按 F5 選 `Run Multi-Agent Extension`。

CLI 路徑自動尋找 PATH、`~/.local/bin`、Homebrew 及官方 Codex 插件 binary；也可於設定「進階」指定絕對路徑。實測 Claude 2.1.319、Codex 0.164.0-alpha.11.1；版本／能力不足會報錯。

目前不支援多資料夾、Remote SSH、Dev Containers 或 VS Code Web。獨立 Participant 討論、原生 Session 恢復、工程記憶與 Auto Work 尚未實作。[測試紀錄](docs/testing.md)、[架構](docs/architecture.md)、[UI skills](skills/README.md)


## 專案工作追蹤

本專案以 [TaskTracker／Multi-Agent](http://localhost:5174/#/projects/796d764a-e7fb-4eb2-a99d-8b7cc249b98b) 管理已完成與待辦工項。後續工作須先建／認領卡片，再更新狀態、決策及驗證結果；規則見 [AGENTS.md](AGENTS.md)。

例行 commit／push 不另開卡，已有對應工項時更新該卡。

使用 `npm run tracker -- list` 查詢；`get`、`create`、`update`、`comment` 的用法見 AGENTS。工具使用本機私有設定 `.local/tasktracker.json` 的專用 Developer 帳號，設定檔不提交、不打包。這是既有 session RPC 的暫時客戶端，正式 API／Webhook 由 TaskTracker 後續補齊。
