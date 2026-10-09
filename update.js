const fs = require('fs');

// 這些密鑰由 GitHub Actions 運行時注入
const API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const APP_ID = '294100'; // RimWorld

// ---------- 安全輔助函式 ----------
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHttpsUrl(u) {
    try {
        const parsed = new URL(String(u));
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

// 用於小卡片正面的「純文字摘要」：暴力移除所有標籤與換行
function summarizeSnippet(raw) {
    if (!raw) return 'NO_DESCRIPTION_AVAILABLE.';
    let plain = String(raw).replace(/\[\/?.*?\]/g, '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(plain);
    return escapeHtml(chars.length > 85 ? chars.slice(0, 85).join('') + '...' : plain);
}

// 用於點開 Modal 的「完整內容」：將 BBCode 轉換為高質感的 Tailwind HTML 結構
function bbcodeToHtml(raw) {
    if (!raw) return 'NO_DATA';
    
    // 1. 先跳脫原始字串，防止惡意代碼
    let html = escapeHtml(raw);

    // 2. 將 Steam 的 BBCode 轉換為精美的 HTML
    html = html.replace(/\[b\](.*?)\[\/b\]/gis, '<strong class="text-white">$1</strong>')
               .replace(/\[i\](.*?)\[\/i\]/gis, '<em class="italic text-gray-300">$1</em>')
               .replace(/\[u\](.*?)\[\/u\]/gis, '<u class="underline">$1</u>')
               .replace(/\[strike\](.*?)\[\/strike\]/gis, '<del class="line-through opacity-50">$1</del>')
               .replace(/\[h1\](.*?)\[\/h1\]/gis, '<h3 class="text-[#d97706] font-bold text-lg mt-8 mb-3 border-b border-[#232732] pb-1 uppercase tracking-wider">$1</h3>')
               .replace(/\[h2\](.*?)\[\/h2\]/gis, '<h4 class="text-white font-bold text-base mt-6 mb-2">$1</h4>')
               .replace(/\[h3\](.*?)\[\/h3\]/gis, '<h5 class="text-gray-300 font-bold text-sm mt-4 mb-1">$1</h5>')
               .replace(/\[url=(.*?)\](.*?)\[\/url\]/gis, '<a href="$1" target="_blank" class="text-[#06b6d4] hover:text-white underline transition-colors">$2</a>')
               .replace(/\[url\](.*?)\[\/url\]/gis, '<a href="$1" target="_blank" class="text-[#06b6d4] hover:text-white underline transition-colors">$1</a>')
               .replace(/\[img\](.*?)\[\/img\]/gis, '<img src="$1" class="max-w-full my-4 border border-[#232732] opacity-90 hover:opacity-100 transition-opacity rounded">')
               .replace(/\[quote\](.*?)\[\/quote\]/gis, '<blockquote class="border-l-2 border-[#d97706] pl-4 py-2 my-4 text-[#a1a1aa] bg-[#090a0f] italic">$1</blockquote>')
               .replace(/\[code\](.*?)\[\/code\]/gis, '<pre class="bg-black border border-[#232732] p-3 my-4 rounded text-xs overflow-x-auto text-gray-300"><code>$1</code></pre>');

    // 3. 處理列表 [list] 與 [*]
    html = html.replace(/\[list\](.*?)\[\/list\]/gis, function(match, content) {
        let items = content.split(/\[\*\]/).filter(item => item.trim() !== '');
        let listHtml = items.map(item => `<li class="mb-1.5 ml-5 list-disc">${item.trim()}</li>`).join('');
        return `<ul class="my-4 text-[#a1a1aa] space-y-1">${listHtml}</ul>`;
    });
    
    // 4. 清除剩餘未支援的殘留標籤
    html = html.replace(/\[\/?(?:b|i|u|strike|spoiler|noparse|hr|h1|h2|h3|list|olist|quote|code|table|tr|th|td|url|img).*?\]/gi, '');

    // 5. 處理換行，避免排版擁擠
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/(<br>\s*){3,}/g, '<br><br>');

    // 最後替換 HTML 屬性需要的引號 (防止塞進 data-full 時把 HTML 結構弄壞)
    return html.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- 主流程 ----------
async function fetchAndGenerateCards() {
    try {
        console.log("正在從 Steam 取得作者所有的模組清單...");

        const missing = [];
        if (!API_KEY) missing.push('STEAM_API_KEY（應放在 Secrets）');
        if (!STEAM_ID) missing.push('STEAM_ID（應放在 Variables）');
        if (missing.length > 0) throw new Error(`缺少設定：${missing.join('、')}。請檢查 Settings → Secrets and variables。`);

        const listParams = new URLSearchParams({ key: API_KEY, steamid: STEAM_ID, appid: APP_ID, numperpage: '100', page: '1' });
        const listRes = await fetch(`https://api.steampowered.com/IPublishedFileService/GetUserFiles/v1/?${listParams}`, { signal: AbortSignal.timeout(30000) });
        if (!listRes.ok) throw new Error(`Steam API 連線失敗 (狀態碼: ${listRes.status})`);
        
        const listData = await listRes.json();
        if (!listData.response || !listData.response.publishedfiledetails) {
            console.log("找不到模組或 API 錯誤，保留現有頁面。"); return;
        }

        const modIds = listData.response.publishedfiledetails.map(mod => mod.publishedfileid);
        if (modIds.length === 0) {
            console.log("目前沒有上傳任何模組，保留現有頁面。"); return;
        }

        console.log(`找到 ${modIds.length} 個模組，正在獲取詳細數據...`);
        const formData = new URLSearchParams();
        formData.append('itemcount', modIds.length);
        modIds.forEach((id, index) => formData.append(`publishedfileids[${index}]`, id));

        const detailsRes = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', { method: 'POST', body: formData, signal: AbortSignal.timeout(30000) });
        if (!detailsRes.ok) throw new Error(`Steam 詳細資料 API 失敗 (狀態碼: ${detailsRes.status})`);
        
        const detailsData = await detailsRes.json();
        const details = detailsData?.response?.publishedfiledetails;
        if (!Array.isArray(details)) throw new Error("詳細資料格式異常，已中止，未修改網頁。");

        const publicMods = details.filter(m => m.result === 1 && m.visibility === 0 && !m.banned);
        if (publicMods.length === 0) { console.log("沒有可公開的模組，保留現有頁面。"); return; }

        let cardsHTML = '';

        publicMods.forEach(mod => {
            const title = escapeHtml(mod.title || 'UNKNOWN_ENTITY');
            const rawDesc = mod.description || '';
            const cleanDesc = summarizeSnippet(rawDesc); // 乾淨的小卡片摘要
            const htmlDesc = bbcodeToHtml(rawDesc);      // 轉化為 HTML 的完整敘述
            
            const imgUrl = safeHttpsUrl(mod.preview_url);
            const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(mod.publishedfileid)}`;
            const subs = Number(mod.subscriptions) || 0;
            const favs = Number(mod.favorited) || 0;
            const updated = new Date((Number(mod.time_updated) || 0) * 1000);
            const dateStr = isNaN(updated) ? 'UNKNOWN' : updated.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '.');

            const allTags = (mod.tags || []).map(t => t.tag);
            const versions = allTags.filter(t => /^\d+\.\d+$/.test(t));
            const tags = allTags.filter(t => !/^\d+\.\d+$/.test(t));

            const tagsJson = escapeHtml(JSON.stringify(tags));
            const versionsJson = escapeHtml(JSON.stringify(versions));
            const searchIndex = escapeHtml(`${title} ${rawDesc.replace(/\[\/?.*?\]/g, '')} ${allTags.join(' ')}`.toLowerCase());

            const figure = imgUrl
                ? `<img src="${imgUrl}" alt="${title}" class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity duration-300" referrerpolicy="no-referrer" loading="lazy">`
                : `<div class="w-full h-full bg-black flex items-center justify-center text-[#3f3f46] font-mono text-xs">NO_IMAGE</div>`;

            cardsHTML += `
            <article class="relative bg-[#090a0f] border border-dashed border-[#232732] flex flex-col opacity-90 hover:opacity-100 transition-opacity gsap-reveal group cursor-pointer" 
                     data-mod-card 
                     data-title="${title}" 
                     data-meta="MODIFIED: ${dateStr} // FAV: ${favs} // SUB: ${subs}" 
                     data-img="${imgUrl}" 
                     data-url="${url}" 
                     data-tags="${tagsJson}" 
                     data-versions="${versionsJson}" 
                     data-full="${htmlDesc}" 
                     data-search="${searchIndex}">
                
                <figure class="w-full bg-black aspect-video flex items-center justify-center border-b border-dashed border-[#232732] group-hover:border-[#d97706] transition-colors relative overflow-hidden">
                    <div class="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] z-10 pointer-events-none opacity-20"></div>
                    ${figure}
                </figure>
                
                <div class="p-4 sm:p-5 flex flex-col flex-grow bg-[#050608]">
                    <div class="text-[10px] text-[#d97706] mb-1.5 uppercase font-mono tracking-widest">FILE_ID: ${mod.publishedfileid}</div>
                    <h2 class="text-sm font-bold text-white mb-2 uppercase leading-tight" style="font-family: 'Inter', sans-serif;">${title}</h2>
                    
                    <div class="flex flex-wrap gap-1.5 mb-3 font-mono">
                        <span class="text-[10px] bg-[#090a0f] text-[#a1a1aa] px-2 py-0.5 uppercase border border-[#1d2027]">FAV: ${favs}</span>
                        <span class="text-[10px] bg-[#090a0f] text-[#a1a1aa] px-2 py-0.5 uppercase border border-[#1d2027]">SUB: ${subs}</span>
                    </div>
                    
                    <p class="text-xs text-[#717684] line-clamp-3 mb-4 leading-relaxed font-mono">
                        > ${cleanDesc}
                    </p>
                    
                    <div class="mt-auto pt-3 border-t border-[#1d2027] text-[10px] text-[#717684] uppercase flex justify-between font-mono">
                        <span>${dateStr}</span>
                        <span class="text-[#d97706] opacity-0 group-hover:opacity-100 transition-opacity">ACCESS -></span>
                    </div>
                </div>
            </article>
            `;
        });

        if (!fs.existsSync('index.html')) throw new Error("找不到 index.html 檔案！");
        let html = fs.readFileSync('index.html', 'utf8');
        if (!html.includes('<!-- CARDS_START -->') || !html.includes('<!-- CARDS_END -->')) throw new Error("找不到替換標記！");

        html = html.replace(/<!-- CARDS_START -->[\s\S]*?<!-- CARDS_END -->/, () => `<!-- CARDS_START -->\n${cardsHTML}\n            <!-- CARDS_END -->`);
        fs.writeFileSync('index.html', html, 'utf8');
        console.log(`✅ 網頁自動化更新完成！共 ${publicMods.length} 個模組。`);

    } catch (error) {
        console.error("❌ 更新失敗:", error.message);
        process.exit(1);
    }
}
fetchAndGenerateCards();