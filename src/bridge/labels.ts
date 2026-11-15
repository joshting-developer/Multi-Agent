import type { AgentId, ProviderStatus, WorkspacePolicy } from './messages';

/** 官方工具代碼對應的介面名稱；不認得的維持原名（例如 MCP 工具名稱）。 */
const tools: Record<string, string> = {
  commandExecution: '執行命令', fileChange: '修改檔案', mcpToolCall: 'MCP 工具', webSearch: '網頁搜尋', imageView: '檢視圖片', todoList: '待辦清單', contextCompaction: '整理上下文',
  Bash: '執行命令', Read: '讀取檔案', Edit: '修改檔案', MultiEdit: '修改檔案', Write: '寫入檔案', NotebookEdit: '修改筆記本', Grep: '搜尋內容', Glob: '搜尋檔案',
  WebFetch: '讀取網頁', WebSearch: '網頁搜尋', Task: '子任務', TodoWrite: '待辦清單', tool: '工具'
};
export const toolLabel = (name: string): string => tools[name] ?? name;
export const providerLabel = (id: AgentId): string => id === 'claude' ? 'Claude Code' : 'Codex';
export const statusLabels: Record<ProviderStatus['status'], string> = { ready: '已連線', authenticated: '已登入', installed: '已安裝', 'not-installed': '未安裝', error: '連線失敗', unknown: '尚未檢查' };
export const classificationLabels: Record<WorkspacePolicy['classification'], string> = { personal: '個人專案', company: '公司專案', restricted: '限制資料', unclassified: '尚未分類' };
