# Multi-Agent AI Workspace — VS Code Extension 規格與實作計畫

> 文件版本：v0.1 · 2026-11-11  
> 狀態：供 Codex 開始實作的初版 PRD + Technical Design + Implementation Backlog  
> 目標：**先供個人本機使用**，體驗成熟後再評估開源發佈。  
> 開發環境優先：macOS + VS Code Desktop + 本機 Claude Code CLI + 本機 Codex CLI。

### V0.1 修訂：原生工作區讀寫（2026-11-11）

使用者追加方向：檔案讀寫直接開放，參考既有 Codex 的開發能力，主要擴充對話及多 Agent 溝通／協調層。此修訂優先於下文與其衝突的 V0.1 舊描述。

- 已授權 Provider 可直接讀寫目前工作區；預設 `workspace-write`，仍提供 `read-only`。不逐次要求寫檔確認。
- 檔案工具沿用官方引擎；Codex 恢復 sandbox 內的原生 Shell／編輯工具，以及專案 instructions／execpolicy rules。保留機密路徑與工作區邊界，不使用全機無限制權限。
- V0.1 仍只有一個執行任務。插件擁有對話、上下文與任務協調責任；更完整 Codex session／approval／delta 以官方 App Server 作為後續整合方向。
- 不在此修訂提前實作 V0.2 Planner 或 V0.3 Dual Review。實際邊界見 [architecture](docs/architecture.md) 與 [security](docs/security.md)。
- 0.1.2 介面修訂：採簡單對話區與底部輸入框，未實作模式不出現在主畫面；連線、版本、資料分類與設定集中在齒輪選單。
- 0.1.2 位置修訂：預設使用 VS Code 右側原生聊天分頁，與 Chat／Codex／Claude Code 並列；1.106 之前的版本保留 Activity Bar fallback。
- 0.1.3 設定修訂：聊天框可選模型／推理強度，齒輪開啟完整設定編輯頁。Codex 清單經官方 App Server API，Claude 模型別名與網路 Models API 的差異須明確標示，見 [models](docs/models.md)。

---

## 0. 給 Codex 的執行指令（先閱讀）

你是本專案的實作 Agent。請將本文件作為需求的單一主要來源，**先完成可以啟動、可以實際操作的 V0.1 MVP，不要一開始就做完整的多 Agent 平行開發系統**。

1. 先檢查工作目錄及現有專案；若是空專案，初始化 VS Code Extension（TypeScript）與 Vue 3 Webview，使用合理且易維護的 workspace 結構。
2. 優先驗證本機執行環境：`claude --version`、`codex --version`，以及各自支援的 help / CLI 參數；不要假設使用者一定已登入。
3. 實作單一聊天 UI、Provider 偵測、手動選擇 Claude / Codex、單次任務執行、streaming output、Stop / Cancel、清楚的錯誤回報，以及最基本的對話狀態管理。
4. 實作 `AgentAdapter` 抽象層，避免 UI 直接操作 CLI。CLI 版本有差異時，必須有 capability detection 與 graceful fallback。
5. V0.1 可先用 Claude Code 的非互動 CLI 與 Codex CLI `exec` 快速實作。Codex App Server 可作為下一階段更完整的 Session / approval / event API。若 App Server 已可穩定接入且不拖慢 MVP，可優先使用。
6. **V0.1 不允許兩個 Agent 同時寫入同一個 workspace，不開放無限制自主互相呼叫。**
7. 未取得使用者授權時，不執行有破壞性的操作、部署、Git push、安裝未知套件、讀取敏感檔案或將專案資料傳給未核准的 Provider。
8. 每個階段須有可重現的啟動步驟、測試和完成清單。實作完成後回報做了什麼、尚未做什麼、實際驗證結果和已知限制。
9. 遇到文件未明確定義的細節，採用最簡單、可替換且安全的實作方式，不必為非阻斷性小問題等待確認。

**V0.1 完成定義：** 使用者可在 VS Code 側邊欄輸入訊息，選擇 Claude 或 Codex，由已登入的官方本機工具處理，看到逐步輸出、執行狀態與失敗訊息，並可停止任務；沒有第二個 AI 也可以單獨運作。

---

## 1. 產品願景

建立一個 VS Code Extension，提供**單一 AI 對話入口**。使用者只需要描述開發任務，系統可以依照任務特性，把需求分析、程式實作、Code Review、測試和修復交給 Claude Code 與 Codex 執行。

### 預期體驗

使用者輸入：

> 幫我新增 Laravel 訂單 API，包含 Request Validation、Service、測試，以及 Vue 前端的串接檢查。

系統可逐步：

1. 解析需求、產生可視化 Task Plan。
2. 讓適合的 Agent 實作後端。
3. 讓另一個 Agent 檢查前端 API 介面或審查程式碼。
4. 根據 Review 結果，要求主 Agent 修正。
5. 由 Extension 統一驗收測試並彙整結果。
6. 顯示修改檔案、Diff、測試結果和未解決風險。

### 產品原則

- **一個 UI、兩個 Provider、多個 Task**，使用者不需要頻繁切換原生插件。
- **協調器掌控流程**：Agent 不自行無限制委派其他 Agent。
- **安全和成本可控**：外部模型請求、檔案修改、高風險操作受限。
- **Provider 可插拔**：未來不鎖死 Claude / Codex，支援擴充其他本機或雲端 Agent。
- **以本機優先**：初版不需要自行部署 Server、資料庫、使用者帳號系統或自建 OAuth。
- **漸進式開發**：先完成可靠的單 Agent UX，再加入自動拆分、交叉 Review、Git Worktree。

### 非目標（第一版明確不做）

- 不製作自己的 LLM、訓練模型或建置推論後端。
- 不自行攔截或儲存 Claude / Codex 登入憑證。
- 不透過反向工程登入流程假冒原生 Client。
- 不自動開啟付費 API 帳單或承諾零成本；沿用本機官方工具可用的既有授權，但執行仍會消耗額度，授權規範須遵守 Provider 政策。
- 不同時讓 Claude 和 Codex 修改同一工作目錄。
- 不提供多人同步、雲端協作、遠端執行或 VS Code Web 支援。
- 不在第一版做複雜的 token 精算、跨 Provider 的共享隱性記憶或無限自主迴圈。

---

## 2. 使用者與發佈策略

### Phase A：個人內部測試

- macOS、VS Code Desktop、本機 Node.js、Claude Code CLI、Codex CLI。
- 使用者自己在官方 CLI 完成登入；Extension 僅偵測可用性。
- 允許單一 Provider 可用時退化成普通 AI coding assistant。
- 安全預設為明確的 workspace 授權和有限工具權限。

### Phase B：開源給其他人

- 將平台依賴封裝、至少支援 macOS / Linux / Windows，確認 Windows 下 Shell / executable path / cancellation 行為。
- 提供 MIT / Apache-2.0 等授權選型評估、README、CHANGELOG、CONTRIBUTING、PR template、issue template。
- 提供設定 Migration、匿名診斷可選且預設關閉、清楚的 Provider 風險說明。
- 發佈前重新核對 Anthropic / OpenAI 當時的第三方客戶端、訂閱登入與品牌命名規範；不可將「個人本機測試可用」等同於「可公開散佈」。
- 不使用 Claude Code、Claude、Codex、OpenAI 等第三方名稱與 Logo 冒充本產品品牌或官方合作。

---

## 3. 產品介面設計

### VS Code Sidebar（Vue 3 Webview）

頁面構成：

1. Header：插件名稱、目前 Workspace、設定入口。
2. Providers：Claude Code 與 Codex 的 `Installed / Authenticated / Ready / Error / Unknown` 狀態；可操作 `Check connection`，未登入時提示在終端執行官方登入方式。
3. Conversation：使用者訊息、整合後 AI 回應、分別標註 Agent 的事件、程式碼區塊與錯誤。
4. Composer：多行輸入、送出、停止；模式切換 `Manual / Auto / Dual Review`（後兩種在功能未完成時顯示 disabled）。
5. Task Progress：顯示 Plan、各 Task 狀態、負責 Agent、執行耗時、錯誤與重試資訊。
6. Result：修改檔案清單、Diff 開啟連結、測試結果、Review Findings、需人工確認的操作。

### 模式

- **Manual**：使用者指定 Claude 或 Codex；V0.1 唯一必須可用模式。
- **Auto**：Planner 拆解、Router 指派、單一寫入 Agent、另一 Agent Review；V0.2。
- **Dual Review**：兩個 Agent 對同一目標分別做唯讀分析、合併異同；V0.3。
- 支援未來 `@claude`、`@codex` 指令路由，但 V0.1 可先以下拉選單代替。

### UI 技術要求

- Webview 與 Extension Host 使用 VS Code `postMessage` 雙向傳遞型別化消息。
- Vue 3 + TypeScript + Vite；支援 VS Code Theme 顏色 token、淺色 / 深色主題、鍵盤使用與基本 ARIA。
- 使用嚴格 CSP、nonce、`webview.asWebviewUri()`；不要在 Webview 暴露 Node.js / 任意 Shell 能力。
- 對 Agent 輸出的 Markdown / HTML 做安全渲染，避免 XSS；不要直接執行模型回傳的 JavaScript / HTML。
- 不直接透過 Webview 啟動子程序，所有程序都由 Extension Host 控制。

---

## 4. 推薦技術架構

```text
VS Code Desktop
└── Multi-Agent Workspace Extension
    ├── Vue 3 Webview
    │   ├── Chat / Provider Status / Task Board
    │   └── postMessage IPC
    └── Extension Host (TypeScript)
        ├── Webview Controller
        ├── Conversation / Session Store
        ├── AgentOrchestrator
        │   ├── TaskPlanner
        │   ├── TaskRouter
        │   ├── StateMachine
        │   ├── PolicyEngine
        │   └── ExecutionBudget / LoopGuard
        ├── Provider Registry
        │   ├── ClaudeCodeAdapter ── official claude CLI
        │   └── CodexAdapter ────── codex exec / app-server
        ├── Process Manager
        │   ├── spawn / stdout / stderr / events
        │   ├── Cancellation / Timeout / Kill tree
        │   └── Working Directory / Environment
        └── Workspace Tools
            ├── Git Diff / Git Worktree (later)
            ├── Test Runner (later)
            └── Audit Log / Data Redaction
```

### 第一版不需要 MCP Server

CLI Adapter 已足以完成 MVP。MCP 可以在後期用於標準化 Agent 能力暴露與多工具協作，但**不是防止無限循環的安全措施**，也不是登入服務的替代品。

### 建議目錄

```text
multi-agent-workspace/
├── package.json
├── tsconfig.json
├── README.md
├── SPEC.md
├── src/
│   ├── extension.ts
│   ├── views/
│   │   └── ChatWebviewProvider.ts
│   ├── bridge/
│   │   ├── messages.ts
│   │   └── protocol.ts
│   ├── agents/
│   │   ├── AgentAdapter.ts
│   │   ├── ClaudeCodeAdapter.ts
│   │   ├── CodexAdapter.ts
│   │   └── AgentRegistry.ts
│   ├── execution/
│   │   ├── ProcessManager.ts
│   │   ├── ExecutionPolicy.ts
│   │   └── Cancellation.ts
│   ├── orchestration/
│   │   ├── Orchestrator.ts
│   │   ├── TaskPlanner.ts
│   │   ├── TaskRouter.ts
│   │   └── StateMachine.ts
│   └── storage/
│       └── SessionRepository.ts
├── webview/
│   ├── src/
│   │   ├── App.vue
│   │   ├── components/
│   │   ├── stores/
│   │   └── types/
│   └── vite.config.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── docs/
    ├── security.md
    └── roadmap.md
```

可依實作需要適度簡化，但保留 Adapter、ProcessManager、Orchestrator 的邊界。

---

## 5. Provider Adapter 合約

UI 不應知道 Agent 的具體 CLI 命令，所有外部 Agent 均實作統一介面。

```ts
export type AgentId = 'claude' | 'codex';

export type AgentAvailability =
  | 'not-installed'
  | 'installed'
  | 'authenticated'
  | 'ready'
  | 'error'
  | 'unknown';

export interface AgentCapabilities {
  streaming: boolean;
  resumeSession: boolean;
  readOnly: boolean;
  toolApproval: boolean;
  structuredOutput: boolean;
}

export interface AgentRequest {
  taskId: string;
  prompt: string;
  cwd: string;
  mode: 'read-only' | 'workspace-write';
  sessionId?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'text-delta'; taskId: string; text: string }
  | { type: 'tool-start'; taskId: string; tool: string; detail?: string }
  | { type: 'tool-end'; taskId: string; tool: string; success: boolean }
  | { type: 'approval-required'; taskId: string; action: string; approvalId: string }
  | { type: 'usage'; taskId: string; detail: Record<string, unknown> }
  | { type: 'error'; taskId: string; message: string }
  | { type: 'complete'; taskId: string; sessionId?: string };

export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<{ status: AgentAvailability; version?: string; reason?: string }>;
  capabilities(): AgentCapabilities;
  execute(request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
```

**注意：** `read-only` 必須由 Provider 的實際 sandbox / tool permissions 強制落實，不能只在 prompt 寫「不要修改」。如果某個 CLI / 版本無法保證真正唯讀，就標記該 capability 不支援，或只在額外隔離環境使用。

### Claude Code Adapter

- 透過官方 `claude` CLI 執行，優先探索 `claude -p`、`--output-format stream-json`、`--permission-mode plan` 等能力。
- 依實際 CLI 版本檢查 streaming 的必要選項；JSON Lines 逐事件解析，不把 stdout 當成永遠純文字。
- 以原生官方登入流程為主；不要讀取 ~/.claude 的 token 或嘗試重做 OAuth。
- `plan` 模式可用於唯讀分析，但仍需考慮允許的工具、額外工作目錄和實際企業政策；不能僅憑 prompt 宣稱限制已完整生效。
- 對不可用的 flags、登入失敗、使用額度耗盡提供辨識與清楚提示。

### Codex Adapter

**V0.1 快速路徑：**

- 用官方 `codex exec` 子程序，使用實際可用的 JSON output / sandbox / approval 參數。
- Provider 驗證與業務執行分開，不能把版本查詢成功等同於登入有效。
- 單次任務支援 output、exit code、timeout、取消。

**V0.2+ 深度整合路徑：**

- 優先評估官方 `codex app-server` 的本機 `stdio` JSONL / JSON-RPC 通訊。
- 整合 account state、thread、turn、event streaming、approval、resume。
- 不把 WebSocket 遠端實驗性介面當成 MVP 的必要條件。
- 開始前進行 capability negotiation，別硬編死協定版本。

### Session 策略

- 會話持久化由 Extension 管理自己的 `Conversation` 和 `Task` metadata。
- Provider session ID 分別管理，不假設 Claude 的 session 能在 Codex 恢復，反之亦然。
- 跨 Agent 傳遞的是**經摘要、明確界定範圍的任務上下文與產出**，不是完整交換私人聊天或隱性推理內容。

---

## 6. 登入和帳號設計

### 個人 MVP

1. 使用者自己安裝 CLI 並在官方流程登入（例：在整合終端啟動 `claude`、`codex login`，實際命令依 CLI 版本）。
2. 插件偵測工具存在、版本、登入狀態及是否能安全執行。
3. 未登入時顯示操作提示，讓使用者使用官方 CLI 完成登入。
4. Extension **不記錄 token、cookie、OAuth refresh token、認證檔內容**。
5. 如有多個 Codex / Claude 帳號，第一版只讀取目前本機官方 CLI 使用的身分；不實作偷偷切換或憑證池輪替。
6. 顯示 `Installed` 不等於 `Ready`；授權失敗需可重試與清楚說明。

### 未來開源時的合規要求

- Claude Code 的第三方產品登入 / 訂閱使用方式有官方限制。**不可自行提供 Claude.ai 登入入口、收集或轉送其訂閱憑證。** 使用未修改官方 Claude Code 二進位檔且由終端使用者自己登入，也仍需要根據正式產品的部署和使用情境核對最新規範；若不符合，改用 Anthropic API Key 或支援的雲端 Provider。
- Codex 的 App Server 具備本機 authentication / account API，但公開發行或商業化時也要核對 OpenAI 當時對第三方產品與 Sign in with ChatGPT 的最新政策。
- 公司提供的 Claude Code **不等於允許個人 Codex 讀取公司原始碼**。應要求工作區級別的 Provider allowlist / 資料分類和使用者核准，且不能繞過公司 Managed Settings。

---

## 7. Orchestrator：任務拆分與協作

### V0.1：Manual Mode

```text
User message
  -> selected AgentAdapter
  -> stream events
  -> display result
```

### V0.2：Auto Mode

```text
User request
  -> Planner（指定 Claude 或 Codex，無需第三個模型）
  -> validate structured TaskPlan
  -> Policy check / data boundary check
  -> Task Router（依角色與依賴關係）
  -> Agent Execution
  -> Optional cross-review
  -> Validation
  -> Result Summary
```

### 任務模型

```ts
type TaskStatus =
  | 'pending' | 'running' | 'reviewing'
  | 'blocked' | 'completed' | 'failed' | 'cancelled';

type TaskRole = 'planner' | 'developer' | 'reviewer' | 'tester';

interface TaskNode {
  id: string;
  title: string;
  description: string;
  assignedAgent: 'claude' | 'codex';
  role: TaskRole;
  dependsOn: string[];
  status: TaskStatus;
  maxAttempts: number;
  attempts: number;
  permissions: 'read-only' | 'workspace-write';
  output?: string;
}

interface TaskPlan {
  requestId: string;
  tasks: TaskNode[];
  createdAt: string;
  revision: number;
}
```

### Planner 輸出驗證

- 要求 Planner 輸出可解析的 JSON，使用 schema validation（例如 Zod）。
- 必須驗證 ID 唯一、依賴 task 存在、DAG 無循環、角色可用、資源與數量不超出預算。
- 若 Planner 格式不合法：有限次修復後 fallback 至單 Agent Manual，不得無限重新請求。
- **Router 不可直接相信 Agent 產生的 Shell 命令或權限宣告**。

### 預設角色（可配置，不寫死）

- Claude：需求分析、設計、開發。
- Codex：開發、Code Review、測試檢查。
- 誰寫、誰審皆可反轉；是否選擇哪個 Provider 應依可用性、使用者設定及工作類型決策，而非假設某個模型必然較強。

### 合併 Review

Review finding 應具備：

```ts
interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file?: string;
  line?: number;
  issue: string;
  evidence?: string;
  suggestion?: string;
  reviewer: 'claude' | 'codex';
  status: 'open' | 'fixed' | 'rejected' | 'unverified';
}
```

重要 finding 必須能由程式碼、測試、靜態檢查或使用者確認支持，不應把 Agent 意見當成事實。

---

## 8. 防止無限循環與失控

**絕對原則：只有 Orchestrator 能建立下一個任務。** Agent Adapter 不能互相直接呼叫。若 Agent 嘗試請求額外委派，只能產生 `delegation-request` 交 Orchestrator 審核。

### Execution Policy（起始預設）

```ts
interface ExecutionPolicy {
  maxDelegationDepth: 1;
  maxReviewRounds: 3;
  maxConcurrentAgents: 2;
  maxConcurrentWriters: 1;
  maxTaskAttempts: 2;
  maxPlanTasks: 8;
  maxRuntimeMsPerTask: number;
  maxRuntimeMsPerRequest: number;
  requireApprovalForWorkspaceWrite: boolean;
  requireApprovalForGitPush: true;
  requireApprovalForDeploy: true;
  allowNestedAgentInvocation: false;
}
```

以上 `maxRuntime...` 的實際值要可設定；可用 180 秒做單一唯讀審查的起始測試值，較複雜的開發任務不可不合理地使用同一硬性限制。

### 狀態機

`idle -> planning -> awaiting-approval -> running -> reviewing -> validating -> completed`

失敗分支：`blocked / failed / cancelled / budget-exhausted`。

- Review 未通過：返回原**主寫入 Agent**修復，增加 `reviewRound`，最多 3 輪。
- 逾時、額度不足、連續失敗：停止並顯示需人工介入原因。
- 所有運行中的 task 都有 `AbortSignal`，Stop 要確實終止子程序／子程序樹並更新狀態。
- 上游失敗時下游依賴任務不得繼續執行。
- 不允許子 Agent 直接執行另一個 Agent CLI；不能只靠 prompt 或環境變數做安全保證。應結合 tool allowlist、process command policy、可控 sandbox 等實際限制。
- Task Plan、Review Loop、重試次數、執行時間的限制全部由程式碼強制，不依賴 LLM 自我約束。
- 重開 VS Code 後，不能把上次被中斷的工作誤判為成功；要有 recovery / interrupted 狀態。

---

## 9. 權限、安全及公司 / 個人資料邊界

### 最小授權

| 操作 | 預設策略 |
| --- | --- |
| 讀取目前授權 workspace 的必要檔案 | 允許，但受 Provider allowlist 約束 |
| 對未授權 Provider 傳送原始碼 | 禁止 |
| 副 Agent Review | 唯讀，無寫入權 |
| 修改程式碼 | 僅單一主寫入 Agent，需 Workspace 授權 |
| 執行任意 Shell | 限制／依風險要求核准 |
| Git commit | 明確核准或使用者設定 |
| Git push、部署、刪除大量檔案 | 必須人工核准 |
| 讀取 `.env`、SSH keys、雲端憑證、token、金鑰 | 預設拒絕 |
| 存取 Workspace 外部路徑 | 預設拒絕，明確授權才可擴充 |
| 自行呼叫另一個 Agent | 禁止；需經 Orchestrator |

### 工作區資料分類（MVP 可先做簡單版本）

- `personal`：個人專案；可根據已授權 Provider 使用。
- `company`：公司專案；**預設不允許個人 Codex**，需符合公司政策且有明確核准才可解除。
- `restricted`：高機密；預設關閉跨 Provider 傳送。
- `unclassified`：初次使用要求使用者決定分類，預設採最保守限制。

請勿只根據 Git remote domain 或 workspace 名稱自動判定為個人專案。

### 實作規則

- 不將 prompts、程式碼、log、token 傳送給自建的 telemetry server。
- 初版資料預設保存在本機 Extension storage；敏感資料用 VS Code SecretStorage，且原則上避免儲存 Provider token。
- Log 不包含 token、完整環境變數或敏感原始碼；必要時 redact。
- 不採用 `--dangerously-skip-permissions`、`--yolo` 等跳過安全機制的執行方式。
- Process Manager 使用參數陣列呼叫 spawn，不透過字串插值拼接 shell command（預設 `shell: false`）。
- Worktree 跨任務隔離留待後續版本。
- 若現有工具無法強制 sandbox，就降低功能範圍並回報，不宣稱已安全隔離。

---

## 10. Message Protocol 和狀態儲存

### Extension <-> Webview

```ts
type WebviewToHost =
  | { type: 'send-message'; requestId: string; text: string; provider: 'claude' | 'codex' }
  | { type: 'cancel-task'; taskId: string }
  | { type: 'check-providers' }
  | { type: 'load-conversation'; conversationId: string };

type HostToWebview =
  | { type: 'provider-status'; providers: Record<string, unknown> }
  | { type: 'task-created'; taskId: string; provider: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'task-state'; taskId: string; state: TaskStatus }
  | { type: 'conversation-loaded'; conversation: Record<string, unknown> }
  | { type: 'error'; requestId?: string; message: string };
```

- 消息應加 schema validation、版本與 request correlation ID。
- Stream event 大量輸出時適度批次更新 UI，避免 Webview 重繪過多。
- 不把 Provider 原始 stderr 直接當成可信 HTML 顯示。
- Session 儲存可先用 VS Code `workspaceState/globalState` + JSON metadata；若需大型對話記錄，再使用本機檔案或 SQLite，必須包含 migration 策略。

---

## 11. V0.1 ～ V1.0 路線圖與驗收標準

### V0.1：本機雙 Provider 的單一聊天介面（**立即開工**）

必做：

- [ ] 初始化 VS Code Extension + Vue 3 Webview 專案。
- [ ] `npm install`、build、lint、test 指令可運作。
- [ ] Activity Bar 或 Sidebar 可以開啟插件聊天畫面。
- [ ] 偵測 Claude、Codex binary 存在與版本；顯示基本登入 / 可用性狀態。
- [ ] 手動選擇 Claude 或 Codex，至少其中一個可用就能聊天。
- [ ] Provider Adapter 和 Process Manager 抽象介面。
- [ ] 可逐步顯示執行輸出，不需等待整個 CLI 完成才出現內容。
- [ ] 顯示 `running / completed / failed / cancelled` 狀態。
- [ ] Stop 按鈕能真正中斷執行程序。
- [ ] Provider 不存在、未登入、timeout、CLI exit non-zero 顯示可理解的錯誤。
- [ ] Workspace cwd 正確、沒有使用 Shell injection、不能跨未授權 Workspace。
- [ ] 基本聊天歷史可保存且重新開啟 Webview 後可顯示。
- [ ] README 提供 macOS 安裝、官方登入與 F5 Extension Development Host 測試步驟。

驗收情境：

1. Claude 可用、Codex 不可用：Claude 任務仍成功。
2. Codex 可用、Claude 不可用：Codex 任務仍成功。
3. 兩個都可用：切換 Provider 後可各自執行。
4. 長輸出：UI 可持續顯示且沒有明顯卡死。
5. 執行期間按 Stop：程序結束、UI 顯示 cancelled，不留孤兒程序。
6. CLI 回報未登入 / 額度不足：顯示錯誤與必要處理方式，不自動重試到失控。
7. 未授權的工作區：不能發送原始碼內容給 Provider。

### V0.2：Auto Planner + Task Board

- [ ] 新增 Auto 模式；可由指定 Planner Provider 產生 schema-validated TaskPlan。
- [ ] DAG dependency validation、Router、Task state machine。
- [ ] 顯示每一個 Task 所屬 Agent、開始結束時間、status、結果。
- [ ] 單一 writer + 多個唯讀 reviewer 的排程保護。
- [ ] 超時、重試、最大任務數、使用者取消。
- [ ] 跨 Agent 傳遞最小必要上下文、個人 / 公司資料邊界檢查。

驗收：輸入 Laravel + Vue 任務，Planner 正確拆分、建立依賴順序並至少完成一次跨 Provider 任務協作；禁止循環依賴和無限制委派。

### V0.3：Dual Review + 修復迴圈

- [ ] 平行唯讀 Review、結構化 findings 與去重。
- [ ] 主 Agent 修正 → 副 Agent Review → 自動驗收。
- [ ] 最多 3 輪；失敗後停止，交回人工處理。
- [ ] VS Code diff、測試結果與可追蹤的修復狀態。

驗收：可重現「修改 → 審查 → 修正 → 驗收」，超過最大輪數必須停止。

### V1.0：適合開源的多 Agent Workspace

- [ ] Codex App Server 更完整的 session、approval、streaming events 整合。
- [ ] Claude Code 官方支援的 session resume / non-interactive event 能力。
- [ ] Git Worktree 隔離的平行寫入（需先可證明隔離）。
- [ ] Windows、Linux 相容性測試。
- [ ] Provider 擴充介面與設定 UI。
- [ ] 安全審查、登入授權合規檢查、公開文件、授權聲明。
- [ ] 打包 VSIX 供本機安裝；準備 VS Code Marketplace 上架流程。

---

## 12. 測試策略

### Unit Tests

- AgentAdapter 的事件轉換與失敗處理。
- TaskPlan Zod schema、任務 DAG cycle detection。
- PolicyEngine：最大深度、重試次數、最大時間、禁止雙 writer。
- Data classification / Provider allowlist。
- Cancellation idempotency。

### Integration Tests

- 使用 Fake Agent CLI Fixtures 模擬 stdout、stderr、stream JSON、超時、exit code、登入失敗。
- 測試子程序被取消後真正停止。
- 模擬大量輸出、異常 JSONL、Provider 更新造成 event schema 變化。
- Webview <-> Host 消息收發與不同 workspace 隔離。

### Manual E2E

- 使用 Extension Development Host 與真實 Claude Code / Codex CLI。
- 在個人測試 Repository 驗證兩個 Provider。
- 取消任務、重啟視窗、無網路、未登入、額度不足等情境。

---

## 13. 核心風險及取捨

| 風險 | 影響 | 建議對策 |
| --- | --- | --- |
| CLI / App Server 版本改動 | 無法解析事件或參數失效 | Adapter + capability detection + version tests |
| Claude 第三方登入政策 | 公開發行或訂閱重用不符合條款 | MVP 僅官方本機 CLI；公開前合規審查及 API Key fallback |
| 公司 Claude / 個人 Codex 混用 | 公司原始碼與機密跨帳號外流 | Workspace 分類、Provider allowlist、明確核准、組織政策優先 |
| 兩個 Agent 同時修改 | 檔案互相覆蓋 | V0.x 只有一個 writer，V1.0 Worktree |
| Agent 互相無限呼叫 | 額度消耗及任務失控 | Orchestrator 唯一委派入口、depth 1、輪數及預算上限 |
| Agent 假裝測試通過 | 錯誤進入主分支 | 測試須由 ProcessManager 驗證 exit code，保留證據 |
| Streaming 終止不完整 | 遺留程序及資源 | AbortSignal + process tree shutdown + timeout |
| Markdown / Webview 注入 | XSS 或任意程式執行 | CSP、sanitize、typed IPC、Shell 隔離 |
| 無法精確讀取各方案額度 | UI 錯估剩餘流量 | 僅顯示官方可核實資料，不自行編造 token 餘額 |

---

## 14. 開始實作的順序（建議 Commit 粒度）

1. `chore: bootstrap vscode extension and vue webview` — F5 開啟空聊天面板。
2. `feat: add typed webview host protocol` — 發送訊息與事件可測。
3. `feat: implement process manager and agent adapters` — CLI 檢測、spawn、輸出、取消。
4. `feat: add manual provider chat` — 使用者可以 Claude / Codex 切換對話。
5. `feat: persist conversation and show execution states` — 紀錄、錯誤、重啟載入。
6. `test: add fake-cli integration tests and security checks` — 超時、取消、未登入、注入與安全測試。
7. `docs: complete setup and local-development instructions` — 新開發者可啟動。

**在 V0.1 驗收通過前，先不要開發 Auto Planner、MCP Bridge、平行 Worktree 或完整的開源帳號登入 UI。**

---

## 15. 官方參考資料（實作時以最新版本為準）

- VS Code Webview API：https://code.visualstudio.com/api/extension-guides/webview
- VS Code Webview UX Guidelines：https://code.visualstudio.com/api/ux-guidelines/webviews
- Codex App Server：https://learn.chatgpt.com/docs/app-server
- Codex App Server source：https://github.com/openai/codex/tree/main/codex-rs/app-server
- Codex authentication：https://learn.chatgpt.com/docs/auth
- Claude Code CLI reference：https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Claude Code legal / compliance：https://code.claude.com/docs/en/legal-and-compliance

> 註：官方 CLI flags、協定、認證及第三方使用規範可能隨版本改變；Codex 應以本機 `--help` 和最新官方文件檢查，避免硬編已變動或不支援的參數。

---

## 16. 最終期望交付物（第一階段）

- [ ] 可以在 VS Code Extension Development Host 執行的專案原始碼。
- [ ] 可用的 Vue Sidebar Chat UI。
- [ ] Claude / Codex 本機執行狀態及手動選擇。
- [ ] 兩個 Provider 的 Adapter（至少各自實測過一次）。
- [ ] Streaming、Timeout、Cancel、基本錯誤處理。
- [ ] 基本本機對話紀錄。
- [ ] 安全預設和不能使用時的 clear failure。
- [ ] README、測試指令、目前限制與後續 Roadmap。

**成功標準：** 使用者日常在同一個 VS Code 對話介面就能切換 Claude Code 或 Codex 來處理個人專案；V0.2 再進化為「我只提出需求，系統自動拆給兩個 AI」。
