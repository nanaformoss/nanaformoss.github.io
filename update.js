const fs = require('fs');

// 這些密鑰由 GitHub Actions 運行時注入
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

function summarize(raw) {
    const plain = String(raw || '')
        .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return 'NO_DESCRIPTION_AVAILABLE.';
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

        // 3. 組合全新終端機 HTML 模板 (已移除灰階濾鏡，保持全彩)
        let cardsHTML = '';

        publicMods.forEach(mod => {
            const title = escapeHtml(mod.title || 'UNKNOWN_ENTITY');
            const rawDesc = mod.description || '';
            const cleanDesc = escapeHtml(summarize(rawDesc));
            const fullDescEscaped = escapeHtml(rawDesc.replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, '').replace(/\s+/g, ' ').trim());
            
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
            const searchIndex = escapeHtml(`${title} ${fullDescEscaped}${allTags.join(' ')}`.toLowerCase());

            // 這裡移除了灰階屬性，讓圖片保持原本的色彩，只保留滑鼠移過去微微變亮的互動感
            const figure = imgUrl
                ? `<img src="${imgUrl}" alt="${title}" class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity duration-300" referrerpolicy="no-referrer" loading="lazy">`
                : `<div class="w-full h-full bg-black flex items-center justify-center text-[#3f3f46] font-mono text-xs">NO_IMAGE</div>`;

            cardsHTML += `
            <article class="relative bg-[#090a0f] border border-dashed border-[#232732] flex flex-col opacity-90 hover:opacity-100 transition-opacity gsap-reveal group cursor-pointer" 
                     data-mod-card 
                     data-title="${title}" 
                     data-meta="MODIFIED: ${dateStr} // FAV: ${favs} // SUB:${subs}" 
                     data-img="${imgUrl}" 
                     data-url="${url}" 
                     data-tags="${tagsJson}" 
                     data-versions="${versionsJson}" 
                     data-full="${fullDescEscaped}" 
                     data-search="${searchIndex}">
                
                <figure class="w-full bg-black aspect-video flex items-center