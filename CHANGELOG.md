# Changelog

## 0.1.5 — 2026-11-12

- 新增同 Agent 討論：輸入框旁「討論」切換，A（提案）與 B（審查）兩個獨立 Participant 依序唯讀發言，可選 2–8 輪。
- Timeline 標示發言者、角色與回合；輸入框上方顯示目前輪次，完成後可明確延長（總計最多 8 輪）。
- 討論中的 Stop 會中止當輪程序並阻止後續回合；失敗即停止並保留已完成回合。
- 歷史資料庫升級至 schema v3（Participant、Message、討論回合）。0.1.4 無法開啟升級後的資料庫，降版前請還原備份。
## 0.1.4 — 2026-11-11

- 移除模糊的「預設」模型／強度，每個任務擷取並傳入明確值。
- Codex 執行改接官方 App Server，支援要求核准／代我核准／完整存取；Claude 接入官方雙向 stream-json 權限通道。
- 聊天顯示工具核准卡片，Stop 清除等待請求；完整存取需本視窗的明確確認。
- 設定增加官方 CLI 的帳號、登入方式、方案與組織資訊，不保存 Token。
- 新增 SQLite 多對話、中文／英文內容搜尋、續聊、重新命名、刪除及原 workspaceState 歷史遷移。
- 新增對話切換等待狀態與鎖，避免快速切換造成上下文錯置。
- 依 TaskTracker 前端 skill 閱覽結果補上專案 quiet-workspace-ui skill，移除填充式空狀態、重複教學，將技術資訊放入展開區。

## 0.1.3 — 2026-11-11

- 聊天框新增模型與推理強度選擇，偏好分 Provider 保存並傳給官方 CLI。
- Codex 透過官方 App Server `model/list` 取得模型與支援強度；Claude 提供明確標示的官方別名及手動模型 ID。
- 齒輪開啟完整設定編輯頁，管理一般偏好、Agent／模型、CLI 路徑、工作區授權及對話資料。
- 新增設定驗證、序列儲存、模型探索與真實指定模型測試。

## 0.1.2 — 2026-11-11

- 精簡為對話與底部輸入框，Agent 與權限選擇留在輸入框底部。
- 預設整合到右側原生聊天分頁，與 Chat / Codex / Claude Code 並列；保留舊版 VS Code fallback。
- 連線診斷、版本、授權、CLI 設定與清除紀錄收進齒輪選單，移除未實作模式與長篇空白頁說明。
- Enter 送出、Shift+Enter 換行，保留 IME 輸入與原有快捷鍵。

## 0.1.1 — 2026-11-11

- Claude 與 Codex 預設可讀寫已授權工作區，不再逐次顯示寫檔確認。
- 恢復 Codex 原生 Shell / unified exec / 編輯工具，以及專案 AGENTS.md、execpolicy rules。
- 保留唯讀模式、檔案 sandbox 與單任務限制，增加原生讀寫及 Host bridge 驗證。
- 明確以官方 Agent 引擎執行開發工作，Extension 承接多 Provider 對話與後續協調層。

## 0.1.0 — 2026-11-11

- 新增 Vue 3 VS Code 側邊欄聊天，手動選擇官方 Claude Code / Codex CLI。
- CLI 能力及登入偵測、串流、取消程序樹、逾時與清楚錯誤。
- 工作區分類／Provider 授權、單任務限制、基本本機歷史與 interrupted recovery。
- Claude 限定檔案工具與單次寫入授權；Codex 先提供無工具聊天。
- Fake CLI、Vue、真正 Extension Host 與真實 CLI smoke tests。
