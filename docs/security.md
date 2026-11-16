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

Codex 的要求／代我核准使用原生 filesystem profile，工作區依檔案模式 read/write，`.git`、`.agents`、`.vscode` 保留唯讀，常見機密檔（`.env`、`.env.*`、`*.pem`、`*.key`、`credentials*`、`secrets*`，以及 `.ssh`、`.aws`、`.codex`、`.claude` 資料夾）在每次執行前掃描工作區、以實際路徑 deny（略過 node_modules、.git 等，有深度與數量上限；Codex 沙盒的萬用字元 deny 會讓工作區內所有資料夾都不能刪除或搬移，MA-143），執行中才新增的機密檔不在名單內；命令網路預設關閉。工作區授權可另外開啟「允許 Agent 使用網路」（設定 → 工作區與資料，寫入稽核紀錄）：開啟後 Codex profile 的 network 改為 enabled、`web_search` 改為 live，Claude 多開放 WebFetch、WebSearch；檔案權限不變。命令一失敗就檢查輸出：沒有網路、工作區外的資料夾被擋、或瀏覽器在沙盒內無法啟動，立刻跳出詢問（MA-135、MA-145）。一般聊天可選「允許並重新執行」：停止目前任務、開放權限，再用同樣的帳號、模型與核准方式送出接續訊息；「允許」則等任務之間才生效。瀏覽器只能改用完整存取重跑，仍要原生確認。討論與混合只提供「允許」。同一個任務同一種權限只問一次，不會自動開啟。需要額外權限時走官方核准。完整存取使用允許 root 寫入與網路的獨立 profile。管理政策仍然有效。

Claude 的要求／代我核准使用 restricted + safe-mode，檔案工具限於工作目錄，授權寫入時另提供 Bash。Bash 授權經官方 Manual／auto 流程；**restricted 的檔案工具限制不等於 Bash 的 OS sandbox**。本版不宣稱 Claude Shell 有與 Codex 同等的 OS 級隔離。完整存取移除 restricted 並明確使用 bypassPermissions。常見機密路徑 deny 對檔案工具有效，不能保證攔截任意子程序間接讀取。

**工作區外可讀取（MA-112）**：使用者可在設定 → 工作區與資料，或執行被擋下時跳出的通知，為目前專案加入工作區外的資料夾（realpath，必須是已存在的資料夾，不收根目錄、家目錄本身或與工作區重疊的位置，最多 20 個），保存在工作區授權並寫入稽核紀錄。Codex 在 permission profile 為這些資料夾加上 read，寫入仍被 sandbox 擋下；Claude 以 `--add-dir` 加入並以 deny 規則禁止 Edit／Write，但 Bash 寫入仍依核准流程，不是 OS 級隔離。通知只依工具輸出中帶 Operation not permitted／Permission denied 的路徑判斷，不讀檔案內容；同一資料夾在同一視窗只問一次。

兩個 Provider 均不開啟 MCP、自訂 hooks 或內建自動多 Agent 工具。沒有讀取或代管官方登入憑證。

**API Key 帳號（MA-100）是唯一例外，只限使用者在帳號設定主動輸入的 Key。** Codex 的 Key 由 stdin 交給官方 `codex login --with-api-key`，寫進該帳號自己的 CODEX_HOME，Extension 不保留。Claude CLI 沒有對應命令，Key 存在 VS Code SecretStorage（作業系統鑰匙圈），只在執行該帳號時以 `ANTHROPIC_API_KEY` 環境變數交給 CLI，登入終端機不帶 Key。Key 不寫進 globalState、SQLite、Snapshot、日誌或錯誤訊息，移除帳號時一併刪除。官方 OAuth Token 仍然不讀也不代管。
Codex account/read 與 Claude auth status 只挑選身分欄位，原始 payload、Token 與 stderr 不整段顯示或寫入歷史。

Git push、部署、破壞性操作要求人工授權的意圖會傳給 Agent；**目前不是完整的命令攔截器**。完整存取尤其不能保證每項高風險操作都停下，使用者應依工作選擇權限。

## 程序、Webview 與資料

- 使用 argv、shell:false、stdin；不以 shell 字串拼接任務。CLI 設定僅接受執行檔絕對路徑。
- 程序群組取消、SIGTERM → SIGKILL、等待 close；一般任務不限時間，只能由使用者停止，短查詢仍有逾時；底層測試涵蓋子程序樹。等待核准也能 Stop，過期的核准 ID 不接受回應。
- JSONL、單行、輸出佇列和每筆 Agent 回覆有上限。缺少官方完成事件、非零退出與格式錯誤不視為成功。
- Typed IPC 經 Zod 驗證；CSP、nonce、受限資源目錄。Markdown 不執行 HTML、script、command links 或外部圖片。
- SQLite 明文資料存於 globalStorageUri，依 canonical workspace 隔離。目錄建立為 0700，資料庫／寫入暫存／鎖為 0600；交易後原子匯出。
- 刪除對話會刪除相依 run；不等於安全抹除磁碟／備份，也不刪官方 CLI 紀錄。歷史及模型輸出視為不可信資料。

本版為個人 MVP，尚未完成企業安全審計、跨平台驗證或公開發行政策審查。

## 匯出與備份

- 匯出（設定 → 工作區與資料）只匯出目前對話，JSON 保留 Conversation／Run／Message／Participant／討論輪次與結論的 ID、專案路徑、schema 版本與狀態；Markdown 供人閱讀，工具只列名稱與狀態。兩者都包含完整的提問與回答，可能有程式碼或機密，檔案權限設為 0600，由使用者自行保管。
- 備份是整個本機 SQLite 檔（所有專案）的複本，只寫到使用者選的本機位置；不提供雲端同步。
- 還原會先確認檔案是 Multi-Agent 的歷史資料庫且版本不比目前新，原本的資料庫另存為 `conversations.sqlite.before-restore-<時間>` 後才取代；有執行中、排隊中的任務或討論時不能還原。
- 專案資料：可停止保存目前專案的對話，之後的新訊息只留在本次視窗的記憶體，也不保留官方原生 Session；已保存的紀錄不會自動刪除。「刪除此專案所有紀錄」只刪目前 canonical 專案的對話（連帶執行、訊息、討論與結論）與稽核紀錄，其他專案、工作區授權與帳號不受影響；官方 CLI 自己保存的原生 Session 不在 Extension 管理範圍內。
- 圖片附件：只接受從輸入框貼上的 PNG／JPEG／GIF／WebP，依檔頭判斷實際格式；單張 5 MB、每則 4 張、合計 10 MB。圖片存在 Extension 儲存區 `attachments/<對話>/<id>`（0600），檔名由 Extension 產生；Agent 收到的是圖片內容（Claude base64 image 區塊、Codex data URL），不是本機路徑。歷史只記錄附件的 ID、格式與大小；續聊重建上下文時不重送舊圖片。刪除對話與清除專案時一併刪除附件。Webview CSP 只放行 `blob:` 圖片供送出前預覽。

- **混合模式**：開始前逐一檢查每個成員 Provider 的工作區授權；規劃、review、結論一律唯讀，只有環節依使用者選的檔案權限執行。成員的輸出只當作資料轉交給其他成員，環節數（6）與成員數（4）由程式設上限，Agent 不能自行增加成員或環節。成員離開時自動改交給其他已選成員，資料只會送到使用者在選單勾選的帳號。

- **Agent 功能（MA-140）**：設定 → 工作區與資料可逐項開放外掛與 Apps、MCP 伺服器、子 Agent、瀏覽器與電腦操作、記憶、Hooks、斜線指令與 Skill，預設全關，按工作區記住並寫稽核紀錄，任務執行中不能改。開放後 Codex 不再強制清空 MCP、關閉對應的官方 feature；Claude 拿掉 `--safe-mode`、空 MCP 設定與停用斜線指令，子 Agent 加入 `Agent` 工具。Claude 仍保留 `--restricted`（檔案工具限制在工作區、不讀使用者與專案設定檔），所以外掛與 hooks 只開放給 Codex。外掛與 MCP 讀取各帳號自己的設定資料夾，不讀 `~/.codex`、`~/.claude`。檔案權限、沙盒與網路規則不受這些開關影響。

- **操作這台 Mac（MA-146）**：Agent 功能的一項，只影響 Codex。實測 macOS 沙盒內 Chrome 一啟動就崩潰（給整台電腦寫入權限也一樣），MA 的工作區沙盒也無法執行 Homebrew 的 docker；開啟後 Codex 的可編輯任務改在沙盒外執行（sandbox danger-full-access、網路開啟），核准改成 `untrusted`：要求核准時非唯讀命令都要使用者核准，代我核准時交給 Codex 的審查逐一判斷；完整存取與唯讀任務不受影響。開啟前要原生確認並寫稽核紀錄。瀏覽器在沙盒內啟動失敗時，詢問改成開啟這項並重新執行。
