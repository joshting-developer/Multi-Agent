import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Inspect the real VS Code renderer; used only in an isolated development host. */
export async function captureChat(port, output, surface = 'chat') {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const requests = new Map();
  socket.addEventListener('close', () => {
    for (const pending of requests.values()) pending.reject(new Error('VS Code renderer disconnected during capture'));
    requests.clear();
  });
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const pending = requests.get(response.id);
    if (!pending) return;
    requests.delete(response.id);
    if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
    else pending.resolve(response.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id; requests.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  try {
    const { targetInfos } = await call('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page' && target.url.includes('workbench'));
    assert.ok(page, 'VS Code workbench renderer must exist');
    if (surface === 'settings') {
      let settingsSession;
      const findDocument = `const documents = [document]; let settingsDocument; for (let index = 0; index < documents.length && index < 20; index++) { const candidate = documents[index]; if (!candidate) continue; if (candidate.querySelector('.settings-page')) { settingsDocument = candidate; break; } for (const iframe of candidate.querySelectorAll('iframe')) { try { documents.push(iframe.contentDocument); } catch {} } }`;
      for (const target of targetInfos.filter(target => target.type === 'iframe' || target.type === 'page')) {
        const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const found = await call('Runtime.evaluate', { expression: `(() => { ${findDocument} if (!settingsDocument) return false; settingsDocument.querySelectorAll('nav button')[1].click(); return true; })()`, returnByValue: true }, attached.sessionId);
        if (found.result.value === true) { settingsSession = attached.sessionId; break; }
      }
      assert.ok(settingsSession, 'The real Vue settings page must be present');
      const deadline = Date.now() + 10000;
      while (true) {
        const populated = await call('Runtime.evaluate', { expression: `(() => { ${findDocument} const select = settingsDocument?.querySelector('select[aria-label="模型"]'); const model = Array.from(select?.options ?? []).find(option => option.value); if (!model) return false; select.value = model.value; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, returnByValue: true }, settingsSession);
        if (populated.result.value === true) break;
        if (Date.now() > deadline) throw new Error('Real model catalog did not populate the settings page');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await call('Runtime.evaluate', { expression: `(() => { ${findDocument} const select = settingsDocument.querySelector('select[aria-label="推理強度"]'); select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true })); })()` }, settingsSession);
      await call('Runtime.evaluate', { expression: `(() => { ${findDocument} settingsDocument.querySelector('form').requestSubmit(); })()` }, settingsSession);
      while (true) {
        const saved = await call('Runtime.evaluate', { expression: `(() => { ${findDocument} return settingsDocument?.querySelector('.settings-footer')?.textContent.includes('已儲存'); })()`, returnByValue: true }, settingsSession);
        if (saved.result.value === true) break;
        if (Date.now() > deadline) throw new Error('Settings did not persist through the real webview bridge');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      console.log('SETTINGS_SAVE_PASS: real Vue model/effort selection persisted in isolated VS Code settings');
    }
    if (surface === 'history') {
      const findDocument = `const documents = [document]; let chat; for (let index=0; index<documents.length && index<20; index++) { const candidate=documents[index]; if (!candidate) continue; if(candidate.querySelector('.workspace .chat-toolbar')) { chat=candidate; break; } for(const frame of candidate.querySelectorAll('iframe')) { try { documents.push(frame.contentDocument); } catch {} } }`;
      let chatSession;
      for (const target of targetInfos.filter(target => target.type === 'iframe' || target.type === 'page')) {
        const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const found = await call('Runtime.evaluate', { expression: `(() => { ${findDocument} if(!chat) return false; chat.querySelector('button[aria-label="歷史對話"]').click(); return true; })()`, returnByValue: true }, attached.sessionId);
        if(found.result.value === true) { chatSession=attached.sessionId; break; }
      }
      assert.ok(chatSession, 'Real chat must be available');
      const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression: `(() => { ${findDocument} ${expression} })()`, returnByValue: true }, chatSession);
        if(result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      const waitUntil = async expression => {
        const deadline=Date.now()+10000;
        while(!await evaluate(expression)) { if(Date.now()>deadline) throw new Error('History UI did not settle: '+expression+' '+await evaluate('return chat.body.innerText.slice(-2000);')); await new Promise(resolve=>setTimeout(resolve,100)); }
      };
      await waitUntil(`return chat.querySelector('.history-item')?.textContent.includes('歷史對話驗證');`);
      await evaluate(`const input=chat.querySelector('.history-search'); input.value='注入失敗'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
      await waitUntil(`return chat.querySelector('.history-preview')?.textContent.includes('注入失敗');`);
      await evaluate(`chat.querySelector('.history-open').click();`);
      await waitUntil(`return chat.querySelector('.conversation')?.textContent.includes('HISTORY_REOPEN_OK') && !chat.querySelector('button[aria-label="新增對話"]').disabled;`);
      await evaluate(`chat.querySelector('button[aria-label="新增對話"]').click();`);
      await waitUntil(`return !!chat.querySelector('.empty-state');`);
      await evaluate(`chat.querySelector('button[aria-label="歷史對話"]').click();`);
      await waitUntil(`return !!chat.querySelector('.history-item');`);
      await evaluate(`chat.querySelector('.history-open').click();`);
      await waitUntil(`return chat.querySelector('.conversation')?.textContent.includes('HISTORY_REOPEN_OK') && !chat.querySelector('button[aria-label="新增對話"]').disabled;`);
      console.log('HISTORY_HOST_PASS: reopened SQLite conversation, searched Chinese message content, created a new conversation and returned to saved history');
      await evaluate(`chat.querySelector('button[aria-label="歷史對話"]').click();`);
    }
    const { sessionId } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const result = await call('Runtime.evaluate', {
      expression: `(() => {
        const element = document.querySelector('${surface === 'settings' ? '.part.editor' : '.part.auxiliarybar'}');
        const rect = element?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: element.innerText } : null;
      })()`, returnByValue: true
    }, sessionId);
    const bounds = result.result.value;
    if (!bounds || bounds.width <= 150 || bounds.height <= 150) {
      const diagnostic = await call('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('.part')).map(element => ({ className: element.className, width: element.clientWidth, height: element.clientHeight, title: element.innerText.slice(0, 80) }))`, returnByValue: true }, sessionId);
      console.log('Chat placement diagnostic:', JSON.stringify({ bounds, parts: diagnostic.result.value, exception: result.exceptionDetails?.text }));
      const screenshot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output + '.diagnostic.png', Buffer.from(screenshot.data, 'base64'));
    }
    assert.ok(bounds?.width > 150 && bounds?.height > 150, `${surface} must be visible in its native VS Code location`);
    assert.match(bounds.text, /multi-agent/i, 'The native sidebar must contain the Multi-Agent tab');
    const { data } = await call('Page.captureScreenshot', { format: 'png', clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 } }, sessionId);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(data, 'base64'));
    console.log(`PLACEMENT_PASS: ${surface}, screenshot ${output}`);
  } finally { socket.close(); }
}
