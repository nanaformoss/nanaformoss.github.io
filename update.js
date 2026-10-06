const fs = require('fs');

// 這些密鑰由 GitHub Actions 運行時注入
const API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const APP_ID = '294100'; // RimWorld

// 贊助連結：請改成你自己的真實網址。
// 網址仍含「你的」的項目會被自動略過（並在日誌警告），避免公開網站出現壞掉、
// 或被別人搶註同名帳號後攔截贊助的連結。
const DONATE_LINKS = [
    { label: '🇹🇼 台灣 (信用卡・ATM)', url: '你的藍新EPG結帳網址',
      cls: 'bg-[#fff3cd] text-[#856404] hover:bg-[#ffe8a1]' },
    { label: '🇨🇳 大陸 (支付寶・微信)', url: 'https://afdian.net/a/你的愛發電帳號',
      cls: 'bg-[#f8d7da] text-[#721c24] hover:bg-[#f5c6cb]' },
    { label: '🌍 國際 (PayPal・Cards)', url: 'https://ko-fi.com/你的Ko-fi帳號',
      cls: 'bg-[#d1ecf1] text-[#0c5460] hover:bg-[#bee5eb]' },
];

// ---------- 安全輔助函式 ----------

// 所有來自 Steam 的文字都必須經過這個函式才能放進 HTML
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 只接受 https 網址，擋掉 javascript:、data: 等；回傳 null 代表不安全
function safeHttpsUrl(u) {
    try {
        const parsed = new URL(String(u));
        return parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

// 移除 Steam BBCode（[b] [/b] [url=...] [h1] [*] [img] 等），再截斷
function summarize(raw) {
    const plain = String(raw || '')
        .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return 'No description available.';
    const chars = Array.from(plain); // 避免切到 emoji 的一半
    return chars.length > 80 ? chars.slice(0, 80).join('') + '...' : plain;
}

function buildDonateHtml() {
    return DONATE_LINKS.filter(link => {
        const ok = !link.url.includes('你的') && safeHttpsUrl(link.url);
        if (!ok) console.warn(`⚠ 略過尚未設定的贊助連結：${link.label}`);
        return ok;
    }).map(link => `
                            <a href="${escapeHtml(safeHttpsUrl(link.url))}" target="_blank" rel="noopener noreferrer" class="flex justify-between items-center px-3 py-2 text-sm font-semibold ${link.cls} rounded-lg transition-colors">
                                <span>${escapeHtml(link.label)}</span><span>→</span>
                            </a>`).join('');
}

// ---------- 主流程 ----------

async function fetchAndGenerateCards() {
    try {
        console.log("正在從 Steam 取得作者所有的模組清單...");

        if (!API_KEY || !STEAM_ID) {
            throw new Error("找不到 STEAM_API_KEY 或 STEAM_ID，請檢查 GitHub Secrets 設定與 yml 檔的 env 區塊！");
        }

        // 1. 取得名下所有工作坊項目 ID
        // 正確端點是 IPublishedFileService/GetUserFiles（需要使用者 API Key）
        // 原本的 ISteamUGC/GetUserPublishedFiles 不存在，會回 404
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
        if (!listRes.ok) {
            throw new Error(`Steam API 連線失敗 (狀態碼: ${listRes.status})`);
        }
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

        // 2. 取得詳細數據
        console.log(`找到 ${modIds.length} 個模組，正在獲取詳細數據...`);
        const formData = new URLSearchParams();
        formData.append('itemcount', modIds.length);
        modIds.forEach((id, index) => formData.append(`publishedfileids[${index}]`, id));

        const detailsRes = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000)
        });
        if (!detailsRes.ok) {
            throw new Error(`Steam 詳細資料 API 失敗 (狀態碼: ${detailsRes.status})`);
        }
        const detailsData = await detailsRes.json();
        const details = detailsData?.response?.publishedfiledetails;
        if (!Array.isArray(details)) {
            throw new Error("詳細資料格式異常，已中止，未修改網頁。");
        }

        // 只公開：成功取得(result=1)、公開(visibility=0)、未被下架的項目
        const publicMods = details.filter(m => m.result === 1 && m.visibility === 0 && !m.banned);
        if (publicMods.length === 0) {
            console.log("沒有可公開的模組，保留現有頁面。");
            return;
        }

        // 3. 組合 HTML（所有外部資料一律 escape / 驗證）
        const donateHtml = buildDonateHtml();
        let cardsHTML = '';

        publicMods.forEach(mod => {
            const title = escapeHtml(mod.title || 'Untitled');
            const desc = escapeHtml(summarize(mod.description));
            const imgUrl = safeHttpsUrl(mod.preview_url);
            const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(mod.publishedfileid)}`;
            const subs = Number(mod.subscriptions) || 0;
            const favs = Number(mod.favorited) || 0;
            const updated = new Date((Number(mod.time_updated) || 0) * 1000);
            const dateStr = isNaN(updated)
                ? ''
                : updated.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });

            const figure = imgUrl
                ? `<img src="${escapeHtml(imgUrl)}" alt="${title}" class="w-full aspect-video object-cover" referrerpolicy="no-referrer" loading="lazy">`
                : `<div class="w-full aspect-video"></div>`;

            const supportBlock = donateHtml ? `
                        <div class="space-y-2">
                            <p class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Support this mod</p>${donateHtml}
                        </div>` : '';

            cardsHTML += `
            <article class="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-200/75 flex flex-col hover:shadow-md transition-shadow duration-300 gsap-reveal">
                <figure class="w-full bg-gray-900 overflow-hidden">
                    ${figure}
                </figure>
                <div class="p-5 flex flex-col flex-grow">
                    <h2 class="text-lg font-bold leading-tight mb-1">${title}</h2>
                    <div class="flex items-center text-xs text-gray-500 mb-3 gap-1">
                        <span class="text-gray-800 tracking-tighter">★★★★★</span>
                        <span>👍 ${favs} 收藏 · ${subs} 訂閱</span>
                    </div>
                    <p class="text-sm text-gray-600 line-clamp-3 mb-4">${desc}</p>

                    <div class="mt-auto pt-4 border-t border-gray-100">
                        <div class="flex justify-between items-center mb-4 text-xs text-gray-500">
                            <span>${escapeHtml(dateStr)} 更新</span>
                            <a href="${url}" target="_blank" rel="noopener noreferrer" class="font-semibold text-gray-800 hover:underline flex items-center gap-1">View on Steam ↗</a>
                        </div>${supportBlock}
                    </div>
                </div>
            </article>
            `;
        });

        // 4. 寫入 index.html
        if (!fs.existsSync('index.html')) {
            throw new Error("找不到 index.html 檔案！請確認檔案名稱是否正確且位於專案最外層。");
        }

        let html = fs.readFileSync('index.html', 'utf8');

        if (!html.includes('<!-- CARDS_START -->') || !html.includes('<!-- CARDS_END -->')) {
            throw new Error("在 index.html 中找不到 <!-- CARDS_START --> 或 <!-- CARDS_END --> 標記，無法替換內容！");
        }

        // 用函式當替換值：避免內容裡的 $& $' $` 被 JS 當成特殊替換語法
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