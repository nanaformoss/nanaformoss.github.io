const fs = require('fs');

// 這些密鑰將由 GitHub Actions 運行時自動注入
const API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const APP_ID = '294100'; // RimWorld 的 Steam 遊戲 ID

async function fetchAndGenerateCards() {
    try {
        console.log("正在從 Steam 取得作者所有的模組清單...");
        
        // 1. 取得你名下所有的工作坊項目 ID
        const listRes = await fetch(`https://api.steampowered.com/ISteamUGC/GetUserPublishedFiles/v1/?key=${API_KEY}&steamid=${STEAM_ID}&appid=${APP_ID}&page=1`);
        const listData = await listRes.json();

        if (!listData.response || !listData.response.publishedfiledetails) {
            console.log("找不到模組或 API 錯誤。");
            return;
        }

        const modIds = listData.response.publishedfiledetails.map(mod => mod.publishedfileid);
        if (modIds.length === 0) {
            console.log("目前沒有上傳任何模組。");
            return;
        }

        // 2. 透過這些 ID 取得模組的詳細數據（圖片、標題、訂閱數）
        console.log(`找到 ${modIds.length} 個模組，正在獲取詳細數據...`);
        const formData = new URLSearchParams();
        formData.append('itemcount', modIds.length);
        modIds.forEach((id, index) => formData.append(`publishedfileids[${index}]`, id));

        const detailsRes = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
            method: 'POST',
            body: formData
        });
        const detailsData = await detailsRes.json();

        // 3. 組合 HTML 模板
        let cardsHTML = '';
        
        detailsData.response.publishedfiledetails.forEach(mod => {
            const title = mod.title;
            // 處理 Steam 描述，去除隱藏字元並截斷長度
            const rawDesc = mod.description || "No description available.";
            const desc = rawDesc.replace(/\[\/?(b\vert{}i\vert{}u\vert{}h1\vert{}h2\vert{}h3\vert{}url.*?)\]/g, '').substring(0, 80) + '...';
            const imgUrl = mod.preview_url;
            const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedfileid}`;
            const subs = mod.subscriptions || 0;
            const favs = mod.favorited || 0;
            const dateStr = new Date(mod.time_updated * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long' });

            // 這裡整合了你最新的柔和現代風與三軌贊助按鈕
            // 💡 記得將下面的 贊助網址 換成你真實的連結！
            cardsHTML += `
            <article class="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-200/75 flex flex-col hover:shadow-md transition-shadow duration-300 gsap-reveal">
                <figure class="w-full bg-gray-900 overflow-hidden">
                    <img src="${imgUrl}" alt="${title}" class="w-full aspect-video object-cover">
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
                            <span>${dateStr} 更新</span>
                            <a href="${url}" target="_blank" class="font-semibold text-gray-800 hover:underline flex items-center gap-1">View on Steam ↗</a>
                        </div>
                        <div class="space-y-2">
                            <p class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Support this mod</p>
                            <a href="你的藍新EPG結帳網址" target="_blank" class="flex justify-between items-center px-3 py-2 text-sm font-semibold bg-[#fff3cd] text-[#856404] rounded-lg hover:bg-[#ffe8a1] transition-colors">
                                <span>🇹🇼 台灣 (信用卡・ATM)</span><span>→</span>
                            </a>
                            <a href="https://afdian.net/a/你的愛發電帳號" target="_blank" class="flex justify-between items-center px-3 py-2 text-sm font-semibold bg-[#f8d7da] text-[#721c24] rounded-lg hover:bg-[#f5c6cb] transition-colors">
                                <span>🇨🇳 大陸 (支付寶・微信)</span><span>→</span>
                            </a>
                            <a href="https://ko-fi.com/你的Ko-fi帳號" target="_blank" class="flex justify-between items-center px-3 py-2 text-sm font-semibold bg-[#d1ecf1] text-[#0c5460] rounded-lg hover:bg-[#bee5eb] transition-colors">
                                <span>🌍 國際 (PayPal・Cards)</span><span>→</span>
                            </a>
                        </div>
                    </div>
                </div>
            </article>
            `;
        });

        // 4. 將生成的卡片寫入 index.html 的標記之間
        let html = fs.readFileSync('index.html', 'utf8');
        html = html.replace(/<!-- CARDS_START -->[\s\S]*<!-- CARDS_END -->/, `<!-- CARDS_START -->\n${cardsHTML}\n            <!-- CARDS_END -->`);
        fs.writeFileSync('index.html', html, 'utf8');
        
        console.log("✅ 網頁自動化更新完成！");

    } catch (error) {
        console.error("❌ 更新失敗:", error);
        process.exit(1);
    }
}

fetchAndGenerateCards();