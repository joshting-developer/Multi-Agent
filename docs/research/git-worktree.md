# MA-59 Git Worktree 隔離與合併流程評估

日期：2026-11-14。前提：規格 Mode D、§10「至多一個 Agent 同時寫入」、§11「暫時不做多 Agent 同檔平行寫入」。

## 結論

- 目前不實作。Auto Work（MA-54～58）還沒有單一 writer 流程，沒有平行寫入的實際需求；先做 worktree 只會多一套沒人用的狀態。
- 之後要做時，**由 Extension 自己管理 worktree 生命週期**，不依賴各 CLI 的內建功能。Claude Code 2.1.311 有 `-w, --worktree [name]`，Codex CLI 0.160～0.169 也有 `--worktree`（managed worktree），但兩邊的位置、命名和清理方式各自決定，Extension 無法統一記錄 base、分支和合併結果。交給 CLI 處理就會變成兩套流程。
- **Agent 只改檔案，commit、合併、回復都由 Orchestrator 執行**。理由見下方「沙箱限制」。

## 建議設計

| 項目 | 做法 |
| --- | --- |
| 位置 | `<repo>/.multi-agent/worktrees/<runId>`，加進 `.git/info/exclude`。不放 `/tmp`、`/private` 或 globalStorage，符合 git-delivery-workflow 的「Git 工作位置」規則，使用者也找得到 |
| 分支 | `multi-agent/<conversationId 前 8 碼>/<runId 前 8 碼>`，從使用者確認的 base commit 建立 |
| 前置檢查 | 主工作區有未提交修改時停止並詢問，不自動 stash；分支被其他 worktree 占用時回報，不使用 `--force` |
| 執行 | Agent 的 `cwd` 指向該 worktree，權限維持 workspace-write，資料政策沿用原專案的 canonical root |
| 交付 | Orchestrator 在 worktree 內 `git add -A && git commit`，把 diff 與測試結果交給 MA-58 呈現 |
| 合併 | 使用者確認後，在主工作區 `git merge --no-ff`，衝突時停止並列出檔案，不讓 Agent 自動解衝突 |
| 回復 | 合併前放棄即 `git worktree remove` 加刪分支；合併後用 `git revert -m 1 <merge>` |
| 紀錄 | run 保存 base SHA、分支、worktree 路徑、commit SHA、合併結果，寫進 MA-27 的 audit 事件 |
| 清理 | 完成或放棄後移除；啟動時用 `git worktree prune` 和 run 狀態比對，回收殘留 |

## 沙箱限制

worktree 的 `.git` 是指向主 repo `.git/worktrees/<name>` 的檔案。Codex workspace-write 沙箱只允許寫入 `cwd`（以及設定的 writable roots），所以 Agent 在 worktree 裡執行 `git commit` 會寫不到主 repo 的 `.git`。若為了讓它能 commit 而把主 `.git` 加進 writable roots，等於讓 Agent 能改其他分支和 refs，隔離就失效了。因此 Git 寫入一律由 Extension 處理。這個推論需要在實作時用真實 Codex 驗證一次。

## 成本與風險

- 每個 worktree 都要重新安裝依賴（例如 `node_modules`），磁碟和時間成本高，平行數要設上限，預設 2。
- 兩個 Agent 改到同一檔案時，衝突只是延後到合併才出現，並沒有消失；DAG 規劃（MA-54）仍應盡量讓寫入範圍不重疊。
- VS Code 開啟的資料夾是主工作區，worktree 裡的檔案不會出現在使用者的編輯器狀態中，需要靠 diff 檢視呈現。

## 啟動條件

MA-55 單一 writer 穩定，並出現一個實際的平行寫入案例時再開實作卡。實作卡沿用本卡原驗收條件：不同 worktree、可追溯的合併／衝突／回復流程、遵守 Git 工作位置規則。
