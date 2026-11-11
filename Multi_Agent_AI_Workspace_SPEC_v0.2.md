# Multi-Agent AI Workspace — VS Code Extension 產品構想與實作規格

> 版本：v0.2（整合討論版）  
> 日期：2026-11-11  
> 狀態：產品願景 + MVP Scope + 技術設計 + Codex 實作任務  
> 目標：**先做個人能持續使用的本機 VS Code 插件；實際使用一段時間後，再視成熟度開源。**  
> 目標平台：macOS + VS Code Desktop；後續才擴展 Windows / Linux。  
> Agent：使用者已自行登入的 Claude Code CLI 與 Codex CLI；設計上保留第三種 Agent 的擴充能力。

---

## 0. 給 Codex 的開工指令（必讀）

請先理解本文件的產品意圖，再依「第 15 節：實作階段」完成第一個垂直切片（vertical slice）。**不要一開始就建立十幾個空介面、完整 MCP 基礎設施、向量資料庫或無限自動化系統。**

本產品的真正核心不是「把兩個 CLI 放在同一個畫面」，而是：

1. **一個聊天介面，多個 Agent / Session。**
2. **跨 Agent 與同 Agent 的多 Session 討論。**
3. **討論、工具執行與決策能永久保存。**
4. **日後可以找回數週或數月前的類似問題與解法。**
5. **協作可控，不讓 Agent 互相無限呼叫、無限制修改檔案或跨越專案資料權限。**

實作原則：每一階段都要有能跑的 UI、實際 Agent 互動、SQLite 資料保存，以及最小可重現測試。若目前 CLI 提供的能力與文中假設不一致，以**本機安裝版本的官方 `--help` 與官方文件**為準，實作 Adapter 的相容性偵測與合理降級，不要硬編不存在的參數。

> **安全前提**：公司提供的 Claude Code 與個人 Codex 是兩個不同的資料處理邊界。沒有公司明確授權前，不得將公司程式碼、內部文件、對話或相關摘要傳送給個人 Codex。應先以個人或測試專案開發與驗證。

---

## 1. 產品定位：為何要做這個插件？

使用者經常在實際開發時發現新需求：某次需要兩個 AI 討論、某次需要同一個 AI 換角度質疑自己的方案、幾週後又想找出以前修過的 Bug。這些需求是日常使用逐漸累積出來的，不是為了堆功能而堆功能。

本專案希望成為 **Agent Collaboration Workspace**：讓使用者在 VS Code 裡只面對一個工作空間，由系統管理 Agent、Session、討論、任務與記憶。使用者不必一直在不同插件間複製貼上，也不必記住一個月前在哪個對話解決過某個問題。

### 核心價值

- **單一入口**：所有需求都從同一個 VS Code Sidebar 輸入與追蹤。
- **可討論**：Claude / Codex 彼此討論，或同一 Provider 的不同 Session 互相討論。
- **可執行**：討論後可以形成任務，交給有權限的 Agent 實作、測試、Review。
- **可記憶**：儲存完整對話與經過驗證的工程經驗，之後能搜尋與引用。
- **可追溯**：知道某項決策由哪次討論得出，後來是否證實有效。
- **可控**：強制管控呼叫預算、討論輪數、寫入權限與資料外送。
- **可演進**：先個人使用，再逐步擴充、公開原始碼；避免過早設計成大型 SaaS。

### 成功指標（體驗優先，不是功能數量）

1. 打開 VS Code，能在同一介面與任一可用 Agent 對話。
2. 使用者可以發起「請兩個 Agent 討論」或「請同一個 Agent 分兩個立場討論」，看到每一輪、摘要與分歧。
3. 重新開啟 VS Code 後，對話與討論紀錄仍在。
4. 輸入「上次 Laravel DI 問題怎麼處理」能搜尋到相關舊紀錄並開啟原始對話。
5. 被搜尋出的舊解法會附來源、時間、專案與驗證狀態，不會被當成永遠正確。
6. 在額度不足、某 CLI 未登入或失敗時，系統可清楚提示並退化成可用的單 Agent 模式。

---

## 2. 使用模式（正式產品功能）

### Mode A — Solo Chat（單 Agent 對話）

使用者選擇 Claude 或 Codex，執行一般的 coding / analysis 任務。保存使用者訊息、Agent 輸出、工具事件、執行結果及原生 Session 參照。

### Mode B — Same-Agent Discussion（同 Agent、多 Session 討論）

**這是核心需求，不可簡化成只讓同一個 Session 自問自答。**

由同一個 Provider 建立兩個**互相獨立**的 Session，例如：

- `Claude A`：提出架構方案（Architect）。
- `Claude B`：從效能、測試、安全性與維護性提出反對或修正（Critic）。
- 或 `Codex A`、`Codex B` 扮演兩個角色。

Orchestrator 負責把上一輪的**可見輸出**交給下一個 Session；各方不能讀取對方隱藏的內部推理，也不能直接呼叫對方。可設定討論輪數和停止條件。

**用途**：架構決策、方案比較、設計審查、需求不清時的多視角分析。注意：相同底層模型即使分成兩個 Session，也不保證真正獨立或得到不同觀點；透過不同角色、明確評估準則與獨立上下文提高討論價值。

### Mode C — Cross-Agent Discussion（跨 Agent 討論）

例如 Claude 與 Codex 針對 Laravel Repository Pattern 討論：

1. Claude 提出方案。
2. Codex 檢查問題與替代方案。
3. Claude 回答異議或修訂。
4. Orchestrator 彙整共識、分歧、待驗證事項。
5. 使用者決定採用方案、要求繼續討論或轉成實作任務。

### Mode D — Auto Work（自動任務分派）

使用者只描述需求，Planner 產生結構化任務 DAG，由 Orchestrator 安排 Claude / Codex。初期採用**單一寫入者 + 唯讀審查者**，避免互相覆蓋檔案。之後再增加 Git Worktree 平行開發。

### Mode E — Historical Recall（歷史記憶檢索）

從 SQLite 搜尋過去對話、討論結論、Bug 案例與技術決策。檢索是跨所有模式的通用能力，可以由使用者主動操作，也可以在模型執行前依政策自動檢索。

### Mode F — Dual Review（雙模型審查）

同一份程式碼交由 Claude / Codex **各自獨立**分析，再彙整相同、相異與互相矛盾的 Findings。不要預設「兩個 AI 都認同」就代表技術上正確；應以測試、程式碼及使用者決策驗證。

> **優先順序**：Solo Chat + 持久化是基礎；Same-Agent / Cross-Agent Discussion 是近期核心功能；Memory Retrieval 與 Auto Work 緊接著擴充。雙 Agent 不是每次都必須啟用，節省額度也是好的使用體驗。

---

## 3. 使用者情境（User Stories）

### US-01：兩個不同 Agent 討論技術方案

使用者輸入：「幫我討論 Laravel 訂單模組是否值得加入 Repository Pattern。Claude 提方案，Codex 質疑，最後整理共識。」

**預期**：顯示輪次、角色與對話；可手動停止／延長；生成 Decision Summary，連結至原始訊息。

### US-02：同一個 Agent 的獨立 Session 互相辯論

使用者輸入：「我只有 Codex 可以用，請兩個 Codex Session 分別站在支持與反對立場，討論 Service / Repository 邊界。」

**預期**：兩個獨立 Session 進行最多 N 輪；遇到同一 Provider 的額度限制能停止並保留紀錄。

### US-03：一個月後找回舊 Bug

使用者輸入：「之前是不是處理過 Service Container 解析失敗？」

**預期**：搜尋包含 `Laravel`、`DI`、`ServiceProvider` 等相關詞彙的歷史記錄，顯示匹配片段、日期、專案、原討論連結，以及已確認的修復方式。第一版以關鍵字 / 標籤搜尋為主；未來再做語意搜尋。

### US-04：使用舊經驗處理新問題

新任務開始時，Memory Service 找到相似的歷史案例；先確認是否屬於允許的專案與 Provider，再將精簡摘要與來源附給 Agent。Agent 需檢查舊方案是否仍適用，不能不加驗證直接照抄。

### US-05：寫程式 → Review → 修正

使用者要求新增功能。Claude 寫入程式碼；Codex 在唯讀狀態下 Review；Claude 根據 Findings 修正；最多三輪；最後顯示 Tests、Diff 和人工確認事項。

### US-06：切換機器或重新開啟 VS Code

SQLite 在 Extension 專用本機資料目錄持久化；重新開啟可讀回歷史。原生 Provider Session 可恢復時接續，不可恢復時重建 Session 並引用已保存的摘要。

---

## 4. 界面設計（VS Code Sidebar）

```text
AI Workspace
├── Header
│   ├── Workspace / Project Name
│   ├── Claude Code: Ready / Not logged in / Error
│   ├── Codex: Ready / Not logged in / Error
│   └── Settings
├── Left / History (可用 VS Code Tree View 或 Webview 內分頁)
│   ├── Recent Conversations
│   ├── Discussions
│   ├── Search History
│   └── Saved Knowledge / Decisions
├── Main Chat Timeline
│   ├── User messages
│   ├── Claude A / Claude B / Codex messages
│   ├── Round # / Role / Session / Status
│   ├── Tool events / Permission requests
│   ├── Related memories + source links
│   └── Discussion summary / final decision
├── Task Panel (later)
│   ├── Task graph / status / owner
│   └── Diff / Tests / Review results
└── Composer
    ├── Input
    ├── Mode: Solo / Same-Agent / Cross-Agent / Auto / Dual Review
    ├── Participants & Roles
    ├── Max Rounds
    └── Start / Stop / Continue Discussion
```

**第一版 UI 不必同時做出所有面板。** Sidebar 聊天與歷史紀錄能用即可；討論流程先以 Timeline + 明確的 Sender / Round / Summary 表示，不急著做圖形化 DAG。

### 互動原則

- 即時顯示事件：Agent 開始、輸出、工具呼叫、核准請求、完成、失敗。
- 支援取消執行，並在取消後留下 `cancelled` 記錄。
- 使用者可查看某段結論引用哪則歷史訊息。
- `@claude` / `@codex` 是未來語法糖；第一版先用選單即可。
- 關閉或重啟 Webview 不應丟失已保存的對話。

---

## 5. 技術架構

```text
VS Code Desktop
└── AI Workspace Extension (TypeScript)
    ├── Vue 3 Webview (Chat / Discussion / History)
    │   └── Typed postMessage IPC
    └── Extension Host
        ├── Webview Controller
        ├── Orchestrator
        │   ├── Conversation Controller
        │   ├── Discussion Coordinator
        │   ├── Task Planner / Router (later)
        │   ├── Policy Engine
        │   └── Execution Budget + Cancellation
        ├── Agent Registry
        │   ├── ClaudeCodeAdapter -> official claude CLI
        │   └── CodexAdapter -> official codex CLI / app-server
        ├── Local Persistence
        │   ├── SQLiteRepository
        │   ├── Conversation / Message / Run / Task Stores
        │   └── MemoryRepository + FTS5 Search
        ├── Memory Service
        │   ├── Search + Rank
        │   ├── Experience / Decision extraction
        │   └── Context Builder
        └── Workspace Services
            ├── Git / Test Runner (later)
            └── Redaction / Access Audit
```

### 技術選型

| 層 | 選型 | 理由 |
|---|---|---|
| Extension Host | TypeScript + VS Code Extension API | 直接整合 workspace、終端與側邊欄 |
| UI | Vue 3 + TypeScript + Vite | 易於維護，聊天室與歷史介面開發快速 |
| Agent 連線 | CLI Adapter，視成熟度改用 Codex App Server | 使用者自己的官方登入、避免從零實作模型 API |
| Orchestrator | TypeScript 狀態機，初期不依賴大型 Agent Framework | 可控、易測試、低依賴 |
| Persistence | SQLite | 本機單檔、支援交易與索引 |
| Search | SQLite FTS5 + Metadata / Tags | 足夠支援 MVP；不需向量 DB |
| Validation | Zod 或同等 Schema Validation | 驗證事件、Planner 輸出、IPC |
| Tests | Unit + VS Code Extension Integration | 驗證真實存檔、重啟、CLI failure |

### SQLite 技術注意

- 優先使用 Extension Host 可穩定執行的 SQLite Library；若選擇 native addon（例如 `better-sqlite3`），需處理 VS Code Electron/Node ABI 相容、安裝及跨平台打包問題。
- SQLite 路徑使用 `context.globalStorageUri`（可跨專案搜尋）；資料表每筆資料都要帶 scope。SQLite 不直接放進 Git workspace。
- 資料庫 Migration 必須隨 Extension 版本演進；啟用 WAL、適當索引、定期 checkpoint/backup。
- FTS5 搜尋英文程式碼與錯誤字串容易，但**中文斷詞要實測**；評估 trigram tokenizer、標籤與 n-gram 預處理，不應直接假設預設 tokenizer 能準確找中文相似問題。
- **長期記憶不是模型內建的永久記憶**；是外部資料檢索，再把相關內容作為明確可見的上下文供 Agent 參考。

---

## 6. Agent Adapter 與登入

### Adapter Interface（建議）

```ts
export type ProviderId = 'claude' | 'codex';
export type PermissionMode = 'read-only' | 'workspace-write';

export interface AgentParticipant {
  participantId: string;    // e.g. claude-a, claude-b, codex-a
  providerId: ProviderId;
  role: 'architect' | 'critic' | 'implementer' | 'reviewer' | 'custom';
  nativeSessionId?: string;
}

export interface AgentExecutionRequest {
  runId: string;
  conversationId: string;
  participantId: string;
  prompt: string;
  cwd: string;
  permission: PermissionMode;
  timeoutMs: number;
  signal: AbortSignal;
  nativeSessionId?: string;
}

export type AgentEvent =
  | { type: 'text-delta'; runId: string; text: string }
  | { type: 'tool-start'; runId: string; tool: string; detail?: string }
  | { type: 'tool-end'; runId: string; tool: string; success: boolean }
  | { type: 'approval-required'; runId: string; approvalId: string; detail: string }
  | { type: 'usage'; runId: string; data: Record<string, unknown> }
  | { type: 'error'; runId: string; message: string }
  | { type: 'complete'; runId: string; nativeSessionId?: string };

export interface AgentAdapter {
  readonly providerId: ProviderId;
  detect(): Promise<{ ready: boolean; version?: string; reason?: string }>;
  capabilities(): {
    stream: boolean;
    resume: boolean;
    readOnly: boolean;
    approvals: boolean;
  };
  execute(input: AgentExecutionRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

### 登入與 Session

1. 使用者透過官方 `claude` / `codex` 工具自行登入；Extension 偵測版本與可用狀態。
2. Extension 不擷取、不複製、不儲存 Token、Cookie 或 OAuth Refresh Token。
3. `ConversationId` 是本產品的通用主鍵；Claude 與 Codex 各有自己的 Native Session ID，不可互換。
4. 同 Agent 多 Session 討論需要**真的建立不同 Native Session 或獨立執行上下文**，不能只是同一個 Session 連續假扮 A/B。
5. 某 CLI 無法建立／恢復 Session 時，可以用新執行配合受控的外部摘要重建上下文，且在 UI 顯示此為「重建」而非原生恢復。
6. 使用官方支援的非互動 CLI／事件格式；可評估 Codex App Server 做深度整合，但不是初版的強制前提。
7. 即使 CLI 已安裝，也不代表登入有效或有足夠額度。請分別偵測與處理。

### 公司與個人帳號的權限邊界

- 每個 Workspace 設 `allowedProviders`，預設**不自動跨 Provider 分享公司資料**。
- 不同 Provider 間分享代碼、對話、搜尋出來的 Memory，視為新的資料外送動作，必須經過權限判斷。
- 如果 Claude 是公司授權、Codex 是個人授權，未獲明確許可的公司專案**應停用 Cross-Agent Discussion / Dual Review / 跨 Provider Memory 注入**。
- Agent 子程序還可能自行讀取 workspace 檔案；應使用 Provider 可用的 sandbox / Tool 權限及必要的作業系統隔離，不能只靠 Prompt 或路徑黑名單。
- 將來開源發佈前，重新確認 Anthropic/OpenAI 對第三方客戶端、訂閱登入、授權與品牌的最新規則；個人本機測試可行不代表公開發行一定允許。

---

## 7. 討論引擎（Discussion Coordinator）

### 基本流程

```text
User creates discussion
  -> Validate participants + provider allowlist + budget
  -> Create discussion and participant sessions
  -> Round 1: Speaker A produces a visible position
  -> Round 2: Speaker B receives scoped summary / previous message
  -> Round 3+: alternate, compare, rebut, refine
  -> Check convergence / maxRounds / budget / user cancellation
  -> Produce structured summary
  -> Save transcript + decisions + unresolved questions
  -> Optional user action: continue / save memory / create task
```

### 討論規則

- **唯讀為預設**：討論模式不應直接修改程式碼。
- Speaker B 只接收 Coordinator 編排的可見對話，不可取得 Speaker A 的隱性推理。
- Agent 只能回覆目前問題與提出建議，不能自行直接建立下一個 CLI 子程序；建立下一輪的權限由 Coordinator 控制。
- 每個 Agent Round 要獨立記錄 `senderParticipantId`、`nativeSessionId`、`roundNo`、`promptContextHash`、`messageId`、`status`。
- 若其中一個 Agent 失敗，討論應安全停止，保留前面回合；可由使用者選擇重試或改用單 Agent。
- 討論結束要產生「共識 / 分歧 / 假設 / 驗證方法 / 最終建議」，避免只產生長篇聊天。
- 自動總結本身會消耗模型額度；可由最後主 Agent 或指定 Provider 執行，並設額外呼叫上限。

### 預設執行上限（均可調整）

| 項目 | 預設 |
|---|---|
| 討論總回合（Agent 發言次數） | 4 |
| 最大討論回合 | 8，超出需使用者延長 |
| 同時有寫入權的 Agent | 1 |
| 討論模式寫入權 | 0（read-only） |
| 自動 Review → 修復迴圈 | 最多 3 輪 |
| 巢狀直接委派深度 | 0（僅 Orchestrator 可建立執行） |
| 單次子程序 Timeout | 可配置，初始 180 秒（長任務允許明確延長） |
| 連續失敗自動重試 | 最多 1 次（權限/登入錯誤不重試） |

**迴圈防護不能只靠環境變數 `AI_BRIDGE_ACTIVE`。** 需要由 Orchestrator 掌控 Executor，透過 allowed operations、會話狀態、呼叫預算、最大輪數、取消訊號與受限程序執行共同限制。不能只在提示詞中宣告「不得再呼叫 Agent」。

### 討論資料模型（概念）

```ts
type DiscussionMode = 'same-agent' | 'cross-agent' | 'dual-review';
type DiscussionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface Discussion {
  id: string;
  conversationId: string;
  mode: DiscussionMode;
  topic: string;
  participants: AgentParticipant[];
  maxRounds: number;
  status: DiscussionStatus;
  summaryMessageId?: string;
}
```

---

## 8. SQLite：完整歷史與共用工程記憶

### 核心原則：Raw History 與 Reusable Memory 分開

- **Raw History**：完整保存對話訊息、Agent 輸出、工具事件、討論輪次和失敗紀錄，做為可追溯的原始資料。
- **Reusable Memory**：從對話整理出的工程經驗（問題 / 原因 / 解法 / 適用條件 / 驗證狀態），供日後快速檢索。
- **Session State**：保存本產品與各 Provider 的對應關係，用來恢復工作，不等於模型隱性記憶。

### 第一版建議資料表

| Table | 用途 |
|---|---|
| `projects` | 專案與資料可見範圍、Workspace 識別 |
| `conversations` | 聊天室、標題、模式、建立／更新時間 |
| `participants` | Claude A/B、Codex A/B、Role、Native Session 關聯 |
| `messages` | `user` / `agent` / `system-summary` 的訊息及來源 |
| `agent_runs` | 實際 CLI 執行、耗時、狀態、錯誤、取消 |
| `discussions` | 討論主題、模式、輪數、狀態、結論 |
| `discussion_rounds` | 一輪由誰發言、對應 Message / Run |
| `memory_entries` | 問題、解法、決策、標籤、驗證狀態 |
| `memory_sources` | Memory 與來源訊息／Git Commit／檔案的關聯 |
| `tasks` | 後期自動拆解的工作項目、依賴、狀態 |
| `audit_events` | 重要的授權、資料外送、刪除與失敗事件（不保存秘密） |

### 簡化 Schema 範例（供架構參考，不必逐字照抄）

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_uri TEXT NOT NULL,
  visibility_scope TEXT NOT NULL DEFAULT 'project',
  created_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'solo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  provider_id TEXT NOT NULL,
  role TEXT NOT NULL,
  native_session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT REFERENCES participants(id),
  sender_type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL
);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  applicability TEXT,
  created_at TEXT NOT NULL,
  last_verified_at TEXT
);

CREATE INDEX idx_conversations_project_updated
  ON conversations(project_id, updated_at DESC);
CREATE INDEX idx_messages_conversation_created
  ON messages(conversation_id, created_at);
CREATE INDEX idx_memory_project
  ON memory_entries(project_id, created_at DESC);
```

其他表與 migration 由實作階段補完。需注意 `content` 可能含敏感資訊，存放與備份必須受資料政策約束。

### 歷史搜尋階段性能力

**第一階段 — Full Text Search**

- 對 `messages` 與 `memory_entries` 建立 FTS5 可搜尋索引。
- 支援專案、時間範圍、Provider、討論模式、Tag 篩選。
- 搜尋結果回傳引用來源 ID、對話連結、時間、片段，不只回傳一段失去上下文的摘要。
- 中文查詢有適當的 tokenizer 或降級方案（關鍵字片段／標籤），需要真實測試。

**第二階段 — 技術經驗卡片**

```text
Title: Laravel Repository 注入失敗
Problem: Target interface is not instantiable
Cause: ServiceProvider 漏了 Interface -> Implementation 綁定
Solution: 加入 bind(...) 並執行相應測試
Status: Verified / Unverified / Superseded
Project: Project-A
Tech: Laravel X / PHP Y
Sources: conversation/message IDs + commit SHA (if available)
```

- 記憶可以由使用者手動儲存，也可以由 Agent **提出候選**；涉及跨專案共享或機密內容時不得自動公開。
- 儲存失敗嘗試與不採用原因也有價值，避免之後重踩同一個坑。
- 可以標記 `superseded`、`stale`、`unverified`，不能只累積永不淘汰的結論。

**第三階段 — 語意檢索（可選）**

- 預設不要引入外部 Embedding API、向量 DB 或長期常駐服務。
- 需要時再選本機 Embedding，或可選的合法外部服務，並經過資料外送授權。
- 採混合檢索（FTS + semantic + tags + time / project scope）提高品質。

### 自動取回上下文的控制

```text
New request
  -> Determine workspace + provider data policy
  -> Search current-project memories
  -> Rank and filter verified/related memories
  -> Select small Top-K (e.g., 3)
  -> Build short context with source references
  -> Send to the selected permitted Agent
  -> Agent verifies applicability and reports result
```

- 不把全部歷史對話送給模型；控制 Token 使用與隱私。
- 跨專案、跨 Provider 搜尋預設關閉，需要使用者允許的 Scope。
- 原始對話與模型輸出可能包含錯誤資訊或惡意提示；**檢索內容屬於不可信資料，不得作為工具執行規則或安全指令。**
- 在 UI 顯示「引用了哪些舊紀錄」，讓使用者能關閉、不採用或糾正記憶。

### 刪除與資料管理

- 刪除對話時，相關 Memory 引用要處理孤兒來源。
- 有匯出（JSON / Markdown）及備份策略；未來才做跨機同步。
- 可針對專案清除資料與索引；可停用單一專案的持久化。
- 不預設保證 SQLite 明文資料在硬碟遺失時安全；個人 MVP 可依賴 OS FileVault 等磁碟加密，公開版應評估資料庫加密及適當權限。

---

## 9. 記憶的價值不是「所有資訊都永久保留」

建立明確的資料品質與保存策略：

| 資料類型 | 保存方式 | 檢索用途 |
|---|---|---|
| 一般對話 | Raw Message | 完整回顧與續聊 |
| Agent 討論 | Round + Summary | 查找論點與決策過程 |
| Bug 解法 | Memory Entry | 相似問題快速取用 |
| 設計決策 | Decision Record | 理解當時選型與取捨 |
| 失敗方案 | Negative Finding | 避免重複踩坑 |
| 原始程式碼 | 不建議整份重複儲存在 SQLite | 以檔案路徑 / Git SHA 參照為主 |
| Token / 密碼 / `.env` | 不保存 | 應遮罩 / 拒絕索引 |

記憶擷取要以「能否改善未來任務」為準，避免把每一句廢話都變成永久記憶。原始歷史可以完整保留（依使用者設定），但 Memory Entry 應精簡、可驗證、可更新。

---

## 10. 任務與權限系統（避免專案失控）

### 寫入規則

- Discussion Mode：一律唯讀。
- Solo / Auto Work：至多一個 Agent 同時寫入同一個 Workspace。
- 多 Agent 同時編輯：未來使用不同 Git Worktree，並設合併與衝突處理流程。
- Git Push、部署、破壞性命令：必須要求人工確認；不能以「AI 同意」代替使用者授權。

### Policy 檢查必備項目

1. Project / Workspace 是否被信任？
2. Provider 是否允許接觸此專案？
3. 目前執行是 read-only 還是 workspace-write？
4. 是否超出 Session / Round / Timeout / Retry 預算？
5. 是否要跨 Provider 或跨專案注入 Memory？
6. 是否執行高風險操作或讀取敏感檔案？
7. 取消時是否能中止整個子程序樹並回收資源？

### 實務安全提醒

- CLI 的 `read-only` / `plan` 等模式必須依官方當前支援能力驗證；Prompt 本身不是 sandbox。
- Extension Webview 使用 CSP、nonce、型別化 IPC，不讓 Webview 直接啟動任意 Shell。
- Agent 輸出的 Markdown 必須安全渲染，避免注入 HTML / script。
- CLI 的登入狀態和 Extension 自己的存檔應分離，不能偷偷操作官方認證檔。
- 不把 CLI 詳細的機密環境變數原樣寫進 Debug Log。

---

## 11. 開發範圍控制：如何避免太龐大？

你希望的功能很多，但它們不是完全獨立的系統，而是共用幾個核心基礎：

```text
Agent Adapter
    +
Conversation / Session Model
    +
Orchestrator（單一控制入口）
    +
SQLite Event/Message Store
    +
Search / Memory Service
```

**避免過度設計的方法**：沿著使用者真正會操作的流程做「垂直切片」，不要同時為五種模式建立完整 Framework。

### 初期必做（最小可用核心）

- Vue 聊天 Sidebar。
- Claude 或 Codex 的單一 Session 對話。
- 完整訊息寫入 SQLite，重新開啟可讀回。
- 討論模式：兩個獨立 Participant Session；先支援固定 2～4 輪。
- 同 Agent / 跨 Agent 都走**同一套 Discussion Coordinator**，只是 Participant Provider 是否相同。
- 取消、Timeout、不可用 Provider 時安全停止。
- 簡單歷史查詢與原始對話開啟。

### 第二波再做

- 自動抽取工程記憶、Tag、驗證狀態。
- 精準中文全文搜尋與排序。
- 自動分派工作、Code Review、有限修復迴圈。
- Git Diff、來源參照與測試彙整。

### 暫時不做

- 自架雲端 API / 多人同步帳號系統。
- 自己管理或代理各家 OAuth Token。
- 用向量 DB 取代 SQLite。
- 一次支援 10 個 Provider / 10 個 Agent。
- 無限 Agent 辯論與自動執行。
- 多 Agent 同檔案平行寫入。
- 跨機同步、雲端備份、訂閱計費、商城／付費方案。

---

## 12. 與現有開源工具的關係（研究參考，不盲目重造）

以下為之前討論過、值得 Codex 研究的專案。**功能、維護狀態、授權及可否直接整合，均須以實際 Repo / LICENSE / 原始碼再確認**，不把第三方宣稱當成已驗證能力。

| 專案 | Repo | 值得研究的面向 |
|---|---|---|
| Hydra | https://github.com/Geraldlol/hydra | VS Code 多 Agent 聊天、討論紀錄、協調流程 |
| AionUi | https://github.com/iOfficeAI/AionUi | 多 CLI UI、Team Mode、協作與本機資料保存 |
| Unified Agent Context | https://github.com/ILKAY-BRAHIM/Unified-Agent-Context | 跨 Session 共享 Context / Memory |
| Cortex | https://github.com/cdeust/Cortex | 長期記憶、檢索與來源管理 |
| Claude Code Orchestrator | https://github.com/Toragonite/claude-code-orchestrator | 任務委派與不同 Agent 執行方式 |
| Kilo Code | https://github.com/Kilo-Org/kilocode | 成熟 VS Code Agent UI、工具權限與工作流程 |

### 研究策略

1. 不要第一天就 Fork 大型專案，先找出最小可參考的實作模式。
2. 先閱讀目錄結構、Extension / IPC、Adapter、Session、SQLite Migration、取消流程。
3. 評估套件授權、相依性、維護程度、測試覆蓋及安全邊界。
4. 自己專案採小而清楚的介面，只有在確實省下大量時間時才引入第三方程式碼。
5. 產品差異化放在**有來源的歷史工程記憶 + 可管理的同 Agent / 跨 Agent 討論**，而不是單純展示多個聊天視窗。

---

## 13. 建議專案結構（小型可演進）

```text
multi-agent-ai-workspace/
├── package.json
├── README.md
├── SPEC.md
├── src/
│   ├── extension.ts
│   ├── ui/ChatViewProvider.ts
│   ├── ipc/protocol.ts
│   ├── agents/
│   │   ├── AgentAdapter.ts
│   │   ├── ClaudeCodeAdapter.ts
│   │   ├── CodexAdapter.ts
│   │   └── AgentRegistry.ts
│   ├── orchestration/
│   │   ├── ConversationController.ts
│   │   ├── DiscussionCoordinator.ts
│   │   ├── ExecutionPolicy.ts
│   │   └── ProcessManager.ts
│   ├── persistence/
│   │   ├── Database.ts
│   │   ├── migrations/
│   │   ├── ConversationRepository.ts
│   │   └── DiscussionRepository.ts
│   └── memory/
│       ├── MemoryRepository.ts
│       ├── SearchService.ts
│       └── ContextBuilder.ts
├── webview/
│   ├── src/App.vue
│   ├── src/components/
│   ├── src/stores/
│   └── vite.config.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── docs/
    ├── roadmap.md
    ├── architecture.md
    └── security.md
```

這是合理的演進目標，不是要求第一個 Commit 就建立每一個資料夾與空檔案。

---

## 14. 關鍵測試與驗收案例

### 基本聊天與持久化

- [ ] VS Code Extension 可以啟動，Sidebar Vue 正常顯示。
- [ ] 可偵測 Claude / Codex CLI 是否已安裝、是否可用。
- [ ] 只裝一個 Agent 仍可正常聊天。
- [ ] 可以送出訊息、看到串流或可理解的漸進輸出、停止任務。
- [ ] 關閉 / 重開 VS Code，SQLite 中的聊天室與訊息仍可讀取。
- [ ] Agent 失敗、Timeout、取消有正確紀錄，不會顯示假成功。

### 討論引擎

- [ ] 可以用 `Claude A + Claude B` 做同 Agent 雙 Session 討論（若同 Provider 支援）。
- [ ] 可以用 `Codex A + Codex B` 做同 Agent 雙 Session 討論（若同 Provider 支援）。
- [ ] 可以用 `Claude + Codex` 做跨 Agent 討論（在允許的資料範圍內）。
- [ ] 每輪 UI 都能分辨實際 Provider、Participant、Role、Session、Round。
- [ ] 達到設定的回合上限會停止，不會遞迴呼叫。
- [ ] 討論結論含共識 / 分歧 / 未解決問題，並能點開原對話。

### 歷史與 Memory

- [ ] 可以依關鍵字找回一個月前的對話並開啟。
- [ ] 可依 Project / 日期 / Agent 篩選。
- [ ] 搜尋結果能提供原始訊息的來源 ID。
- [ ] 中文關鍵字與英文錯誤碼都有通過測試。
- [ ] 舊解法標記 Verified / Unverified / Superseded，模型不直接視為真理。
- [ ] 不允許的專案或 Provider 不能檢索 / 發送該記憶。

### 安全與權限

- [ ] 不讀取或儲存官方認證檔內容與 Token。
- [ ] 討論模式不得寫入 workspace。
- [ ] 公司與個人專案可設不同 Provider allowlist。
- [ ] 取消可中止子程序（包含子程序樹），不留下失控執行。
- [ ] Agent 無法藉由工具輸出或歷史 Memory 指令繞過 Orchestrator Policy。

---

## 15. 建議實作階段（以實際使用價值排序）

| 里程碑 | 目標 | 必要驗收 | 不做 |
|---|---|---|---|
| **M0 — 基礎可用** | Extension + Vue Chat + 1 個 CLI Adapter + SQLite 存取 | 一次真實聊天、重啟保留紀錄 | 多 Agent、自動分派 |
| **M1 — 雙 Provider** | Claude + Codex Adapter、Session 狀態、停止、錯誤 | 可切換 Provider、保留各自 Conversation | 自動辯論 |
| **M2 — 討論 MVP** | 共用 Discussion Coordinator，支援同 Agent / 跨 Agent 兩方 2～4 輪 | 能在 UI 看到 A/B 討論與摘要，防止無限輪詢 | Agent 自由互相執行、平行寫檔 |
| **M3 — 歷史搜尋** | SQLite FTS5、Project/時間篩選、對話跳轉 | 能找回舊問題、附原始來源 | Embedding / 向量 DB |
| **M4 — 工程記憶** | Experience / Decision Card、狀態與來源、受控上下文注入 | 新問題能引用舊解法且標示來源 | 跨專案自動共享 |
| **M5 — Auto Work** | Planner / DAG / Review / Fix Loop / Test | 限制修復輪數、追蹤 Diff & Tests | 不受控並行開發 |
| **M6 — 開源準備** | LICENSE、相容性、設定遷移、文件、資安與授權審查 | 他人能按步驟在支援平台安裝使用 | SaaS / 自建登入平台 |

**不要將 M2 延後到整個專案最後。** 你已明確表示同 Agent 與跨 Agent 討論是常用且重要的核心需求；因此 M2 排在完整自動任務拆分之前。

### 建議第一個 Sprint

1. 建立 VS Code Extension Host 與 Vue 3 Webview，能渲染聊天訊息。
2. 建立一個可替換的 AgentAdapter，先串接本機已可用的其中一個 CLI。
3. 建立 SQLite Repository，存入 user/agent messages，關閉重開 VS Code 後可還原。
4. 完成 Stop / Cancel 與錯誤狀態。
5. 做一個最簡單的歷史聊天列表，能切換會話。
6. 補 Unit / Integration tests，提供 `.vsix` 的本機測試步驟。
7. 第二 Sprint 才補另一個 Provider 與討論引擎。

---

## 16. 第一版實作上的重要取捨（ADR 草案）

| 編號 | 決策 | 理由 |
|---|---|---|
| ADR-001 | 本機優先，不建 Server | 簡化維運與費用 |
| ADR-002 | 用官方 CLI 身分驗證 | 避免自己保管帳號憑證 |
| ADR-003 | SQLite 為 Canonical Conversation Store | 同時支援不同 Provider，統一查詢歷史 |
| ADR-004 | Agent 原生 Session ID 與產品 Conversation ID 分開 | 支援跨 Agent、多 Session 討論 |
| ADR-005 | 所有 Agent 訊息由 Orchestrator 中轉 | 控制輪次與權限，避免無限遞迴 |
| ADR-006 | 同 Agent 討論需獨立 Session | 不是在同一 Context 裡假裝兩個角色 |
| ADR-007 | 原始對話和知識記憶分離 | 檢索更有效率，保留來源 |
| ADR-008 | 先 FTS5，再考慮語意向量 | 降低 MVP 複雜度與外部依賴 |
| ADR-009 | Discuss read-only / Auto Work 單一寫入者 | 避免不受控的檔案衝突 |
| ADR-010 | 預設專案級 Provider / Memory 隔離 | 避免公司與私人帳號資料越界 |

---

## 17. 之後再決定的問題（不阻擋 MVP）

- 對話 UI 要完全自己做，還是借用既有 Webview 元件？
- 討論結論是否要自動轉存記憶，或先由使用者確認？建議最初手動／候選審核。
- 同一個 Provider 的不同 Session 是否要使用完全隔離的 Context Snapshot？初期可使用相同初始任務描述 + 各自 Role，避免互相共享原生 Session。
- 長任務如何延續 Time Budget / Context Budget？先提供可配置 Timeout 與手動繼續。
- 什麼時候開始使用 Codex App Server 的完整 session / approval / event API？在 CLI `exec` 接入不夠穩定時再評估。
- SQLite 驅動如何兼顧 Electron、Remote Extension Host、跨平台打包？M0 做小型 Spike 驗證。
- 未來支援其他 Provider（如 Gemini CLI）時，先延伸 Adapter 而非增加一套新流程。

---

## 18. 給 Codex 的起始 Prompt（直接複製）

> 請把這份 `SPEC.md` 當作本專案目前的正式設計基準。這個專案是 **VS Code Multi-Agent AI Workspace**，不是普通的聊天 UI。核心需求包含：單一聊天入口、Claude Code / Codex CLI、同 Agent 兩個獨立 Session 討論、跨 Agent 討論、SQLite 對話持久化，以及歷史工程知識檢索。
>
> 請**先實作 M0**：建立可啟動的 VS Code Extension（TypeScript）與 Vue 3 Webview、最小的 AgentAdapter、可實際執行的本機 CLI 聊天、SQLite 對話保存與重啟後讀回、Stop / Error 處理。請不要一次把 M0～M6 全做完，也不要只建立空的目錄或 Interface。
>
> 專案架構應預留 `ConversationId`、`ParticipantId`、`NativeSessionId`、`DiscussionCoordinator`、`MemoryRepository`，以便 M2 支援同 Agent / 跨 Agent 討論，但 M0 只需實作目前真正使用到的部分。
>
> 請先檢查本機 Claude / Codex CLI 版本及實際支援的指令，採用官方驗證機制，不要自行讀取或保管登入 Token。不得將未授權的公司程式碼送至個人 Provider。實作完執行 Build、Lint 和可重現測試，明確回報通過項目、失敗原因、實際運行方式及下一個最小里程碑。

---

## 19. 專案方向總結

這個專案不必在第一天就變成很龐大的系統；但也不應把真正有價值的功能「同 Agent 討論、跨 Agent 討論、歷史記憶」一直往後延。

**用一套可控的 Agent Session / Discussion / Memory 基礎，逐步完成每一個實際會用到的工作流程。**

先讓自己覺得順手、值得每天使用，再根據真實痛點決定哪些能力值得開源與繼續投資。
