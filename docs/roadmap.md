# 產品里程碑

以 [v0.2 規格](../Multi_Agent_AI_Workspace_SPEC_v0.2.md) 為準，套件 0.1.4 代表目前可用版本，不等於 M0–M6 全部完成。

| 階段 | 現況 |
| --- | --- |
| M0 單 Agent + SQLite | 已提供真實 CLI 聊天、Stop／錯誤、SQLite 保存／重開、基本多對話列表與搜尋 |
| M1 雙 Provider | 已支援 Claude／Codex、獨立模型／強度、官方核准與帳號顯示；原生完整 Session resume 待補 |
| M2 討論 MVP | 下一個核心切片：獨立 A／B Participant、共用 Coordinator、2–4 輪、唯讀、摘要與停止 |
| M3 歷史檢索 | 已有中文／英文子字串搜尋；FTS5、時間／Provider 篩選、訊息來源跳轉待補 |
| M4 工程記憶 | 未實作：Experience／Decision、驗證狀態、來源與受控注入 |
| M5 Auto Work | 未實作：Planner／DAG／Review／Fix Loop，單一 writer |
| M6 開源準備 | 未實作：授權決策、跨平台、公開安全與依賴政策驗證 |

保持本機優先與官方登入，不自建 OAuth／Token 管理，不引入向量 DB，不做無限討論或平行同檔寫入。
