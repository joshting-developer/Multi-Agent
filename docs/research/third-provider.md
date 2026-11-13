# MA-75 第三種官方 CLI Provider 評估

日期：2026-11-14。本機沒有安裝 Gemini、Copilot、Cursor CLI，以下依官方文件整理，旗標和協定都還沒有實際跑過。

## 結論

- 目前不新增 Provider。M2 尚未驗收（MA-35～37），也沒有真實使用需求；規格 §11 明確排除「一次支援多個 Provider」。
- 之後若要新增，**優先接 Agent Client Protocol（ACP）的通用 Adapter**，不針對單一 CLI 寫專用解析。ACP 透過 stdio JSON-RPC 提供 session、串流更新與 `session/request_permission`，可以直接對應現有的 `AgentEvent` 和 `approve` callback，和 Codex App Server 的接法相近。
- 候選順序：GitHub Copilot CLI > Gemini CLI > Cursor CLI。

## 候選比較

| | GitHub Copilot CLI | Gemini CLI | Cursor CLI |
| --- | --- | --- | --- |
| 結構化介面 | `copilot --acp`（stdio／TCP），public preview | `--experimental-acp`；headless `-o stream-json` | `-p --output-format stream-json`，`--stream-partial-output` |
| 互動核准 | ACP permission request | ACP 可以；headless 沒有核准通道 | print 模式沒有互動核准，寫檔要加 `--force` |
| 權限模式 | `--allow-tool`／`--deny-tool`，deny 優先 | `--approval-mode default/auto_edit/yolo/plan`，`--sandbox` | 不加 `--force` 就不寫檔 |
| Session | ACP session | `--resume latest/<index>`，`--list-sessions` | 有 resume，未細查 |
| 官方登入 | GitHub 帳號／Copilot 方案 | Google 帳號；官方文件註明 2026-06-18 起免費與 Google One 用戶改用 Antigravity CLI | Cursor 帳號 |
| 其他注意 | ACP 仍是 preview | 需要 folder trust，headless 可能要 `--skip-trust`，不能為了方便而略過信任檢查 | 沒有核准通道，只適合唯讀角色 |

Copilot 的 ACP 有官方文件和 TypeScript SDK（`@agentclientprotocol/sdk`），核准是正式流程。Gemini 的 ACP 仍標示 experimental，產品線也在調整。Cursor 缺少互動核准，在本產品只能當唯讀審查者。

## 擴充所需修改

`AgentAdapter` 介面本身不用改，但 Provider ID 目前寫死成 `z.enum(['claude','codex'])`，`src` 和 `webview/src` 共 19 個檔案直接比對 `'claude'`／`'codex'`，`package.json` 的設定也是每家各一組。新增第三家前要先做這些重構：

1. Provider 改成由 `AgentRegistry` 註冊的描述（ID、名稱、能力、設定鍵），Webview 依描述渲染，不再逐一判斷。
2. 模型與強度設定改成以 Provider 為鍵的結構，避免 `package.json` 每家多 4 個設定。
3. 資料政策沿用 workspace allowlist，新 Provider 預設不允許，跨 Provider 討論前照常逐一檢查。
4. 帳號資訊只讀官方公開狀態，不讀認證檔，和 Claude／Codex 相同。

## 啟動條件

M2 驗收完成，而且使用者明確指定要用的 CLI 後再開實作卡。實作卡沿用本卡原驗收條件：沿用統一事件／權限／Session 介面、官方登入與資料政策獨立驗證、不新增另一套討論或儲存系統。實作前要先在本機安裝該 CLI，用真實帳號確認 ACP 的初始化、權限請求和取消流程。

## 來源

- GitHub Docs：Copilot CLI ACP server、Run Copilot CLI programmatically
- geminicli.com：CLI reference
- Cursor Docs：CLI headless、output format
