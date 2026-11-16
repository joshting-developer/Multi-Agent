# 架構與目前範圍

正式產品基準為 [v0.2 規格](../Multi_Agent_AI_Workspace_SPEC_v0.2.md)。0.1.4 完成單 Agent 對話的歷史基礎、官方核准與帳號資訊，尚未實作獨立 Participant 討論。

| 模組 | 責任 |
| --- | --- |
| Vue Webview | 聊天、模型／強度、核准卡片、歷史搜尋／切換、帳號與設定 |
| Typed IPC / Controller | Zod 驗證、請求關聯、原生工作區授權、完整存取確認、刪除確認 |
| Orchestrator | 單一執行者、對話切換鎖、Provider 資料政策、有限歷史上下文、核准等待／取消 |
| AgentAdapter | 官方 CLI 的能力偵測、登入與帳號、模型／權限映射、事件及完成狀態 |
| ProcessManager | argv + stdin、程序樹取消、輸出上限及清理；一般任務不限時間，只有偵測、模型、額度等短查詢有逾時（MA-132） |
| SettingsService / Catalog | VS Code 設定、模型探索、支援強度驗證 |
| SessionRepository / ConversationDatabase | 舊紀錄遷移、SQLite 交易、歷史、搜尋、interrupted recovery |

## 官方引擎

Codex 的產品執行路徑使用 `CodexAppServerAdapter`，透過本機 stdio 的官方 App Server 執行 initialize → thread/start → turn/start，承接文字 delta 與互動核准。`approvalsReviewer=auto_review` 使用官方審查者；不以 Extension 自己的一般模型假扮審查。原 `CodexAdapter` 的非互動 exec 實作保留為底層相容性及獨立測試用途。

Claude 使用官方 stream-json 輸入／輸出與 control_request/control_response；`--permission-prompt-tool stdio` 為官方 SDK 使用的核准傳輸通道。Manual / auto / bypassPermissions 對應核准模式。只讀時不提供寫入與 Bash 工具。

一般聊天保留官方原生 Session（Claude 不加 `--no-session-persistence`、Codex 非 ephemeral thread），下一輪同 Provider 以 Claude `--resume`／Codex `thread/resume` 接續，只送這次的訊息，task 標記 `contextMode: native`。原生 Session 不存在、Provider 不支援，或歷史中有使用者不採用的回答時，改由 SQLite 上下文重建並標示「上下文已重建」，不假裝原生恢復。討論與總結一律一次性，不保留也不接續原生 Session。Session ID 保存在 run 與 Participant；產品 Conversation ID 與原生 ID 分開，不跨 Provider 傳遞上下文。保留的原生 Session 存在官方 CLI 自己的目錄（`~/.claude/projects`、`~/.codex/sessions`），Extension 不讀取其內容。

帳號來自 Codex `account/read` 或 Claude `auth status`，只選取公開的身分欄位。Extension 不讀認證檔、不保存 Token。帳號只送至設定 Webview，不寫入聊天資料庫。

多帳號：每個帳號都有 Extension 儲存區 `accounts/<id>` 下自己的官方 CLI 設定目錄（Claude `CLAUDE_CONFIG_DIR`、Codex `CODEX_HOME`，權限 0700），由官方 CLI 在 VS Code 終端機完成登入／登出並自行保管憑證；Extension 只保存名稱、目錄與各 Provider 目前選定的帳號（globalState）。不使用官方 CLI 的預設目錄（`~/.codex`、`~/.claude`），官方擴充或 CLI 換帳號不影響這裡（MA-104）；Provider 偵測只看 CLI 版本與能力，登入狀態依各帳號目錄檢查，Codex 模型清單也用選定帳號讀取。沒有帳號時執行會要求先到設定新增，不回退到預設目錄。每個環節各自帶入帳號：一般聊天用該 Provider 選定的帳號，討論 A 用畫面選定的帳號、B 可另外指定，總結沿用 A，代替者用該 Provider 選定的帳號。task 記錄 `accountId`；原生 Session 存在各帳號自己的目錄，換帳號時不接續、改以上下文重建。Codex 的用量查詢（`account/rateLimits/read`）同時讀可用的額度重置券張數與明細（標題、取得與到期時間，依到期時間排序）；使用者可選定其中一張，經原生確認視窗後以 creditId 交給官方 `account/rateLimitResetCredit/consume`（官方沒給明細時由官方挑券），每次帶新的 idempotencyKey，依官方 outcome 回報結果後重新讀用量，Extension 不自行推論額度是否恢復（MA-109）。設定頁顯示中每 5 分鐘只重讀一次官方額度（不重新檢查登入，查詢不耗 token），頁面隱藏或關閉即停止，切回時若已過一個週期立即補一次；Claude 沒有不耗額度的查詢，維持由每次執行回報（MA-119）。

## SQLite

使用 sql.js 的 SQLite WASM，避免 native addon 的 Electron／Node ABI 問題；WASM 隨 VSIX 打包。資料庫存於 Extension `globalStorageUri`，所有對話與政策依 workspace canonical root 隔離。

目前 schema version 6：`conversations`、`runs`、`metadata`、`participants`、`messages`、`discussion_rounds`、`discussion_summaries`、`audit_events`、`error_log`。`audit_events` 記錄工具開始／完成／失敗、核准要求與決定、停止、跨 Provider 資料轉交（連到 run），以及工作區授權變更和完整存取（工作區層級，沒有 run）；只存種類與 200 字以內的工具名稱、核准標題或 Provider，不存命令、檔案差異、工具輸出或認證資料。Run 保存完整使用者／Agent 訊息、模型、強度、核准模式、狀態及原生 Session 參照；`participants` 以各自 ID 保存 Provider、Role 與原生 Session，`messages` 每個 Run 各有一筆 user／agent 訊息，ID 建立後不變。未指定 Participant 的 Run 歸到該 Provider 的 `solo` Participant；指定時以 `architect`／`critic` 角色保存，同一 ID 不得改綁 Provider 或角色。Orchestrator 只回放同一 Participant 的歷史並帶入角色指示，每次只執行一方，不自動啟動另一方。`DiscussionCoordinator` 是唯一建立討論輪次的地方：兩方依序唯讀發言，只轉交上一輪可見輸出；每輪以 `discussion_rounds` 保存 roundNo、senderParticipantId、runId、messageId。討論期間 Orchestrator 拒絕一般送出與切換對話，失敗或取消時停止並保留已完成回合。回合上限由 Coordinator 以程式強制：開始 2–8 輪，延長只能由使用者對已完成的討論操作且總計不超過 8 輪；每次發言（含失敗）計入呼叫預算，每次開始或延長另保留 1 次總結。正常完成後由新的中立 summarizer Participant 唯讀總結，只拿到各輪可見輸出並標明 A／B 與輪次；`discussion_summaries` 記錄總結訊息與涵蓋到的輪次，來源可經 `discussion_rounds` 回溯。結論只能由使用者帶入輸入框後自行送出，不會自動寫程式。某輪遇到額度用完或頻率受限時（Adapter 以 `ProviderFailure.kind` 區分 quota／rate-limit），討論進入等待決定並保持鎖定：頻率受限可重試；可改由另一個已授權、可用的 Provider 以新的代替 Participant 接手該角色，交給它目前為止的可見對話；或結束。10 分鐘未決定視同結束。失敗的那次保留紀錄但不占用輪次，不自動代替。Stop 中止當輪子程序群組，回合之間按下也會阻止後續回合。跨 Agent 討論（例如 Claude 提案、Codex 審查）開始前逐一檢查每個 Provider 的工作區授權，一方獲准不代表另一方；不允許時說明原因並指出可用的單 Agent。每輪送出時仍重新檢查，回合之間撤銷授權會讓討論停止。每個 Participant 使用自己 Provider 的模型與強度。v1 開啟時依既有 Run 回填，原 `task_json` 不變。資料庫新版本不會被舊插件降版。

一般任務可在背景執行：任務屬於送出當下的對話，切換或新增對話只改變檢視，執行中與排隊中的對話保留在記憶體並持續寫回原對話。同一 workspace 由單一序列執行器依送出順序執行，最多 3 個排隊，排隊中的任務可直接取消；歷史列表標示執行中、排隊中、等待核准，核准卡標示背景對話。有執行中或排隊任務的對話不能刪除。討論進行中仍鎖住切換。VS Code 關閉時執行中與排隊中的任務標為已中斷，不宣稱會在背景持續執行。目前對話有任務執行中時，輸入框仍可輸入，送出的訊息先放在 Webview 的待送清單（只存在記憶體，記下加入當下的 Agent、模型、權限與圖片），可編輯或移除；該任務正常完成後自動送出第一則，失敗或停止時保留在清單等使用者按送出。Agent 支援時可「立即補充」：Codex 用官方 `turn/steer` 帶 `expectedTurnId` 送進同一個 turn，被拒絕只讓那次補充失敗、不中斷任務，成功後補充存成任務步驟裡的一則使用者訊息（step kind `steer`），顯示在 Agent 回覆中被補充的位置，原本的使用者訊息不變；送出到被接受之間對話裡先顯示傳送中，被拒絕就放回待送清單最前面。之後的上下文與匯出都會帶入補充內容（MA-142）；Claude 尚未提供，只能排隊。討論進行中不開放（MA-120）。

一般、討論、混合在聊天標題列切換，三種方式都在標題列下方的成員面板選帳號：一般選一個，討論選兩個並指定提案方，混合選 2–4 個並指定主帳號。每個帳號各自的模型、推理強度與動作核准記在帳號上（globalState，`set-account-preferences` 由 Host 驗證模型、強度與 CLI 支援的核准方式），沒設定的帳號沿用該 Agent 的預設；討論的 B 方與混合的每個成員都帶自己的設定送出，混合模式的完整存取仍改成要求核准。輸入框只留文字、檔案權限與送出。設定頁不再有「Agent 與模型」分頁，CLI 路徑、檢查連線、重新載入模型移到「一般」頁（MA-130、MA-133）。

混合模式（MA-128）由 `HybridCoordinator` 協調，一個任務由 2–4 個成員（帳號加模型）分工，其中一個是主帳號：

1. 規劃：主帳號唯讀，把任務拆成最多 6 個環節並指派成員，回覆結尾的 json 區塊由程式解析；格式不對就當成單一環節交給主帳號。
2. 執行：依序執行各環節，權限用使用者選的檔案權限與核准方式（完整存取不會代為開啟，改用要求核准）；每個環節拿到前面環節的回報。
3. Review 與結論：主帳號以外的成員各唯讀 review 一次（最多兩位），再由主帳號回應 review 並寫結論。

成員在任何階段失敗（額度用完、頻率受限、執行失敗或送出被擋）就標成離開，它的環節改交給主帳號，主帳號也離開時交給選單順序的下一位；接手的人會被提醒工作區可能留有做到一半的修改。所有成員都離開時任務失敗。離開的成員與原因列在進度列，結論也被要求寫出來。期間沿用討論的鎖定，不接受其他送出或切換對話；Stop 會中止目前環節並阻止後續環節。跨 Provider 轉交成果時寫入 `data-outbound` 稽核事件。每次執行存成一般 run，`task_json` 的 `hybrid` 欄位記錄階段、環節與成員名稱，schema 仍為 v5；進度（HybridSummary）只在記憶體，重開視窗後只留對話紀錄。

WASM 模式採 SQLite 交易後原子匯出單檔，短生命週期寫入鎖避免其他視窗覆蓋不同對話；可回收已退出程序的舊鎖。這不是 native WAL 設計。大規模歷史：只寫有變動的執行、開啟對話只載入最新 100 次、偵測其他視窗新增的執行，見 [歷史量測](research/history-scale.md)；native WAL／FTS5 依該文件的條件再評估。

執行過程保存在 task 的 `steps`：Agent 文字與工具依實際順序交錯，工具有開始／完成／失敗／已停止狀態；Claude 取 `tool_use`／`tool_result`，Codex 取 App Server `item/started`／`item/completed`。工具 IN／OUT 先經 `Redact` 遮罩常見秘密格式，再截斷為 2000／4000 字，單次最多 100 個工具；Stop 或失敗時仍在執行的工具改為已停止。聊天中工具預設收合，展開才顯示 IN／OUT。

回覆語言（設定 → 聊天 → 回覆語言，`multiAgent.replyLanguage`）預設跟隨 VS Code 介面語言，可改成繁體中文、English 或不指定。Orchestrator 每次執行把一行語言指示放在送出內容的最前面（在角色指示之後），一般聊天、討論與總結都適用；保存的使用者訊息不含這行（MA-113）。

續聊上下文由 `ContextBuilder` 組裝：只取同一 Participant 已完成的回合，依時間排序並標明來源 ID 與時間，使用者訊息與 Agent 過去回答（標示可能有誤）分開；超過 48000 字元預算時先省略較舊的回答，再省略較舊的回合並註明數量。使用者標成「不採用」的回答保留紀錄但不再帶入；每次執行把帶入的 run ID 記在 `contextIds`。目前不使用 LLM 摘要舊回合。

目前搜尋是參數化 SQL 的子字串查詢；中英文字面查詢已測試。打包的 sql.js 沒有 FTS5，評估與啟用條件見 [全文索引評估](research/fts-search.md)。日期／Provider 篩選、FTS5、工程記憶與來源引用依 v0.2 後續里程碑增加。

## UI

保留 VS Code Secondary Sidebar 原生分頁，VS Code 1.106 前有 Activity Bar fallback。齒輪設定使用獨立 Vue 編輯分頁。

依 [quiet-workspace-ui](../skills/quiet-workspace-ui/SKILL.md)，常用介面顯示工作、選項及結果；不加填充式空狀態、重複操作教學。CLI 路徑、版本、模型來源、自訂 ID 放展開區。保留實際錯誤、必要欄位限制與高影響操作確認。

## 錯誤紀錄（MA-151）

`error_log` 依專案（root）記錄四種錯誤，排錯時直接查資料庫即可：

| source | 內容 |
| --- | --- |
| `tool` | 失敗的工具步驟：工具名稱、命令第一行；detail 有完整命令與輸出（已遮罩、截斷） |
| `task` | 任務失敗：錯誤訊息；detail 有額度／頻率分類、模型、權限與堆疊 |
| `extension` | 擴充處理畫面請求時的錯誤：請求種類與訊息 |
| `webview` | 畫面的執行期錯誤：訊息與堆疊 |

刪除對話不會連帶刪除錯誤紀錄，整個資料庫只保留最近 5000 筆。專案關掉「保存對話」時只記摘要，不記命令與輸出。查最近的錯誤：

```bash
sqlite3 -readonly ~/Library/Application\ Support/Code/User/globalStorage/local-workspace.multi-agent-workspace/conversations.sqlite \
  "SELECT datetime(created_at/1000,'unixepoch','localtime'), source, provider, summary FROM error_log WHERE root LIKE '%TaskTracker%' ORDER BY created_at DESC LIMIT 20"
```
