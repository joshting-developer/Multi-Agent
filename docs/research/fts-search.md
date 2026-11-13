# MA-40 全文索引與中文查詢評估

日期：2026-11-14。對象：sql.js 1.16.0（SQLite 3.54.1），0.1.5 的 `ConversationDatabase`。

## 結論

- **打包的 sql.js 沒有 FTS5**，只編了 FTS3／FTS4；`tokenize=icu` 也不可用。規格 ADR-008「先 FTS5」在目前驅動下做不到。
- FTS4 的 `unicode61` 把整段中文視為一個 token，直接查「連線」不會命中。可行做法是在應用層把中文展開成 bigram 再寫入 FTS4，查詢時轉成片語。
- 目前不導入索引，維持現行 `instr` 子字串搜尋。實際歷史庫只有 248 KB；10 萬則訊息的全掃描約 180 ms，仍在可用範圍。導入索引後，資料庫會變大約 65%，sql.js 每次寫入又都要匯出整個檔案，現階段代價大於收益。

## 實測

重現：`node scripts/search-index-probe.mjs [筆數...]`。每則合成訊息約 360 個中英混合字元。

| 項目 | 結果 |
| --- | --- |
| `fts5`（含 trigram） | `no such module: fts5` |
| `fts4 tokenize=unicode61` | 可建立；中文無法查到子詞 |
| `fts4 tokenize=icu` | `unknown tokenizer: icu` |
| FTS4＋bigram：連線、連線失敗、輪次逾時、逾時 | 皆正確命中 |
| FTS4＋bigram：單一中文字「時」 | 無 bigram，需降級為子字串 |
| 英數：econnrefused、econn（前綴）、worktree、FTS5、127.0.0.1 | 皆正確命中 |

| 訊息數 | instr 全掃描 | FTS4 查詢 | 無索引大小 | 含索引大小 | 含索引匯出 |
| --- | --- | --- | --- | --- | --- |
| 20,000 | 39 ms | 1 ms | 15.7 MB | 23.6 MB | 15 ms |
| 100,000 | 180 ms | <1 ms | 78.3 MB | 130.4 MB | 72 ms |

查詢的瓶頸不在搜尋本身。`mutate()` 每次寫入都會讀回整個檔案、重建 `Database`，再匯出原子替換。資料庫達到百 MB 級時，每送出一則訊息都要搬動整份檔案，這比搜尋慢更早出問題，屬於 MA-45 的範圍。

## 方案比較

| 方案 | 優點 | 問題 |
| --- | --- | --- |
| A. 維持 instr 子字串（現行） | 中文、錯誤碼都能字面命中，無遷移 | 線性掃描、無排序，10 萬則以上偏慢 |
| B. sql.js FTS4＋應用層 bigram | 不換驅動，查詢 <1 ms，可用 `snippet()` | 單字需降級；索引約多 65%；有 `matchinfo` 但沒有 bm25 |
| C. 自建含 FTS5 的 sql.js WASM | 可用 trigram、bm25、`highlight()` | 要自己維護 Emscripten 建置與升版，供應鏈責任變重 |
| D. `node:sqlite` | 原生 FTS5，可用 WAL | 要看 VS Code 內建 Node 版本；`engines.vscode ^1.95` 不保證可用，Remote Extension Host 也要另驗 |
| E. better-sqlite3 等 native addon | 效能最好 | Electron ABI 與跨平台打包，已在架構上排除 |

## 建議

1. 現階段維持 A，正式寫明降級規則：查詢含單一中文字或特殊符號時一律走子字串。目前已經是這樣。
2. 符合任一條件時再實作 B：單一專案訊息超過 5 萬則、搜尋 p95 超過 200 ms，或 MA-41／42 需要排序與片段。實作方式為 contentless FTS4 外加 `messages` 觸發同步，遷移時一次回填；舊資料不動，索引可隨時重建。
3. C／D 留到 MA-45 決定儲存引擎時一起評估。換驅動的同時才值得改成 FTS5，避免索引格式做兩次。
4. 不引入 Embedding 或向量資料庫，見 [MA-76](semantic-search.md)。
