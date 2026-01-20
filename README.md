
# HTML Editor Ultimate · Pro (AI/AST/Monaco)

這是一個三分離版本（`index.html` / `editor.js` / `styles.css`）的強化 HTML 編輯器：
- ✅ **AST 精準替換**：貼上 JS function / CSS 規則，自動以 AST 或選擇器匹配替換。
- ✅ **Monaco & CodeMirror 可切換**：VSCode 等級與輕量引擎自由切換。
- ✅ **多檔無限分頁**：自動儲存至 localStorage。
- ✅ **Markdown/HTML 預覽** 與 **點擊同步定位**。
- ✅ **RWD、Resizer、主題（Light/Material/Dracula）**。

## 使用方式
1. 將三個檔案放在同一資料夾。
2. 直接用瀏覽器開啟 `index.html`。
3. 右上角可切換「編輯器引擎」與「主題」。
4. 「🪄 智能替換」可貼上完整 JS/CSS 進行精準替換。

## 主要檔案
- `index.html`：頁面骨架、外部套件載入與容器。
- `editor.js`：主程式（AST、Monaco/CodeMirror 交換、Tabs、Preview、Outline、Resizer）。
- `styles.css`：主題變數、BEM 風格、RWD、視覺樣式。

## 部署建議
- GitHub Pages / Azure Static Web Apps 皆可，直接上傳三個檔案即可。

-- 完成於：2026-01-20 09:00
