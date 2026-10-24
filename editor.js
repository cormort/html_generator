/* HTML Editor Ultimate · Pro (AI/AST/Monaco)
 * 功能摘要：
 * - Monaco & CodeMirror 可切換（Monaco 載入失敗自動降級 CodeMirror）
 * - Markdown/HTML 預覽（防呆同步定位、互動元素不擋點擊）
 * - 大型文件效能優化（debounce / lazy outline）
 * - AI Replace：Acorn AST 精準替換 JS function（含 ESM）；CSS 規則平衡括號匹配
 * - 多檔分頁（無限 Tab）儲存 localStorage
 */
(function () {
  // ---------- Utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const debounce = (fn, ms = 300) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 極簡 AST walker（取代 acorn-walk CDN 依賴——其全域名稱隨版本變動，容易斷掉）
  const walkAST = (node, visitors) => {
    if (!node || typeof node !== 'object') return;
    if (visitors[node.type]) visitors[node.type](node);
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const item of v) walkAST(item, visitors); }
      else if (v && typeof v === 'object') walkAST(v, visitors);
    }
  };

  let _toastTimer = null;
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  };
  const storage = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; } }
  };

  // ---------- Store (Tabs) ----------
  const STORE_TABS = 'heu_tabs_v2';
  const STORE_ACTIVE = 'heu_active_tab';
  const DEFAULT_TAB = () => ({ id: uid(), name: 'index.html', mode: 'html', content: '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8"/>\n  <title>新文件</title>\n</head>\n<body>\n  <h1>Hello, world!</h1>\n</body>\n</html>' });

  const Tabs = {
    list: [],
    activeId: null,
    load() {
      try {
        const saved = storage.get(STORE_TABS, []);
        const raw = (Array.isArray(saved) && saved.length) ? saved : [DEFAULT_TAB()];
        // 正規化：舊版/損壞的 tab 補上缺欄位
        this.list = raw.map(t => ({
          id: (t && t.id) || uid(),
          name: (t && t.name) || 'untitled.html',
          mode: (t && t.mode) || 'html',
          content: (t && t.content) || ''
        }));
        const savedActiveId = storage.get(STORE_ACTIVE, null);
        this.activeId = this.list.some(t => t.id === savedActiveId) ? savedActiveId : this.list[0].id;
      } catch (err) {
        console.error('Tabs load failed:', err);
        this.list = [DEFAULT_TAB()];
        this.activeId = this.list[0].id;
      }
    },
    save() { return storage.set(STORE_TABS, this.list) && storage.set(STORE_ACTIVE, this.activeId); },
    // 切換前先把編輯器內容寫回目前分頁：change 有 300ms debounce，不 flush 會丟掉最後幾個字
    flush() { if (App.editor && this.active) this.active.content = App.editor.getValue(); },
    get active() { return this.list.find(t => t.id === this.activeId); },
    setActive(id) {
      if (this.list.some(t => t.id === id)) {
        this.flush();
        this.activeId = id;
        this.save();
        App.renderTabs();
        App.syncMdToggle();
        App.editor.load(this.active.content, this.active.mode);
      }
    },
    add(name = 'untitled.html', mode = 'html', content = '') { this.flush(); const t = { id: uid(), name, mode, content }; this.list.push(t); this.activeId = t.id; this.save(); App.renderTabs(); App.syncMdToggle(); App.editor.load(content, mode); },
    rename(id, name) { const t = this.list.find(x => x.id === id); if (t) { t.name = name; this.save(); App.renderTabs(); } },
    remove(id) {
      const i = this.list.findIndex(x => x.id === id);
      if (i < 0) return;
      this.flush();
      const removed = this.list.splice(i, 1)[0];
      if (removed.id === this.activeId) {
        const next = this.list[i] || this.list[i - 1] || this.list[0];
        this.activeId = next && next.id;
      }
      this.save();
      App.renderTabs();
      if (this.active) {
        App.syncMdToggle();
        App.editor.load(this.active.content, this.active.mode);
      } else {
        // 最後一個分頁被刪 → 重建預設分頁，避免編輯器變成孤兒
        this.list = [DEFAULT_TAB()];
        this.activeId = this.list[0].id;
        this.save();
        App.renderTabs();
        App.syncMdToggle();
        App.editor.load(this.list[0].content, this.list[0].mode);
      }
    },
    updateActiveContent(newText) { if (!this.active) return true; this.active.content = newText; return this.save(); }
  };

  // ---------- Editor Adapters ----------
  class CodeMirrorAdapter {
    constructor(host) { this.host = host; this.cm = null; }
    async init(text, mode, theme) {
      const ta = $('#cm-textarea');
      this.cm = CodeMirror.fromTextArea(ta, {
        mode: this._modeOf(mode), theme: theme === 'default' ? 'default' : theme,
        lineNumbers: true, lineWrapping: true, autoCloseTags: true, styleActiveLine: true
      });
      this.cm.setValue(text || '');
      this.cm.clearHistory();
      this.cm.on('change', debounce(() => App.onEditorChange(this.getValue()), 300));
      return this;
    }
    _modeOf(mode) { return mode === 'md' ? 'markdown' : (mode === 'css' ? 'css' : (mode === 'js' ? 'javascript' : 'htmlmixed')); }
    getValue() { return this.cm.getValue(); }
    setValue(text, mode) { if (mode) this.cm.setOption('mode', this._modeOf(mode)); this.cm.setValue(text ?? ''); this.refresh(); }
    // 換分頁用：清空 undo，避免 Ctrl+Z 把上一個分頁的內容倒進來
    load(text, mode) { this.setValue(text, mode); this.cm.clearHistory(); }
    setMode(mode) { this.cm.setOption('mode', this._modeOf(mode)); }
    refresh() { setTimeout(() => this.cm && this.cm.refresh(), 50); }
    find(regex) { const c = this.cm.getSearchCursor(regex); return c.findNext() ? c : null; }
    jumpTo(line) {
      this.cm.setCursor(line, 0);
      this.cm.scrollIntoView({ line, ch: 0 }, 200);
      this.cm.focus();
      this._highlightPairLines(line);
    }
    _highlightPairLines(startLine) {
      const doc = this.cm.getDoc();
      let braceCount = 0;
      const first = doc.getLine(startLine) || '';
      for (const ch of first) { if (ch === '{') braceCount++; else if (ch === '}') braceCount--; }
      if (braceCount <= 0) return; // 該行沒有開啟區塊 → 不高亮
      let endLine = startLine;
      for (let i = startLine + 1; i < doc.lineCount(); i++) {
        const text = doc.getLine(i);
        for (const ch of text) { if (ch === '{') braceCount++; else if (ch === '}') braceCount--; }
        if (braceCount <= 0) { endLine = i; break; }
      }
      const cls = 'cursor-line-highlight';
      this.cm.addLineClass(startLine, 'background', cls);
      if (endLine !== startLine) this.cm.addLineClass(endLine, 'background', cls);
      setTimeout(() => {
        this.cm.removeLineClass(startLine, 'background', cls);
        if (endLine !== startLine) this.cm.removeLineClass(endLine, 'background', cls);
      }, 1500);
    }
    setTheme(theme) { this.cm.setOption('theme', theme === 'default' ? 'default' : theme); }
  }

  class MonacoAdapter {
    constructor(host) { this.host = host; this.editor = null; this._highlightDecs = []; }
    async init(text, mode, theme) {
      await this._ensureMonaco();
      this.host.innerHTML = '<div id="monaco"></div>';
      const lang = this._langOf(mode);
      this.editor = monaco.editor.create($('#monaco'), {
        value: text || '', language: lang, theme: this._themeOf(theme), minimap: { enabled: false }, automaticLayout: true
      });
      this.disposer = this.editor.onDidChangeModelContent(debounce(() => App.onEditorChange(this.getValue()), 300));
      return this;
    }
    async _ensureMonaco() {
      if (window.monaco) return;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Monaco loader timeout')), 15000);
        try {
          window.require.config({ paths: { 'vs': window.__MONACO_BASE__ + 'vs' } });
          window.require(['vs/editor/editor.main'], () => { clearTimeout(timer); resolve(); });
        } catch (e) { clearTimeout(timer); reject(e); }
      });
    }
    _themeOf(theme) { return theme === 'dracula' ? 'vs-dark' : (theme === 'material' ? 'vs-dark' : 'vs'); }
    _langOf(mode) { return mode === 'md' ? 'markdown' : (mode === 'css' ? 'css' : (mode === 'js' ? 'javascript' : 'html')); }
    getValue() { return this.editor.getValue(); }
    // executeEdits 保留 undo（美化/智能替換/清空可 Ctrl+Z）；editor.setValue 會清掉 undo，只給換分頁用
    setValue(text, mode) {
      if (mode) this.setMode(mode);
      this.editor.pushUndoStop();
      this.editor.executeEdits('app', [{ range: this.editor.getModel().getFullModelRange(), text: text ?? '' }]);
      this.editor.pushUndoStop();
    }
    load(text, mode) {
      if (mode) this.setMode(mode);
      this.editor.setValue(text ?? '');
    }
    setMode(mode) {
      const model = this.editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, this._langOf(mode));
    }
    refresh() {}
    find(regex) { /* naive find: return first match range */
      const text = this.getValue();
      const m = text.match(regex);
      if (!m) return null;
      const idx = m.index || 0;
      const until = text.slice(0, idx);
      const line = until.split('\n').length - 1;
      const ch = until.split('\n').pop().length;
      return { from: { line, ch }, to: { line, ch: ch + (m[0]?.length || 0) } };
    }
    jumpTo(line) {
      this.editor.revealLineInCenter(line + 1);
      this.editor.setPosition({ lineNumber: line + 1, column: 1 });
      this.editor.focus();
      this._highlightPairLines(line);
    }
    _highlightPairLines(startLine) {
      const model = this.editor.getModel();
      const total = model.getLineCount();
      let braceCount = 0;
      const first = model.getLineContent(startLine + 1) || ''; // Monaco 行號從 1 起算
      for (const ch of first) { if (ch === '{') braceCount++; else if (ch === '}') braceCount--; }
      if (braceCount <= 0) return;
      let endLine = startLine;
      for (let i = startLine + 1; i < total; i++) {
        const text = model.getLineContent(i + 1);
        for (const ch of text) { if (ch === '{') braceCount++; else if (ch === '}') braceCount--; }
        if (braceCount <= 0) { endLine = i; break; }
      }
      const oldDecs = this._highlightDecs || [];
      const decs = [];
      decs.push({ range: new monaco.Range(startLine + 1, 1, startLine + 1, 1), options: { isWholeLine: true, className: 'cursor-line-highlight' } });
      if (endLine !== startLine) decs.push({ range: new monaco.Range(endLine + 1, 1, endLine + 1, 1), options: { isWholeLine: true, className: 'cursor-line-highlight' } });
      this._highlightDecs = this.editor.deltaDecorations(oldDecs, decs);
      setTimeout(() => { this._highlightDecs = this.editor.deltaDecorations(this._highlightDecs, []); }, 1500);
    }
    setTheme(theme) { monaco.editor.setTheme(this._themeOf(theme)); }
  }

  // ---------- Preview Module ----------
  const Preview = {
    frame: $('#preview'),
    update(content, isMd) {
      let html = content;
      if (isMd) {
        html = `<style>body{font-family:sans-serif;padding:20px;line-height:1.6}img{max-width:100%}</style>` + marked.parse(content || '');
      } else {
        const syncScript = `<script>
(function(){
  // sandbox 無 allow-same-origin → 存取 localStorage 會丟 SecurityError；換成記憶體版讓頁面照常運作
  try { window.localStorage; } catch (err) {
    var mk = function(){
      var d = Object.create(null);
      return { getItem:function(k){ return k in d ? d[k] : null; }, setItem:function(k,v){ d[k] = String(v); },
        removeItem:function(k){ delete d[k]; }, clear:function(){ d = Object.create(null); },
        key:function(i){ return Object.keys(d)[i] || null; }, get length(){ return Object.keys(d).length; } };
    };
    Object.defineProperty(window, 'localStorage', { value: mk() });
    Object.defineProperty(window, 'sessionStorage', { value: mk() });
  }
  // 點擊同步定位：不攔截事件（頁面自己的 click 處理照常觸發）；
  // 互動元素不同步，否則編輯器 focus 會搶走輸入框焦點
  var INTERACTIVE = 'a,button,input,select,textarea,label,[contenteditable],[onclick]';
  document.addEventListener('click', function(e){
    var t = e.target;
    if (t.closest && t.closest(INTERACTIVE)) return;
    try {
      var cls = '';
      if (t.className) cls = (typeof t.className === 'string') ? t.className : (t.className.baseVal || '');
      window.parent.postMessage({type:'sync', tag:t.tagName, id:t.id, 'class':cls, text:(t.innerText||'').slice(0,50)}, '*');
    } catch(err) {}
  }, true);
  window.addEventListener('message', function(e){
    if (e.data && e.data.type === 'highlight') {
      document.querySelectorAll('[data-highlight]').forEach(function(el){ el.style.background=''; delete el.dataset.highlight; });
      var sel = e.data.selector;
      if (sel) { var el = document.querySelector(sel); if (el) { el.style.background='yellow'; el.dataset.highlight='true'; } }
    }
  });
})();
<\/script>`;
        // 插在最前面（<head> 後），storage 替身才會早於頁面腳本生效
        const m = /<head\b[^>]*>/i.exec(content) || /<html\b[^>]*>/i.exec(content) || /<!doctype[^>]*>/i.exec(content);
        const at = m ? m.index + m[0].length : 0;
        html = content.slice(0, at) + syncScript + content.slice(at);
      }
      this.frame.srcdoc = html;
    }
  };

  // ---------- Outline Module ----------
  const Outline = {
    build(filter, isMd, text) {
      const container = $('#outline-container');
      container.replaceChildren();
      if (isMd) {
        const div = document.createElement('div');
        div.style.cssText = 'padding:10px;color:#888';
        div.textContent = 'Markdown 模式不支援結構';
        container.appendChild(div);
        return;
      }
      const lines = (text || '').split('\n');
      const reH = /<(h[1-6])([^>]*)>(.*?)<\/\1>/i;
      const reId = /id=["']([^"']+)["']/i;
      const reClass = /class=["']([^"']+)["']/i;
      const reFunc = /(?:function\s+([\w$]+)|([\w$]+)\s*=\s*(?:function|\([\s\S]*?\)\s*=>))/;
      const frag = document.createDocumentFragment();
      let has = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m, textVal = '', cls = '';
        if ((filter === 'all' || filter === 'headings') && (m = line.match(reH))) {
          textVal = m[3].replace(/<[^>]+>/g, ''); cls = 'outline-' + m[1].toLowerCase();
        } else if ((filter === 'all' || filter === 'ids') && (m = line.match(reId))) {
          textVal = '#' + m[1]; cls = 'outline-id';
        } else if ((filter === 'all' || filter === 'classes') && (m = line.match(reClass))) {
          textVal = '.' + m[1].split(' ')[0]; cls = 'outline-class';
        } else if ((filter === 'all' || filter === 'functions') && (m = line.match(reFunc))) {
          textVal = 'ƒ ' + (m[1] || m[2]); cls = 'outline-function';
        }
        if (!(textVal && cls)) continue;
        has = true;
        // DOM 建立 + textContent：避免內文 XSS
        const a = document.createElement('a');
        a.className = cls;
        a.dataset.line = String(i);
        a.textContent = textVal;
        a.addEventListener('click', () => {
          const ln = parseInt(a.dataset.line, 10);
          const ltext = lines[ln] || '';
          const idMatch = ltext.match(/id=["']([^"']+)["']/);
          const classMatch = ltext.match(/class=["']([^"']+)["']/);
          let selector = '';
          if (idMatch) selector = '#' + idMatch[1];
          else if (classMatch) selector = '.' + classMatch[1].split(' ')[0];
          if (selector) {
            const pv = $('#preview');
            if (pv && pv.contentWindow) pv.contentWindow.postMessage({ type: 'highlight', selector }, '*');
          }
          App.editor.jumpTo(ln);
        });
        frag.appendChild(a);
      }
      if (!has) {
        const div = document.createElement('div');
        div.style.cssText = 'padding:10px;color:#888;text-align:center';
        div.textContent = '無符合項目';
        frag.appendChild(div);
      }
      container.appendChild(frag);
    }
  };

  // ---------- AI Replace (AST) ----------
  const AIReplace = {
    open() { $('#ai-modal').style.display = 'flex'; $('#ai-input').value = ''; $('#ai-input').focus(); },
    close() { $('#ai-modal').style.display = 'none'; },
    replace() {
      const pasted = $('#ai-input').value.trim();
      if (!pasted) { toast('請先貼上程式碼'); return; }
      const content = App.editor.getValue();

      // Try JS AST first（HTML 檔則逐一解析各個 <script>）
      const fns = this._pastedFunctions(pasted);
      const jsResult = fns.length ? this._replaceJSByAST(content, pasted, fns) : null;
      if (jsResult) {
        App.editor.setValue(jsResult.text, Tabs.active.mode);
        toast(`已以 AST 替換：${jsResult.names.join(', ')}` + (jsResult.missed.length ? `（找不到：${jsResult.missed.join(', ')}）` : ''));
        this.close(); return;
      }
      // Fallback: CSS Rule（平衡括號匹配）；貼上的是 JS 函式就不走括號比對，避免誤切
      const cssResult = fns.length ? null : this._replaceCSSRule(content, pasted);
      if (cssResult && cssResult.ok) {
        App.editor.setValue(cssResult.text, Tabs.active.mode);
        toast('CSS 規則已替換'); this.close(); return;
      }

      // Otherwise locate approx line
      const first = pasted.split('\n')[0].trim();
      const key = first.split('(')[0].split('{')[0].trim();
      if (!key) { toast('無法解析貼上的程式碼'); return; }
      const found = App.editor.find(new RegExp(escapeRegExp(key)));
      if (found) { App.editor.jumpTo(found.from.line); toast(`找不到完全符合，已定位至 "${key}"`); this.close(); }
      else { toast('找不到可替換的目標，請檢查程式碼語法是否正確'); }
    },
    _parse(code) {
      for (const sourceType of ['script', 'module']) {
        try { return acorn.parse(code, { ecmaVersion: 'latest', sourceType }); } catch (e) { /* try next sourceType */ }
      }
      return null;
    },
    // function foo / const foo = () => / export ... 的名稱；其他節點回傳 null
    _fnName(node) {
      if (node && /^Export(Named|Default)Declaration$/.test(node.type)) node = node.declaration;
      if (!node) return null;
      if (node.type === 'FunctionDeclaration') return node.id && node.id.name;
      if (node.type === 'VariableDeclaration' && node.declarations.length === 1) {
        const d = node.declarations[0];
        if (d.id.type === 'Identifier' && d.init && /^(Function|ArrowFunction)Expression$/.test(d.init.type)) return d.id.name;
      }
      return null;
    },
    // 貼上碼的頂層函式（AI 常一次給好幾個）
    _pastedFunctions(code) {
      const ast = this._parse(code);
      if (!ast) return [];
      return ast.body.map(n => ({ name: this._fnName(n), exported: n.type.startsWith('Export'), code: code.slice(n.start, n.end) }))
        .filter(f => f.name);
    },
    // 目標檔所有函式位置：name -> { outer: 含 export 的範圍, inner: 不含 export 的範圍 }
    _findFunctions(text) {
      const segs = [{ offset: 0, code: text }];
      // HTML 整份無法解析 → 逐一解析內嵌 <script>（略過 src 外部腳本）
      const re = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
      for (let m; (m = re.exec(text));) segs.push({ offset: m.index + m[0].indexOf('>') + 1, code: m[1] });
      const found = {};
      for (const { offset, code } of segs) {
        const ast = this._parse(code);
        if (!ast) continue;
        const add = (n) => {
          const name = this._fnName(n);
          const inner = n.declaration || n;
          if (name && !found[name]) found[name] = { outer: [n.start + offset, n.end + offset], inner: [inner.start + offset, inner.end + offset] };
        };
        walkAST(ast, { ExportNamedDeclaration: add, ExportDefaultDeclaration: add, FunctionDeclaration: add, VariableDeclaration: add });
      }
      return found;
    },
    _replaceJSByAST(targetText, pasted, fns) {
      const found = this._findFunctions(targetText);
      const hits = fns.filter(f => found[f.name])
        // 貼上碼有 export 就連 export 一起換，沒有就保留原檔的 export
        .map(f => ({ name: f.name, code: fns.length === 1 ? pasted : f.code, range: found[f.name][f.exported ? 'outer' : 'inner'] }))
        .sort((a, b) => b.range[0] - a.range[0]);
      if (!hits.length) return null;
      let text = targetText, lastStart = Infinity;
      for (const h of hits) {
        if (h.range[1] > lastStart) continue; // 範圍重疊（巢狀）→ 只換外層
        text = text.slice(0, h.range[0]) + h.code + text.slice(h.range[1]);
        lastStart = h.range[0];
      }
      return { text, names: hits.map(h => h.name).reverse(), missed: fns.filter(f => !found[f.name]).map(f => f.name) };
    },
    _replaceCSSRule(targetText, pasted) {
      const selMatch = pasted.match(/^[^{}]+\{/);
      if (!selMatch) return null;
      const selector = selMatch[0].replace('{', '').trim();
      // 選擇器前須是規則邊界（開頭、{ } > 或註解結尾），避免 .btn 誤中 .card .btn
      const open = new RegExp('(^|[{}>]|\\*/)(\\s*)' + escapeRegExp(selector) + '\\s*\\{');
      const m = open.exec(targetText);
      if (!m) return null;
      const start = m.index + m[1].length + m[2].length;
      // 平衡括號掃描：支援巢狀規則（@media / @supports），並避免 $ 替換模式問題
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < targetText.length; i++) {
        const c = targetText[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) return null; // 不平衡 → 放棄
      return { ok: true, text: targetText.slice(0, start) + pasted + targetText.slice(i + 1) };
    }
  };

  // ---------- Layout Module ----------
  const Layout = {
    initResizers() {
      $$('.resizer').forEach(resizer => {
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const grid = $('#grid');
          const isNav = resizer.dataset.target === 'pane-nav';
          const prevSelect = document.body.style.userSelect;
          document.body.style.userSelect = 'none';
          function onMove(ev) {
            const cols = getComputedStyle(grid).gridTemplateColumns.split(' ');
            if (isNav) grid.style.gridTemplateColumns = `${ev.clientX}px 4px 1fr ${cols[3]} ${cols[4]}`;
            else grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} ${ev.clientX - parseFloat(cols[0]) - 4}px 4px 1fr`;
          }
          function onUp() {
            document.body.style.userSelect = prevSelect;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            App.editor.refresh();
          }
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
      });
    },
    togglePane(which) {
      const grid = $('#grid');
      // 重新取得最新的欄位寬度
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ');
      if (which === 'nav') {
        const btn = $('#btn-toggle-nav');
        if (parseFloat(cols[0]) <= 5) { // 小於 5 視為關閉狀態
          grid.style.gridTemplateColumns = `280px 2px 1fr 2px 1.2fr`;
          btn.classList.remove('hidden');
        } else {
          grid.style.gridTemplateColumns = `0px 0px 1fr ${cols[3]} ${cols[4]}`;
          btn.classList.add('hidden');
        }
      } else {
        const btn = $('#btn-toggle-preview');
        // 如果最後一欄寬度很小，就展開它
        if (parseFloat(cols[4]) <= 5) {
          grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} 1fr 2px 1.2fr`;
          btn.classList.remove('hidden');
        } else {
          // 否則將最後兩欄（resizer + preview）歸零
          grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} 1fr 0px 0px`;
          btn.classList.add('hidden');
        }
      }
      setTimeout(() => App.editor.refresh(), 200);
    }
  };

  // ---------- Core App ----------
  const App = {
    editor: null, // adapter instance
    engine: 'codemirror',
    theme: 'default',

    async boot() {
      try {
        // tabs
        Tabs.load();
        this.renderTabs();

        // engine & theme（防損壞值）
        this.engine = storage.get('heu_engine', 'codemirror');
        if (!['codemirror', 'monaco'].includes(this.engine)) this.engine = 'codemirror';
        this.theme = storage.get('heu_theme', 'default');
        if (!['default', 'material', 'dracula'].includes(this.theme)) this.theme = 'default';
        $('#engine-select').value = this.engine;
        $('#theme-select').value = this.theme;
        this.bindEvents();

        await this.mountEditor(Tabs.active.content, Tabs.active.mode);
        this.applyTheme(this.theme);
        this.syncMdToggle();

        // first render
        this.updatePreview();
        Outline.build($('#nav-filter').value, $('#md-toggle').checked, this.editor.getValue());
        Layout.initResizers();
      } catch (err) {
        console.error('Boot crash:', err);
        if (confirm('應用程式載入失敗，這通常是因為快存資料不相容。是否嘗試修復並清除暫存？')) {
          this.repair();
        }
      }
    },

    repair() {
      ['heu_tabs_v2', 'heu_active_tab', 'heu_engine', 'heu_theme', 'heu_tabs'].forEach(k => localStorage.removeItem(k));
      location.reload();
    },

    async mountEditor(text, mode) {
      const host = $('#editor-host');
      try {
        if (this.engine === 'monaco') {
          try {
            this.editor = await new MonacoAdapter(host).init(text, mode, this.theme);
          } catch (err) {
            // Monaco 載入失敗 → 自動降級 CodeMirror
            console.error('Monaco load failed, fallback to CodeMirror:', err);
            this.engine = 'codemirror';
            storage.set('heu_engine', 'codemirror');
            $('#engine-select').value = 'codemirror';
            host.innerHTML = '<textarea id="cm-textarea"></textarea>';
            this.editor = await new CodeMirrorAdapter(host).init(text, mode, this.theme);
          }
        } else {
          host.innerHTML = '<textarea id="cm-textarea"></textarea>';
          this.editor = await new CodeMirrorAdapter(host).init(text, mode, this.theme);
        }
      } catch (err) {
        console.error('Editor mount failed:', err);
        alert('編輯器載入失敗，請檢查網路連接或稍後再試。');
      }
    },

    async switchEngine(engine) {
      if (engine === this.engine) return;
      const text = this.editor.getValue();
      const mode = Tabs.active.mode;
      this.engine = engine; storage.set('heu_engine', engine);
      await this.mountEditor(text, mode);
      this.applyTheme(this.theme);
      this.updatePreview();
      Outline.build($('#nav-filter').value, $('#md-toggle').checked, this.editor.getValue());
      toast(`已切換到 ${engine === 'monaco' ? 'Monaco' : 'CodeMirror'}`);
    },

    applyTheme(theme) {
      this.theme = theme;
      storage.set('heu_theme', theme);
      // 預設主題不加 data-theme 屬性，避免 [data-theme] 覆寫誤套用到 Light 模式
      if (theme === 'default') document.body.removeAttribute('data-theme');
      else document.body.setAttribute('data-theme', theme);
      this.editor.setTheme(theme);
    },

    syncMdToggle() { $('#md-toggle').checked = (Tabs.active && Tabs.active.mode === 'md'); },

    onEditorChange(text) {
      this.showSaved(Tabs.updateActiveContent(text));
      this.updatePreviewDebounced();
      this.updateOutlineDebounced();
    },

    updatePreview() { const isMd = $('#md-toggle').checked; Preview.update(this.editor.getValue(), isMd); },
    updatePreviewDebounced: debounce(function () { App.updatePreview(); }, 300),

    updateOutline() { Outline.build($('#nav-filter').value, $('#md-toggle').checked, this.editor.getValue()); },
    updateOutlineDebounced: debounce(function () { App.updateOutline(); }, 300),

    format() {
      if ($('#md-toggle').checked) return;
      const v = this.editor.getValue();
      const mode = Tabs.active.mode;
      const opts = { indent_size: 2, preserve_newlines: true };
      try {
        let pretty;
        if (mode === 'css') pretty = css_beautify(v, opts);
        else if (mode === 'js') pretty = js_beautify(v, opts);
        else pretty = html_beautify(v, opts);
        this.editor.setValue(pretty, mode);
      } catch (e) { toast('格式化失敗，請檢查語法'); }
    },

    download() {
      const isMd = $('#md-toggle').checked;
      const blob = new Blob([this.editor.getValue()], { type: isMd ? 'text/markdown' : 'text/html' });
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = Tabs.active && Tabs.active.name ? Tabs.active.name : (isMd ? 'doc.md' : 'index.html');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    clear() { if (confirm('確定清空目前檔案？')) { this.editor.setValue('', Tabs.active.mode); } },

    showSaved(ok = true) {
      const el = $('#save-status');
      if (!ok) { clearTimeout(this._savedTimer); el.textContent = '⚠️ 儲存失敗（容量已滿？）'; return; }
      el.textContent = '已儲存';
      clearTimeout(this._savedTimer);
      this._savedTimer = setTimeout(() => { el.textContent = ''; }, 1200);
    },

    renderTabs() {
      const el = $('#tabs');
      el.innerHTML = '';
      Tabs.list.forEach(t => {
        const node = document.createElement('div');
        node.className = 'tab' + (t.id === Tabs.activeId ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = t.name;
        name.title = t.name;
        const close = document.createElement('button');
        close.className = 'close';
        close.innerHTML = '×';
        close.title = '關閉';
        close.addEventListener('click', (ev) => { ev.stopPropagation(); if (!t.content || confirm(`關閉並刪除「${t.name}」？`)) Tabs.remove(t.id); });
        node.addEventListener('dblclick', () => { const newName = prompt('重新命名', t.name) || t.name; Tabs.rename(t.id, newName); });
        node.addEventListener('click', () => Tabs.setActive(t.id));
        node.append(name, close);
        el.appendChild(node);
      });
    },

    bindEvents() {
      // Engine/Theme
      $('#engine-select').addEventListener('change', (e) => this.switchEngine(e.target.value));
      $('#theme-select').addEventListener('change', (e) => this.applyTheme(e.target.value));
      // Actions
      $('#btn-format').addEventListener('click', () => this.format());
      $('#btn-download').addEventListener('click', () => this.download());
      $('#btn-clear').addEventListener('click', () => this.clear());
      $('#btn-refresh-outline').addEventListener('click', () => this.updateOutline());
      $('#md-toggle').addEventListener('change', () => {
        const t = Tabs.active;
        if (!t) return;
        const isMd = $('#md-toggle').checked;
        // css/js 分頁不是 Markdown 的適用對象 → 還原勾選
        if (t.mode !== 'md' && t.mode !== 'html') { $('#md-toggle').checked = false; return; }
        t.mode = isMd ? 'md' : 'html';
        Tabs.save();
        App.editor.setMode(t.mode);
        this.updatePreview();
        this.updateOutline();
      });
      // AI Replace
      $('#btn-ai').addEventListener('click', () => AIReplace.open());
      $('#btn-ai-cancel').addEventListener('click', () => AIReplace.close());
      $('#btn-ai-replace').addEventListener('click', () => AIReplace.replace());
      $('#ai-input').addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); AIReplace.replace(); }
      });
      // Layout toggle
      $('#btn-toggle-nav').addEventListener('click', () => Layout.togglePane('nav'));
      $('#btn-toggle-preview').addEventListener('click', () => Layout.togglePane('preview'));
      // Tabs
      $('#btn-new-tab').addEventListener('click', () => {
        const name = prompt('檔名（例如 index.html、style.css、script.js）', 'untitled.html') || 'untitled.html';
        const mode = name.endsWith('.md') ? 'md' : name.endsWith('.css') ? 'css' : name.endsWith('.js') ? 'js' : 'html';
        Tabs.add(name, mode, '');
        $('#md-toggle').checked = (mode === 'md');
      });
      // PostMessage sync from preview（只接受預覽 iframe 來源）
      window.addEventListener('message', (e) => {
        if (!Preview.frame.contentWindow || e.source !== Preview.frame.contentWindow) return;
        if (e.data && e.data.type === 'sync') {
          const { tag, id, text } = e.data;
          const txt = App.editor.getValue();
          const escTag = escapeRegExp(String(tag || ''));
          // try id first
          if (id) {
            const reId = new RegExp(`<${escTag}[^>]*id=["']${escapeRegExp(String(id))}["'][^>]*>`, 'i');
            const pos = App._findLineByRegex(reId, txt);
            if (pos >= 0) { App.editor.jumpTo(pos); toast(`定位到 <${tag} id="${id}">`); return; }
          }
          // try text（先於 tag：沒有 id 的 <td> 若先比 tag，永遠只會跳到第一個 <td>）
          if (text) {
            const lines = txt.split('\n'), reOpen = new RegExp(`<${escTag}[\\s>]`, 'i');
            let pos = lines.findIndex(l => l.includes(String(text)) && reOpen.test(l));
            if (pos < 0) pos = App._findLineByText(String(text), txt);
            if (pos >= 0) { App.editor.jumpTo(pos); toast('定位到相符內容'); return; }
          }
          // try tag
          if (tag) {
            const reTag = new RegExp(`<${escTag}[^>]*>`, 'i');
            const pos = App._findLineByRegex(reTag, txt);
            if (pos >= 0) { App.editor.jumpTo(pos); toast(`定位到 <${tag}>`); return; }
          }
          toast('找不到對應位置');
        }
      });
      // Outline filter change
      $('#nav-filter').addEventListener('change', () => this.updateOutline());
      // Esc 關閉 AI 彈窗
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $('#ai-modal').style.display === 'flex') AIReplace.close();
      });
    },

    _findLineByRegex(re, text) { const lines = (text || '').split('\n'); for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) return i; } return -1; },
    _findLineByText(snippet, text) { const lines = (text || '').split('\n'); for (let i = 0; i < lines.length; i++) { if (lines[i].includes(snippet)) return i; } return -1; }
  };

  // Init
  window.App = App; window.Tabs = Tabs; window.AIReplace = AIReplace;
  window.addEventListener('load', () => { App.boot().then(() => { App.editor.refresh(); App.showSaved(); }); });
})();
