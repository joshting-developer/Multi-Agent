# 執行與資料邊界

## 工作區與核准

只接受 trusted、單一本機資料夾；cwd 經 realpath。工作區資料分類與 Provider allowlist 由 Host 驗證。company 預先只勾選 Claude；勾選 Codex 時要求確認公司資料政策。介面不能直接提供 cwd 或任意可執行命令。

單一任務鎖在第一個 await 前取得。切換／刪除對話也有鎖，不允許任務執行途中切換資料來源。工作區變更會取消並停用送出，重新載入後再綁定。

核准模式與檔案模式分開：

- **要求核准**：官方 CLI 判定哪些工具／額外權限需要核准，Extension 顯示請求內容，僅回傳這次的同意或拒絕。沒有自動寫入永久允許規則。
- **代我核准**：Codex 交由官方 Auto-review；Claude 使用官方 auto 模式。拒絕／額度／政策失敗不降級成完整存取；必要的人工介入仍顯示卡片。
- **完整存取**：明確解除主要工作區 sandbox／工具核准限制；第一次執行由原生 modal 確認，授權限本次視窗。這種模式不提供工作區隔離保證。
- **唯讀**：不因上述選項變成可寫。Codex 以 read permission profile 執行且不允許提權；Claude 僅提供讀檔工具及 plan 模式。

## CLI

Codex 的要求／代我核准使用原生 filesystem profile，工作區依檔案模式 read/write，`.git`、`.agents`、`.vscode` 保留唯讀，常見機密檔名 deny，命令網路預先關閉。需要額外權限時走官方核准。完整存取使用允許 root 寫入與網路的獨立 profile。管理政策仍然有效。

Claude 的要求／代我核准使用 restricted + safe-mode，檔案工具限於工作目錄，授權寫入時另提供 Bash。Bash 授權經官方 Manual／auto 流程；**restricted 的檔案工具限制不等於 Bash 的 OS sandbox**。本版不宣稱 Claude Shell 有與 Codex 同等的 OS 級隔離。完整存取移除 restricted 並明確使用 bypassPermissions。常見機密路徑 deny 對檔案工具有效，不能保證攔截任意子程序間接讀取。

兩個 Provider 均不開啟 MCP、自訂 hooks 或內建自動多 Agent 工具。沒有讀取或代管官方憑證。Codex account/read 與 Claude auth status 只挑選身分欄位，原始 payload、Token 與 stderr 不整段顯示或寫入歷史。

Git push、部署、破壞性操作要求人工授權的意圖會傳給 Agent；**目前不是完整的命令攔截器**。完整存取尤其不能保證每項高風險操作都停下，使用者應依工作選擇權限。

## 程序、Webview 與資料

- 使用 argv、shell:false、stdin；不以 shell 字串拼接任務。CLI 設定僅接受執行檔絕對路徑。
- 程序群組取消／逾時、SIGTERM → SIGKILL、等待 close；底層測試涵蓋子程序樹。等待核准也能 Stop，過期的核准 ID 不接受回應。
- JSONL、單行、輸出佇列和每筆 Agent 回覆有上限。缺少官方完成事件、非零退出與格式錯誤不視為成功。
- Typed IPC 經 Zod 驗證；CSP、nonce、受限資源目錄。Markdown 不執行 HTML、script、command links 或外部圖片。
- SQLite 明文資料存於 globalStorageUri，依 canonical workspace 隔離。目錄建立為 0700，資料庫／寫入暫存／鎖為 0600；交易後原子匯出。
- 刪除對話會刪除相依 run；不等於安全抹除磁碟／備份，也不刪官方 CLI 紀錄。歷史及模型輸出視為不可信資料。

本版為個人 MVP，尚未完成企業安全審計、跨平台驗證或公開發行政策審查。

## 匯出與備份

- 匯出（設定 → 工作區與資料）只匯出目前對話，JSON 保留 Conversation／Run／Message／Participant／討論輪次與結論的 ID、專案路徑、schema 版本與狀態；Markdown 供人閱讀，工具只列名稱與狀態。兩者都包含完整的提問與回答，可能有程式碼或機密，檔案權限設為 0600，由使用者自行保管。
- 備份是整個本機 SQLite 檔（所有專案）的複本，只寫到使用者選的本機位置；不提供雲端同步。
- 還原會先確認檔案是 Multi-Agent 的歷史資料庫且版本不比目前新，原本的資料庫另存為 `conversations.sqlite.before-restore-<時間>` 後才取代；有執行中、排隊中的任務或討論時不能還原。
