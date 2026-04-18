/* HTML Editor Ultimate · Pro (AI/AST/Monaco)
 * 功能摘要：
 * - Monaco & CodeMirror 可切換
 * - Markdown/HTML 預覽（差異更新、同步定位）
 * - 大型文件效能優化（debounce / lazy outline）
 * - AI Replace：使用 Acorn AST 精準替換 JS function；CSS 規則智能選取
 * - 多檔分頁（無限 Tab）儲存 localStorage
 */
(function () {
  // ---------- Utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const debounce = (fn, ms = 300) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); };
  const storage = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
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
        this.list = storage.get(STORE_TABS, []);
        if (!Array.isArray(this.list) || this.list.length === 0) {
          this.list = [DEFAULT_TAB()];
        }
        const savedActiveId = storage.get(STORE_ACTIVE, null);
        this.activeId = this.list.some(t => t.id === savedActiveId) ? savedActiveId : this.list[0].id;
      } catch (err) {
        console.error('Tabs load failed:', err);
        this.list = [DEFAULT_TAB()];
        this.activeId = this.list[0].id;
      }
    },
    save() { storage.set(STORE_TABS, this.list); storage.set(STORE_ACTIVE, this.activeId); },
    get active() { return this.list.find(t => t.id === this.activeId); },
    setActive(id) { if (this.list.some(t => t.id === id)) { this.activeId = id; this.save(); App.renderTabs(); App.editor.setValue(this.active.content, this.active.mode); } },
    add(name = 'untitled.html', mode = 'html', content = '') { const t = { id: uid(), name, mode, content }; this.list.push(t); this.activeId = t.id; this.save(); App.renderTabs(); App.editor.setValue(content, mode); },
    rename(id, name) { const t = this.list.find(x => x.id === id); if (t) { t.name = name; this.save(); App.renderTabs(); } },
    remove(id) { const i = this.list.findIndex(x => x.id === id); if (i >= 0) { const removed = this.list.splice(i,1)[0]; if (removed.id === this.activeId) { const next = this.list[i] || this.list[i-1] || this.list[0]; this.activeId = next?.id; } this.save(); App.renderTabs(); if (this.active) App.editor.setValue(this.active.content, this.active.mode); }
    },
    updateActiveContent(newText) { if (this.active) { this.active.content = newText; this.save(); } }
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
      this.cm.on('change', debounce(() => App.onEditorChange(this.getValue()), 300));
      // expose search cursor
      return this;
    }
    _modeOf(mode) { return mode === 'md' ? 'markdown' : (mode === 'css' ? 'css' : (mode === 'js' ? 'javascript' : 'htmlmixed')); }
    getValue() { return this.cm.getValue(); }
    setValue(text, mode) { if (mode) this.cm.setOption('mode', this._modeOf(mode)); this.cm.setValue(text ?? ''); this.refresh(); }
    refresh() { setTimeout(() => this.cm && this.cm.refresh(), 50); }
    find(regex) { const c = this.cm.getSearchCursor(regex); return c.findNext() ? c : null; }
    jumpTo(line) { 
      this.cm.setCursor(line, 0); 
      this.cm.scrollIntoView({line, ch:0}, 200); 
      this.cm.focus();
      this._highlightPairLines(line);
    }
    _highlightPairLines(startLine) {
      const doc = this.cm.getDoc();
      const totalLines = doc.lineCount();
      let braceCount = 0;
      let endLine = startLine;
      for (let i = startLine; i < totalLines; i++) {
        const text = doc.getLine(i);
        for (const ch of text) {
          if (ch === '{') braceCount++;
          else if (ch === '}') braceCount--;
        }
        if (braceCount <= 0 && i > startLine) { endLine = i; break; }
      }
      const cls = 'cursor-line-highlight';
      this.cm.addLineClass(startLine, 'background', cls);
      if (endLine !== startLine) this.cm.addLineClass(endLine, 'background', cls);
      setTimeout(() => {
        this.cm.removeLineClass(startLine, 'background', cls);
        if (endLine !== startLine) this.cm.removeLineClass(endLine, 'background', cls);
      }, 1500);
    }
    replaceRange(from, to, text) { this.cm.replaceRange(text, from, to); }
    getDoc() { return this.cm.getDoc(); }
    setTheme(theme) { this.cm.setOption('theme', theme === 'default' ? 'default' : theme); }
  }

  class MonacoAdapter {
    constructor(host) { this.host = host; this.editor = null; }
    async init(text, mode, theme) {
      await this._ensureMonaco();
      this.host.innerHTML = '<div id="monaco"></div>';
      const lang = this._langOf(mode);
      this.editor = monaco.editor.create($('#monaco'), {
        value: text || '', language: lang, theme: this._themeOf(theme), minimap:{enabled:false}, automaticLayout:true
      });
      this.disposer = this.editor.onDidChangeModelContent(debounce(() => App.onEditorChange(this.getValue()), 300));
      return this;
    }
    async _ensureMonaco() {
      if (window.monaco) return;
      return new Promise((resolve) => {
        window.require.config({ paths: { 'vs': window.__MONACO_BASE__ + 'vs' } });
        window.require(['vs/editor/editor.main'], () => resolve());
      });
    }
    _themeOf(theme) { return theme === 'dracula' ? 'vs-dark' : (theme === 'material' ? 'vs-dark' : 'vs'); }
    _langOf(mode) { return mode === 'md' ? 'markdown' : (mode === 'css' ? 'css' : (mode === 'js' ? 'javascript' : 'html')); }
    getValue() { return this.editor.getValue(); }
    setValue(text, mode) {
      const model = this.editor.getModel();
      const lang = this._langOf(mode);
      if (model) monaco.editor.setModelLanguage(model, lang);
      this.editor.setValue(text ?? '');
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
      return { from: {line, ch}, to: {line, ch: ch + (m[0]?.length || 0)} };
    }
    jumpTo(line) { 
      this.editor.revealLineInCenter(line+1); 
      this.editor.setPosition({lineNumber: line+1, column:1}); 
      this.editor.focus();
      this._highlightPairLines(line);
    }
    _highlightPairLines(startLine) {
      const model = this.editor.getModel();
      const lines = model.getLineCount();
      let braceCount = 0;
      let endLine = startLine;
      for (let i = startLine; i <= lines; i++) {
        const text = model.getLineContent(i);
        for (const ch of text) {
          if (ch === '{') braceCount++;
          else if (ch === '}') braceCount--;
        }
        if (braceCount <= 0 && i > startLine) { endLine = i - 1; break; }
      }
      const oldDecs = this._highlightDecs || [];
      const decs = [];
      decs.push({ range: new monaco.Range(startLine+1, 1, startLine+1, 1), options: { isWholeLine: true, className: 'cursor-line-highlight' } });
      if (endLine !== startLine) decs.push({ range: new monaco.Range(endLine+1, 1, endLine+1, 1), options: { isWholeLine: true, className: 'cursor-line-highlight' } });
      this._highlightDecs = this.editor.deltaDecorations(oldDecs, decs);
      setTimeout(() => { this._highlightDecs = this.editor.deltaDecorations(this._highlightDecs, []); }, 1500);
    }
    replaceRange(from, to, text) {
      const model = this.editor.getModel();
      const range = new monaco.Range(from.line+1, from.ch+1, to.line+1, to.ch+1);
      model.pushEditOperations([], [{ range, text }], () => null);
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
  document.addEventListener('click', function(e){
    try{e.stopPropagation();e.preventDefault();}catch(err){}
    window.parent.postMessage({type:'sync', tag:e.target.tagName, id:e.target.id, class:e.target.className, text:(e.target.innerText||'').slice(0,50)}, '*');
  }, true);
  window.addEventListener('message', function(e){
    if(e.data?.type==='highlight'){
      document.querySelectorAll('[data-highlight]').forEach(el=>{ el.style.background=''; delete el.dataset.highlight; });
      const sel = e.data.selector;
      if(sel){ const el = document.querySelector(sel); if(el){ el.style.background='yellow'; el.dataset.highlight='true'; } }
    }
  });
<\/script>`;
        html = content.includes('</body>') ? content.replace('</body>', syncScript + '</body>') : (content + syncScript);
      }
      // diff-less assignment (fast)
      this.frame.srcdoc = html;
    }
  };

  // ---------- Outline Module ----------
  const Outline = {
    build(filter, isMd, text) {
      const container = $('#outline-container');
      if (isMd) { container.innerHTML = '<div style="padding:10px;color:#888">Markdown 模式不支援結構</div>'; return; }
      const lines = (text||'').split('\n');
      const reH = /<(h[1-6])([^>]*)>(.*?)<\/\1>/i;
      const reId = /id=["']([^"']+)["']/i;
      const reClass = /class=["']([^"']+)["']/i;
      const reFunc = /(?:function\s+(\w+)|(\w+)\s*=\s*(?:function|\(.*?\)\s*=>)|const\s+(\w+)\s*=\s*(?:function|\(.*?\)\s*=>)|let\s+(\w+)\s*=\s*(?:function|\(.*?\)\s*=>))/;
      let html = ''; let has=false;
      for (let i=0;i<lines.length;i++){
        const line = lines[i];
        let m, textVal='', cls='', add=false;
        if ((filter==='all' || filter==='headings') && (m = line.match(reH))) {
          textVal = m[3].replace(/<[^>]+>/g,''); cls = 'outline-'+m[1].toLowerCase(); add=true;
        } else if ((filter==='all' || filter==='ids') && (m = line.match(reId))) {
          textVal = '#'+m[1]; cls = 'outline-id'; add=true;
        } else if ((filter==='all' || filter==='classes') && (m = line.match(reClass))) {
          textVal = '.'+m[1].split(' ')[0]; cls = 'outline-class'; add=true;
        } else if ((filter==='all' || filter==='functions') && (m = line.match(reFunc))) {
          textVal = 'ƒ ' + (m[1] || m[2] || m[3] || m[4]); cls = 'outline-function'; add=true;
        }
        if (add && textVal) { has=true; html += `<a class="${cls}" data-line="${i}">${textVal}</a>`; }
      }
      container.innerHTML = has ? html : '<div style="padding:10px;color:#888;text-align:center">無符合項目</div>';
      // click -> jump & highlight
      $$('#outline-container a').forEach(a => a.addEventListener('click', () => {
        const line = parseInt(a.dataset.line,10);
        const text = lines[line] || '';
        const idMatch = text.match(/id=["']([^"']+)["']/);
        const classMatch = text.match(/class=["']([^"']+)["']/);
        let selector = '';
        if (idMatch) selector = '#' + idMatch[1];
        else if (classMatch) selector = '.' + classMatch[1].split(' ')[0];
        const preview = $('#preview');
        if (selector) preview.contentWindow.postMessage({type:'highlight', selector}, '*');
        App.editor.jumpTo(line);
      }));
    }
  };

  // ---------- AI Replace (AST) ----------
  const AIReplace = {
    open() { $('#ai-modal').style.display = 'flex'; $('#ai-input').value=''; $('#ai-input').focus(); },
    close() { $('#ai-modal').style.display = 'none'; },
    replace() {
      const pasted = $('#ai-input').value.trim();
      if (!pasted) { toast('請先貼上程式碼'); return; }
      const content = App.editor.getValue();

      // Try JS AST first
      const jsResult = this._replaceJSByAST(content, pasted);
      if (jsResult && jsResult.ok) {
        App.editor.setValue(jsResult.text, Tabs.active.mode);
        toast('JS 函式已以 AST 精準替換'); this.close(); return;
      }
      // Fallback: CSS Rule (simple selector match)
      const cssResult = this._replaceCSSRule(content, pasted);
      if (cssResult && cssResult.ok) { App.editor.setValue(cssResult.text, Tabs.active.mode); toast('CSS 規則已替換'); this.close(); return; }

      // Otherwise locate approx line
      const first = pasted.split('\n')[0].trim();
      const key = first.split('(')[0].split('{')[0].trim();
      const found = App.editor.find(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
      if (found) { App.editor.jumpTo(found.from.line); toast(`找不到完全符合，已定位至 "${key}"`); this.close(); }
      else { toast('找不到可替換的目標，請檢查程式碼語法是否正確'); }
    },
    _parseFunctionName(code){
      try {
        const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType:'script' });
        let name=null, start=0, end=code.length;
        acornWalk.simple(ast, {
          FunctionDeclaration(node){ if(!name){ name = node.id?.name; start=node.start; end=node.end; } },
          VariableDeclaration(node){
            // const foo = function(){} / const foo = ()=>{}
            node.declarations.forEach(d=>{
              const init = d.init; if(!name && init && (init.type==='FunctionExpression' || init.type==='ArrowFunctionExpression')){ name = d.id?.name; start=init.start; end=node.end; }
            });
          }
        });
        return {name, start, end};
      } catch(e){ return {name:null}; }
    },
    _replaceJSByAST(targetText, pasted){
      const meta = this._parseFunctionName(pasted);
      if(!meta.name) return null;
      try {
        const ast = acorn.parse(targetText, { ecmaVersion: 'latest', sourceType:'script', ranges:true });
        let hit=null;
        acornWalk.simple(ast, {
          FunctionDeclaration(node){ if(node.id?.name===meta.name) hit={start:node.start, end:node.end}; },
          VariableDeclaration(node){ node.declarations.forEach(d=>{ const init=d.init; if(d.id?.name===meta.name && init && (init.type==='FunctionExpression' || init.type==='ArrowFunctionExpression')) hit={start:node.start, end:node.end}; }); }
        });
        if(hit){
          const before = targetText.slice(0, hit.start);
          const after = targetText.slice(hit.end);
          const next = before + pasted + after;
          return { ok:true, text: next };
        }
        return null;
      } catch(e){ return null; }
    },
    _replaceCSSRule(targetText, pasted){
      const selMatch = pasted.match(/^[^{]+\{/);
      if(!selMatch) return null;
      const selector = selMatch[0].replace('{','').trim();
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const ruleRe = new RegExp(esc+"\\s*\\{[\\s\\S]*?\\}");
      if(ruleRe.test(targetText)){
        const text = targetText.replace(ruleRe, pasted);
        return { ok:true, text };
      }
      return null;
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
          function onMove(ev){
            const cols = getComputedStyle(grid).gridTemplateColumns.split(' ');
            if(isNav) grid.style.gridTemplateColumns = `${ev.clientX}px 4px 1fr ${cols[3]} ${cols[4]}`;
            else grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} ${ev.clientX-parseFloat(cols[0])-4}px 4px 1fr`;
          }
          function onUp(){ window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); App.editor.refresh(); }
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        });
      });
    },
    togglePane(which){
      const grid = $('#grid');
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ');
      if(which==='nav'){
        const btn=$('#btn-toggle-nav');
        if(cols[0]==='0px'){ grid.style.gridTemplateColumns = `280px 1px 1fr ${cols[3]} ${cols[4]}`; btn.classList.remove('hidden'); }
        else { grid.style.gridTemplateColumns = `0px 0px 1fr ${cols[3]} ${cols[4]}`; btn.classList.add('hidden'); }
      } else {
        const btn=$('#btn-toggle-preview');
        if(parseFloat(cols[4])<10){ grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} 1fr 1px 1fr`; btn.classList.remove('hidden'); }
        else { grid.style.gridTemplateColumns = `${cols[0]} ${cols[1]} 1fr 0px 0px`; btn.classList.add('hidden'); }
      }
      setTimeout(()=>App.editor.refresh(),200);
    }
  };

  // ---------- Core App ----------
  const App = {
    editor: null, // adapter instance
    engine: 'codemirror',
    theme: 'default',

    async boot(){
      try {
        // tabs
        Tabs.load();
        this.renderTabs();

        // engine & theme
        this.engine = storage.get('heu_engine','codemirror');
        this.theme = storage.get('heu_theme','default');
        $('#engine-select').value = this.engine;
        $('#theme-select').value = this.theme;
        this.bindEvents();

        await this.mountEditor(Tabs.active.content, Tabs.active.mode);
        this.applyTheme(this.theme);

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

    async mountEditor(text, mode){
      try {
        const host = $('#editor-host');
        if(this.engine==='monaco') this.editor = await new MonacoAdapter(host).init(text, mode, this.theme);
        else { host.innerHTML = '<textarea id="cm-textarea"></textarea>'; this.editor = await new CodeMirrorAdapter(host).init(text, mode, this.theme); }
      } catch (err) {
        console.error('Editor mount failed:', err);
        alert('編輯器載入失敗，請檢查網路連接或稍後再試。');
      }
    },

    async switchEngine(engine){
      if(engine===this.engine) return;
      const text = this.editor.getValue();
      const mode = Tabs.active.mode;
      this.engine = engine; storage.set('heu_engine', engine);
      await this.mountEditor(text, mode);
      this.applyTheme(this.theme);
      this.updatePreview();
      Outline.build($('#nav-filter').value, $('#md-toggle').checked, this.editor.getValue());
      toast(`已切換到 ${engine==='monaco'?'Monaco':'CodeMirror'}`);
    },

    applyTheme(theme){ this.theme = theme; storage.set('heu_theme', theme); document.body.setAttribute('data-theme', theme==='default'?'':theme); this.editor.setTheme(theme); },

    onEditorChange(text){
      Tabs.updateActiveContent(text);
      this.showSaved();
      this.updatePreviewDebounced();
      this.updateOutlineDebounced();
    },

    updatePreview(){ const isMd = $('#md-toggle').checked; Preview.update(this.editor.getValue(), isMd); },
    updatePreviewDebounced: debounce(function(){ App.updatePreview(); }, 300),

    updateOutline(){ Outline.build($('#nav-filter').value, $('#md-toggle').checked, this.editor.getValue()); },
    updateOutlineDebounced: debounce(function(){ App.updateOutline(); }, 300),

    format(){ if($('#md-toggle').checked) return; const v = this.editor.getValue(); try{ const pretty = html_beautify(v, { indent_size:2, preserve_newlines:true }); this.editor.setValue(pretty, Tabs.active.mode);}catch(e){ toast('格式化失敗，請檢查 HTML 語法'); } },

    download(){ const isMd = $('#md-toggle').checked; const blob = new Blob([this.editor.getValue()], {type: isMd?'text/markdown':'text/html'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download = Tabs.active?.name || (isMd?'doc.md':'index.html'); a.click(); },

    clear(){ if(confirm('確定清空目前檔案？')){ this.editor.setValue('', Tabs.active.mode); } },

    showSaved(){ const el = $('#save-status'); el.textContent='已儲存'; setTimeout(()=> el.textContent='', 1200); },

    renderTabs(){ const el = $('#tabs'); el.innerHTML='';
      Tabs.list.forEach(t=>{
        const node = document.createElement('div'); node.className = 'tab'+(t.id===Tabs.activeId?' active':'');
        const name = document.createElement('span'); name.className='name'; name.textContent=t.name; name.title=t.name;
        const close = document.createElement('button'); close.className='close'; close.innerHTML='×'; close.title='關閉';
        close.addEventListener('click', (ev)=>{ ev.stopPropagation(); Tabs.remove(t.id); });
        node.addEventListener('dblclick', ()=>{ const newName = prompt('重新命名', t.name) || t.name; Tabs.rename(t.id, newName); });
        node.addEventListener('click', ()=> Tabs.setActive(t.id));
        node.append(name, close); el.appendChild(node);
      });
    },

    bindEvents(){
      // Engine/Theme
      $('#engine-select').addEventListener('change', (e)=> this.switchEngine(e.target.value));
      $('#theme-select').addEventListener('change', (e)=> this.applyTheme(e.target.value));
      // Actions
      $('#btn-format').addEventListener('click', ()=> this.format());
      $('#btn-download').addEventListener('click', ()=> this.download());
      $('#btn-clear').addEventListener('click', ()=> this.clear());
      $('#btn-refresh-outline').addEventListener('click', ()=> this.updateOutline());
      $('#md-toggle').addEventListener('change', ()=> { Tabs.active.mode = $('#md-toggle').checked ? 'md' : 'html'; Tabs.save(); this.updatePreview(); this.updateOutline(); });
      // AI Replace
      $('#btn-ai').addEventListener('click', ()=> AIReplace.open());
      $('#btn-ai-cancel').addEventListener('click', ()=> AIReplace.close());
      $('#btn-ai-replace').addEventListener('click', ()=> AIReplace.replace());
      // Layout toggle
      $('#btn-toggle-nav').addEventListener('click', ()=> Layout.togglePane('nav'));
      $('#btn-toggle-preview').addEventListener('click', ()=> Layout.togglePane('preview'));
      // Tabs
      $('#btn-new-tab').addEventListener('click', ()=>{
        const name = prompt('檔名（例如 index.html、style.css、script.js）', 'untitled.html') || 'untitled.html';
        const mode = name.endsWith('.md')?'md': name.endsWith('.css')?'css': name.endsWith('.js')?'js':'html';
        Tabs.add(name, mode, '');
        $('#md-toggle').checked = (mode==='md');
      });
      // PostMessage sync from preview
      window.addEventListener('message', (e)=>{
        if(e.data?.type==='sync'){
          // locate by tag/id/class or text
          const {tag, id, text} = e.data; const txt = App.editor.getValue();
          // try id first
          if(id){
            const reId = new RegExp(`<${tag}[^>]*id=["']${id}["'][^>]*>`, 'i');
            const pos = App._findLineByRegex(reId, txt); if(pos>=0){ App.editor.jumpTo(pos); toast(`定位到 <${tag} id="${id}">`); return; }
          }
          // try tag
          const reTag = new RegExp(`<${tag}[^>]*>`, 'i');
          let pos = App._findLineByRegex(reTag, txt); if(pos>=0){ App.editor.jumpTo(pos); toast(`定位到 <${tag}>`); return; }
          // try text
          if(text){ pos = App._findLineByText(text, txt); if(pos>=0){ App.editor.jumpTo(pos); toast('定位到相符內容'); return; } }
          toast('找不到對應位置');
        }
      });
      // Outline filter change
      $('#nav-filter').addEventListener('change', ()=> this.updateOutline());
    },

    _findLineByRegex(re, text){ const lines = (text||'').split('\n'); for(let i=0;i<lines.length;i++){ if(re.test(lines[i])) return i; } return -1; },
    _findLineByText(snippet, text){ const lines = (text||'').split('\n'); for(let i=0;i<lines.length;i++){ if(lines[i].includes(snippet)) return i; } return -1; }
  };

  // Init
  window.App = App; window.Tabs = Tabs; window.AIReplace = AIReplace;
  window.addEventListener('load', ()=> { App.boot().then(()=>{ App.editor.refresh(); App.showSaved(); }); });
})();
