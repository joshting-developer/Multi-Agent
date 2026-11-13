# 架構與目前範圍

正式產品基準為 [v0.2 規格](../Multi_Agent_AI_Workspace_SPEC_v0.2.md)。0.1.4 完成單 Agent 對話的歷史基礎、官方核准與帳號資訊，尚未實作獨立 Participant 討論。

| 模組 | 責任 |
| --- | --- |
| Vue Webview | 聊天、模型／強度、核准卡片、歷史搜尋／切換、帳號與設定 |
| Typed IPC / Controller | Zod 驗證、請求關聯、原生工作區授權、完整存取確認、刪除確認 |
| Orchestrator | 單一執行者、對話切換鎖、Provider 資料政策、有限歷史上下文、核准等待／取消 |
| AgentAdapter | 官方 CLI 的能力偵測、登入與帳號、模型／權限映射、事件及完成狀態 |
| ProcessManager | argv + stdin、程序樹取消、逾時、輸出上限及清理 |
| SettingsService / Catalog | VS Code 設定、模型探索、支援強度驗證 |
| SessionRepository / ConversationDatabase | 舊紀錄遷移、SQLite 交易、歷史、搜尋、interrupted recovery |

## 官方引擎

Codex 的產品執行路徑使用 `CodexAppServerAdapter`，透過本機 stdio 的官方 App Server 執行 initialize → thread/start → turn/start，承接文字 delta 與互動核准。`approvalsReviewer=auto_review` 使用官方審查者；不以 Extension 自己的一般模型假扮審查。原 `CodexAdapter` 的非互動 exec 實作保留為底層相容性及獨立測試用途。

Claude 使用官方 stream-json 輸入／輸出與 control_request/control_response；`--permission-prompt-tool stdio` 為官方 SDK 使用的核准傳輸通道。Manual / auto / bypassPermissions 對應核准模式。只讀時不提供寫入與 Bash 工具。

每次執行建立隔離的原生任務，Session ID 保存在 run；產品 Conversation ID 與原生 ID 分開。續聊透過目前對話／Provider 的有限歷史重播，不自動跨 Provider 傳遞上下文，不宣稱已承接原生完整 resume。

帳號來自 Codex `account/read` 或 Claude `auth status`，只選取公開的身分欄位。Extension 不讀認證檔、不保存 Token。帳號只送至設定 Webview，不寫入聊天資料庫。

## SQLite

使用 sql.js 的 SQLite WASM，避免 native addon 的 Electron／Node ABI 問題；WASM 隨 VSIX 打包。資料庫存於 Extension `globalStorageUri`，所有對話與政策依 workspace canonical root 隔離。

目前 schema version 4：`conversations`、`runs`、`metadata`、`participants`、`messages`、`discussion_rounds`、`discussion_summaries`。Run 保存完整使用者／Agent 訊息、模型、強度、核准模式、狀態及原生 Session 參照；`participants` 以各自 ID 保存 Provider、Role 與原生 Session，`messages` 每個 Run 各有一筆 user／agent 訊息，ID 建立後不變。未指定 Participant 的 Run 歸到該 Provider 的 `solo` Participant；指定時以 `architect`／`critic` 角色保存，同一 ID 不得改綁 Provider 或角色。Orchestrator 只回放同一 Participant 的歷史並帶入角色指示，每次只執行一方，不自動啟動另一方。`DiscussionCoordinator` 是唯一建立討論輪次的地方：兩方依序唯讀發言，只轉交上一輪可見輸出；每輪以 `discussion_rounds` 保存 roundNo、senderParticipantId、runId、messageId。討論期間 Orchestrator 拒絕一般送出與切換對話，失敗或取消時停止並保留已完成回合。回合上限由 Coordinator 以程式強制：開始 2–8 輪，延長只能由使用者對已完成的討論操作且總計不超過 8 輪；每次發言（含失敗）計入呼叫預算，每次開始或延長另保留 1 次總結。正常完成後由新的中立 summarizer Participant 唯讀總結，只拿到各輪可見輸出並標明 A／B 與輪次；`discussion_summaries` 記錄總結訊息與涵蓋到的輪次，來源可經 `discussion_rounds` 回溯。結論只能由使用者帶入輸入框後自行送出，不會自動寫程式。某輪遇到額度用完或頻率受限時（Adapter 以 `ProviderFailure.kind` 區分 quota／rate-limit），討論進入等待決定並保持鎖定：頻率受限可重試；可改由另一個已授權、可用的 Provider 以新的代替 Participant 接手該角色，交給它目前為止的可見對話；或結束。10 分鐘未決定視同結束。失敗的那次保留紀錄但不占用輪次，不自動代替。Stop 中止當輪子程序群組，回合之間按下也會阻止後續回合。跨 Agent 討論（例如 Claude 提案、Codex 審查）開始前逐一檢查每個 Provider 的工作區授權，一方獲准不代表另一方；不允許時說明原因並指出可用的單 Agent。每輪送出時仍重新檢查，回合之間撤銷授權會讓討論停止。每個 Participant 使用自己 Provider 的模型與強度。v1 開啟時依既有 Run 回填，原 `task_json` 不變。資料庫新版本不會被舊插件降版。

WASM 模式採 SQLite 交易後原子匯出單檔，短生命週期寫入鎖避免其他視窗覆蓋不同對話；可回收已退出程序的舊鎖。這不是 native WAL 設計。大規模歷史的效能、備份及 native WAL／FTS5 是後續工作。

目前搜尋是參數化 SQL 的子字串查詢；中英文字面查詢已測試。打包的 sql.js 沒有 FTS5，評估與啟用條件見 [全文索引評估](research/fts-search.md)。日期／Provider 篩選、FTS5、工程記憶與來源引用依 v0.2 後續里程碑增加。

## UI

保留 VS Code Secondary Sidebar 原生分頁，VS Code 1.106 前有 Activity Bar fallback。齒輪設定使用獨立 Vue 編輯分頁。

依 [quiet-workspace-ui](../skills/quiet-workspace-ui/SKILL.md)，常用介面顯示工作、選項及結果；不加填充式空狀態、重複操作教學。CLI 路徑、版本、模型來源、自訂 ID 放展開區。保留實際錯誤、必要欄位限制與高影響操作確認。
