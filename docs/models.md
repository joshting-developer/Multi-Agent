# 模型、強度與資料來源

## 目前實作

- **Codex**：呼叫官方 App Server 的 `model/list` JSON-RPC API，取得登入狀態下提供給此客戶端的模型及 `supportedReasoningEfforts`，不掃描認證檔或解析本機快取。使用本機 stdio 是官方的傳輸方式。清單讀取失敗時顯示原因，可重試或手動輸入模型 ID。
- **Claude Code**：提供官方 `opus`、`sonnet`、`haiku`、`fable` 模型別名與手動 ID。這不是帳號 API 回傳的可用模型清單；介面會明確標示。強度是 CLI 支援的選項，實際模型及管理政策可能進一步限制。

模型與強度分別保存在 VS Code 的 `multiAgent.codexModel/codexEffort`、`multiAgent.claudeModel/claudeEffort`。聊天輸入框可快速切換，設定頁可完整調整及手動輸入 ID。介面不提供「預設」模型或強度：模型清單載入後顯示明確選擇，舊版的預設強度遷移為可見的具體值；沒有模型時不啟動任務。

Codex 執行透過 App Server 的 `model` 與 `effort`；Claude 使用 `--model` 與 `--effort`。任務建立時擷取設定，修改偏好不會切換執行中任務的模型。設定不會改寫官方 CLI 自己的設定檔。

## 官方網路 API 也有提供

| 來源 | 可以取得什麼 | 與本版的差異 |
| --- | --- | --- |
| [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list) | `/v1/models` 的模型與基本資訊 | 一般回應不是 Codex 的模型／effort 選單完整資料 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server#models) | `model/list` 的模型、支援強度、預設等資料 | 本版使用此官方 API，沿用既有 CLI 登入 |
| [Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) | 官方 SDK `listModels()` 可探索已授權連線的模型 | 可做不依賴 CLI 的直接整合，但需本套件自己的官方授權流程，不能挪用 CLI token |
| [Claude Models API](https://platform.claude.com/docs/en/api/models/list) | `/v1/models`，含 `capabilities.effort` | 需要相應 API 授權，不能把 CLI 訂閱登入直接當作 API Key |

未在此版自行新增 API Key 收集或另一套 OAuth。後續可替換模型來源服務，保留聊天與設定頁的統一介面；目前兩個 Provider 的聊天仍由官方本機 CLI 執行。
