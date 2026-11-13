// MA-40 研究用：確認打包的 sql.js 支援哪些全文索引，並比較 instr 子字串與 FTS4＋CJK bigram。
// 執行：node scripts/search-index-probe.mjs [筆數...]，預設 20000 100000。
import initSqlJs from 'sql.js';

const CJK_RUN = /[㐀-鿿豈-﫿぀-ヿ가-힯]+/gu;
const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/u;
const bigrams = run => { const c = [...run]; return c.length === 1 ? c : c.slice(0, -1).map((ch, i) => ch + c[i + 1]); };
/** 索引端：CJK 連續字串展開成 bigram，其餘交給 unicode61。 */
export const segment = text => text.replace(CJK_RUN, run => ' ' + bigrams(run).join(' ') + ' ');
/** 查詢端：CJK 詞轉片語查詢，英數詞做前綴查詢；單一 CJK 字回傳 undefined，需降級為子字串。 */
export const toMatch = query => {
  const parts = query.trim().split(/\s+/).filter(Boolean).map(word => {
    if (!CJK.test(word)) return word.replace(/["*]/g, '') + '*';
    if ([...word].length < 2) return undefined;
    return '"' + bigrams(word).join(' ') + '"';
  });
  return parts.includes(undefined) ? undefined : parts.join(' ');
};

const SQL = await initSqlJs();
const probe = new SQL.Database();
const attempt = sql => { try { probe.exec(sql); return 'ok'; } catch (error) { return error.message; } };
console.log('sqlite', probe.exec('select sqlite_version()')[0].values[0][0]);
console.log('fts5 trigram', attempt("create virtual table a using fts5(b, tokenize='trigram')"));
console.log('fts4 unicode61', attempt('create virtual table c using fts4(b, tokenize=unicode61)'));
console.log('fts4 icu', attempt('create virtual table d using fts4(b, tokenize=icu)'));

const docs = ['資料庫連線失敗 ECONNREFUSED 127.0.0.1', 'Codex 討論輪次逾時', '逾時', 'Claude 回覆：建議使用 git worktree 隔離', 'sql.js 不支援 FTS5'];
probe.exec("create virtual table f using fts4(content='', seg)");
docs.forEach((doc, i) => probe.run('insert into f(docid,seg) values(?,?)', [i + 1, segment(doc)]));
probe.run('insert into c(docid,b) values(1,?)', [docs[0]]);
console.log('unicode61 直接查「連線」', probe.exec("select docid from c where c match '連線'").length ? '命中' : '未命中');
for (const term of ['連線', '連線失敗', '輪次逾時', '逾時', '時', 'econnrefused', 'econn', 'worktree', 'FTS5', '127.0.0.1']) {
  const match = toMatch(term);
  const hits = match ? (probe.exec('select docid from f where f match ?', [match])[0]?.values.flat() ?? []) : docs.flatMap((d, i) => d.toLowerCase().includes(term.toLowerCase()) ? [i + 1] : []);
  console.log(term.padEnd(14), match ?? '降級為子字串', JSON.stringify(hits));
}

const words = ['資料庫', '連線', '失敗', '討論', '輪次', '逾時', '模型', 'Codex', 'Claude', 'worktree', 'error', 'timeout', '設定', '帳號', '搜尋', '歷史', '訊息', '核准', '程序', '匯出'];
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
for (const n of sizes.length ? sizes : [20000, 100000]) {
  const indexed = new SQL.Database(); const plain = new SQL.Database();
  indexed.exec("create table m(id integer primary key, body text); create virtual table f using fts4(content='', seg)");
  plain.exec('create table m(id integer primary key, body text)');
  indexed.exec('begin'); plain.exec('begin');
  const a = indexed.prepare('insert into m values(?,?)'), b = indexed.prepare('insert into f(docid,seg) values(?,?)'), c = plain.prepare('insert into m values(?,?)');
  let started = Date.now();
  for (let i = 1; i <= n; i++) {
    let body = '';
    for (let k = 0; k < 120; k++) body += words[(i * 7 + k * 13 + (k * k) % 17) % words.length] + (k % 5 ? '' : ' ');
    if (i % 997 === 0) body += ' 唯一關鍵字XYZ';
    a.run([i, body]); b.run([i, segment(body)]); c.run([i, body]);
  }
  a.free(); b.free(); c.free(); indexed.exec('commit'); plain.exec('commit');
  const buildMs = Date.now() - started;
  const time = (db, sql) => { const t = Date.now(); const v = db.exec(sql)[0].values[0][0]; return [v, Date.now() - t]; };
  const [instrHits, instrMs] = time(plain, "select count(*) from m where instr(lower(body),'唯一關鍵字')>0");
  const [ftsHits, ftsMs] = time(indexed, `select count(*) from f where f match '${toMatch('唯一關鍵字')}'`);
  started = Date.now(); const indexedBytes = indexed.export().length; const exportMs = Date.now() - started;
  const plainBytes = plain.export().length;
  console.log(JSON.stringify({ messages: n, instrHits, instrMs, ftsHits, ftsMs, plainMB: +(plainBytes / 2 ** 20).toFixed(1), indexedMB: +(indexedBytes / 2 ** 20).toFixed(1), indexedExportMs: exportMs, buildMs }));
  indexed.close(); plain.close();
}
