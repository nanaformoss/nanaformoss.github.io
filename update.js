const fs = require('fs');

const API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const APP_ID = '294100'; // RimWorld

// ---------- 安全輔助函式 ----------
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeHttpsUrl(u) {
    try {
        const parsed = new URL(String(u));
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

// 專門處理詳細內容：保留換行、轉換清單、移除雜亂 BBCode 標籤
function cleanBBCodeFull(raw) {
    if (!raw) return 'NO_DESCRIPTION_AVAILABLE.';
    let text = String(raw);
    
    // 移除圖片標籤
    text = text.replace(/[img].*?\[\/img\]/gis, '');
    // 處理清單符號
    text = text.replace(/\[\*\]/g, '• ');
    // 移除所有的 BBCode 標籤 (保留裡面的文字)
    text = text.replace(/\[\/?(b\vert{}i\vert{}u\vert{}strike\vert{}spoiler\vert{}noparse\vert{}hr\vert{}h1\vert{}h2\vert{}h3\vert{}list\vert{}olist\vert{}quote\vert{}code\vert{}table\vert{}tr\vert{}th\vert{}td\vert{}url)(?:=[^\]]*)?\]/gi, '');
    
    // 將多餘的連續換行壓縮成最多兩行，保持排版美觀
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

// 專門處理小卡片摘要：移除所有標籤與換行，壓縮成一行短句
function summarizeSnippet(raw) {
    const plain = cleanBBCodeFull(raw).replace(/\s+/g, ' ').trim();
    const chars = Array.from(plain);
    return chars.length > 85 ? chars.slice(0, 85).join('') + '...' : plain;
}

// ---------- 主流程 ----------
async function fetchAndGenerateCards() {
    try {
        console.log("正在從 Steam 取得作者所有的模組清單...");

        const missing = [];
        if (!API_KEY) missing.push('STEAM_API_KEY（應放在 Secrets）');
        if (!STEAM_ID) missing.push('STEAM_ID（應放在 Variables）');
        if (missing.length > 0) {
            throw new Error(`缺少設定：${missing.join('、')}。請檢查 Settings → Secrets and variables。`);
        }

        const listParams = new URLSearchParams({
            key: API_KEY,
            steamid: STEAM_ID,
            appid: APP_ID,
            numperpage: '100',
            page: '1',
        });
        const listRes = await fetch(
            `https://api.steampowered.com/IPublishedFileService/GetUserFiles/v1/?${listParams}`,
            { signal: AbortSignal.timeout(30000) }
        );
        if (!listRes.ok) throw new Error(`Steam API 連線失敗 (狀態碼: ${listRes.status})`);
        
        const listData = await listRes.json();
        if (!listData.response || !listData.response.publishedfiledetails) {
            console.log("找不到模組或 API 錯誤，保留現有頁面。");
            return;
        }

        const modIds = listData.response.publishedfiledetails.map(mod => mod.publishedfileid);
        if (modIds.length === 0) {
            console.log("目前沒有上傳任何模組，保留現有頁面。");
            return;
        }

        console.log(`找到 ${modIds.length} 個模組，正在獲取詳細數據...`);
        const formData = new URLSearchParams();
        formData.append('itemcount', modIds.length);
        modIds.forEach((id, index) => formData.append(`publishedfileids[${index}]`, id));

        const detailsRes = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000)
        });
        if (!detailsRes.ok) throw new Error(`Steam 詳細資料 API 失敗 (狀態碼: ${detailsRes.status})`);
        
        const detailsData = await detailsRes.json();
        const details = detailsData?.response?.publishedfiledetails;
        if (!Array.isArray(details)) throw new Error("詳細資料格式異常，已中止，未修改網頁。");

        const publicMods = details.filter(m => m.result === 1 && m.visibility === 0 && !m.banned);
        if (publicMods.length === 0) {
            console.log("沒有可公開的模組，保留現有頁面。");
            return;
        }

        let cardsHTML = '';

        publicMods.forEach(mod => {
            const title = escapeHtml(mod.title || 'UNKNOWN_ENTITY');
            const rawDesc = mod.description || '';
            
            // 摘要用於卡片正面
            const cleanDesc = escapeHtml(summarizeSnippet(rawDesc));
            // 完整內容用於點開的 Modal (保留換行符號)
            const fullDescCleaned = escapeHtml(cleanBBCodeFull(rawDesc));
            
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
            // 搜尋引擎用的字串則需要壓扁
            const searchIndex = escapeHtml(`${title} ${fullDescCleaned.replace(/\n/g, ' ')} ${allTags.join(' ')}`.toLowerCase());

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
                     data-full="${fullDescCleaned}" 
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

        if (!fs.existsSync('index.html')) {
            throw new Error("找不到 index.html 檔案！");
        }

        let html = fs.readFileSync('index.html', 'utf8');

        if (!html.includes('<!-- CARDS_START -->') || !html.includes('<!-- CARDS_END -->')) {
            throw new Error("找不到替換標記！");
        }

        html = html.replace(
            /<!-- CARDS_START -->[\s\S]*?<!-- CARDS_END -->/,
            () => `<!-- CARDS_START -->\n${cardsHTML}\n            <!-- CARDS_END -->`
        );
        fs.writeFileSync('index.html', html, 'utf8');

        console.log(`✅ 網頁自動化更新完成！共 ${publicMods.length} 個模組。`);

    } catch (error) {
        console.error("❌ 更新失敗:", error.message);
        process.exit(1);
    }
}

fetchAndGenerateCards();