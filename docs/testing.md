# V0.1 驗證紀錄

驗證日期：2026-11-11（Asia/Taipei）。macOS arm64、Node.js 22.23.2、VS Code 1.135.0。

## 已執行

| 項目 | 結果 | 範圍 |
| --- | --- | --- |
| 依賴安裝 | 通過 | `npm install`，已產生 package-lock.json |
| TypeScript / Vue typecheck | 通過 | Host、Vue 與各自測試型別 |
| Production build | 通過 | Extension CJS、Webview IIFE + CSS |
| 編譯產物瀏覽器啟動 | 通過 | jsdom 無 Node globals 執行真正產物，掛載 Composer 並送 ready |
| ESLint | 通過 | Host、Vue、scripts、tests |
| Vitest | 78 / 78 通過 | CLI、模型探索、設定持久化與驗證、Host bridge、IPC、Vue、原生分頁 |
| 真實 Extension Host | 通過 | 隔離 profile、右側 Multi-Agent 分頁、設定命令、真正 Vue Webview ready handshake |
| 真實 Claude 2.1.319 | 通過 | 官方登入偵測與固定 `MVP_OK` 聊天 |
| 真實 Codex 0.164.0-alpha.11.1 | 通過 | 官方登入偵測與固定 `MVP_OK` 聊天 |
| Claude 工作區檔案（舊檔案工具基線） | 通過 | 原生讀檔、唯讀限制、新增與修改既有檔案；假機密與外部路徑未讀出 |
| Codex 工作區檔案（exec 基線） | 通過 | 恢復原生 Shell / 編輯工具後實測讀檔、唯讀限制、新增與修改既有檔案；假機密與外部路徑未讀出 |
| VSIX 打包 | 通過 | 本機安裝包，含 runtime notices，不含 node_modules 與測試程式 |
| 官方模型探索 | 通過 | Codex App Server 實際返回 8 個模型及各模型支援強度；沒有建立推論對話 |
| 指定模型／強度執行 | 通過 | Codex `gpt-6.1-sol` + medium、Claude `sonnet` + medium，各自回傳 `MODEL_OK` |
| 真實設定編輯頁 | 通過 | 齒輪打開 `Multi-Agent 設定` 原生編輯分頁、Vue 設定頁回傳 ready |
| 真實設定儲存／截圖（0.1.3／0.1.4） | 通過 | 隔離 VS Code 的 Vue 設定頁實際選擇官方模型與 high 強度，經 Host bridge 儲存後顯示儲存成功狀態並完成截圖 |
| 0.1.4 SQLite 實檔 | 通過 | SQLite header、重開完整訊息、65 筆歷史不修剪、中文／英文內容搜尋、專案隔離、重新命名／刪除、不同連線寫入與舊資料遷移 |
| 0.1.4 真實官方核准 | 通過 | Codex 三種模式各自建立合成測試檔；要求核准有 1 次往返、代我核准有官方 reviewer 事件；Claude 三種模式皆寫入成功、Manual 有 1 次 stdio 核准往返 |
| 0.1.4 真實帳號 metadata | 通過 | 兩個 CLI 皆回傳帳號資訊與 email；測試只記錄欄位是否存在，未輸出真實 email 或 Token |
| 0.1.4 真實歷史 Webview | 通過 | 隔離 VS Code 開啟既存 SQLite 對話、中文訊息搜尋、新增獨立對話後再回歷史開啟；已完成原生側邊欄截圖 |
| 真實 Claude 同 Agent 討論 | 通過 | `TEST_PROVIDER=claude npm run test:discussion`：合成題目 2 輪與 3 輪，A／B 各有原生 Session、回合依序保存 |
| 真實 Claude 討論 Stop | 通過 | 第 2 輪輸出中停止，約 0.5 秒結束，後續回合未啟動、無殘留程序 |
| 真實討論隔離與重開（2026-11-14） | 通過 | `npm run test:discussion` 跑 Claude A／B、Codex A／B、`TEST_PARTNER=codex` 跑 Claude＋Codex：討論前的單 Agent 聊天標記字串沒有出現在任何討論輸入或輸出；Claude 專案記憶與 Codex sessions 沒有寫入這次的臨時工作區；結論標明 (A, R1)／(B, R2)；重新開啟 SQLite 後輪次與結論仍在 |
| 真實工具過程（2026-11-14） | 通過 | `npm run test:tools`：Claude（Read）與 Codex（commandExecution）讀合成檔案，工具依實際順序出現在文字之間，狀態為完成且有 IN／OUT |
| 真實 VS Code 聊天截圖（2026-11-14） | 通過 | `MULTI_AGENT_SCREENSHOT=… npm run test:host`：工具收合列、長路徑在窄側欄截斷、不採用淡化、討論「代替」與「討論結論」標籤 |
| 正式相依套件 audit | 通過 | npm audit --omit=dev：0 個已知漏洞 |

真實 CLI 測試只傳送固定訊息與隨機合成資料，沒有傳送此專案原始碼或真實機密。不是僅檢查 Adapter 假資料。

整合測試中發現並修正：Codex filesystem dotted CLI overrides 的 TOML 相容問題，以及 Vite library mode 保留 `process.env.NODE_ENV` 導致 Webview 無法啟動的問題。Build 現在固定執行編譯產物啟動檢查，Extension Host 測試也等待 Vue ready，而非只檢查 activate。

## 自動測試內容

- Claude / Codex 的登入偵測、串流文字、完整訊息去重、Session ID、額度錯誤、格式錯誤及舊版安全參數拒絕。
- UTF-8 分段、最後一行無換行、退出碼、執行檔不存在、stdin 與 argv、Shell injection 與 cwd。
- 逾時、重複取消、忽略 SIGTERM、真正停止子程序樹，以及 dispose 清理偵測程序。
- 大量未知 JSONL 事件相容、缺少完成事件不視為成功。
- 單一 Provider 可用、Provider 切換與歷史隔離、單任務鎖、取消、工作區變動停用、重啟 interrupted。
- unclassified/restricted、company Provider allowlist、Workspace Trust。
- Webview schema、協定版本與長度、鍵盤送出、Stop、草稿清除、停用不支援的寫入，以及 HTML/圖片/command link 不可執行。
- 工作區寫入為預設選項、仍可切換唯讀，以及授權後經 Host bridge 直接啟動 Agent，不出現逐次寫檔 modal。
- 0.1.2：主畫面不含 Provider 診斷表與未實作模式、只有需要時才顯示授權提示、齒輪設定 IPC，以及 Enter／Shift+Enter／IME 行為。
- 0.1.2：VS Code 1.106 起選擇右側原生分頁，較舊版本保留 Activity Bar fallback。
- 0.1.4：SQLite 實檔、對話切換與歷史上下文隔離、核准／拒絕、唯讀禁止核准寫入、等待核准時 Stop、過期核准 ID、帳號欄位白名單與 UI 操作。
- 0.1.3：模型／effort 正確傳給 CLI、官方 JSON-RPC 初始化與分頁、設定驗證、Provider 間儲存競態防護、設定頁儲存，以及快捷鍵／預設權限生效。

## 尚需人工驗收

以下不宣稱已完成完整真人 E2E：

1. 在日常專案使用側邊欄交替執行兩個 Provider，檢查深／淺色主題、窄側邊欄、焦點與輸入法。
2. 在側邊欄跑長任務後按 Stop，確認狀態與終端程序。自動測試已涵蓋底層程序樹終止。
3. 重載 Webview / VS Code，確認歷史及真實中斷任務恢復。
4. 真實帳號的額度耗盡、離線、過期登入（自動測試以 fixtures 涵蓋）。
5. Windows / Linux 行為與公開發行安全／政策審查。

重現命令見 [README](../README.md)。`test:host` 會暫時開啟隔離的 VS Code 視窗，CLI 測試會使用官方帳號額度。
