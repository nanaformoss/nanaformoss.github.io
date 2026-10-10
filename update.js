const fs = require('fs');

// 這些密鑰由 GitHub Actions 運行時注入
const API_KEY = process.env.STEAM_API_KEY;
const STEAM_ID = process.env.STEAM_ID;
const APP_ID = '294100'; // RimWorld

// ================= 可自行調整的設定 =================
const LIMITS = {
    en: { summary: 480, full: 2500 },  // 卡片小字介紹 / 彈窗內文 的字數上限（超過會在行尾截斷）
    zh: { summary: 260, full: 1300 },
};

// 這些「標題」所在的段落會整段被丟掉（不分大小寫）
const NOISE_HEADING = new RegExp('^(?:' + [
    'change\\s*-?\\s*logs?', 'update\\s*-?\\s*logs?', 'updates?', 'patch\\s*notes?',
    'version\\s*history', 'credits?', 'special\\s*thanks', 'thanks', 'donat\\w*',
    'support\\s*me', 'support\\s*the\\s*author', 'follow\\s*me', 'socials?',
    '更新(?:日誌|日志|紀錄|记录|內容|内容)?', '版本(?:紀錄|记录|歷史|历史)',
    '鳴謝|致謝|感謝|特別感謝|特别感谢|贊助|捐贈|捐赠|打賞|打赏',
    'settings?', 'feedback(?:\\s*(?:&|and)\\s*suggestions?)?', 'bug\\s*reports?',
    '設定|设置|回報與建議|回报与建议|意見回饋|意见反馈|問題回報|问题回报',
].join('|') + ')$', 'i');

// 卡片小字介紹：指定某個模組（用 Steam 的 publishedfileid）固定顯示這段文字，
// 不再從說明文章裡自動擷取。每個語言一個陣列，一個元素 = 一行。
const INTRO_OVERRIDES = {
    '3812133334': {
        zh: [
            '「我叫小人去砍點木頭蓋床，結果斧頭手滑割傷大出血，另一隻被樹幹砸到腦震盪；放出去吃草的牛還吃到毒草直接猝死。」',
            '讓野外的植物不再人畜無害。採收、啃草、砍樹的瞬間，都有極小的機率出事，事前沒有徵兆。',
        ],
        en: [
            '"I sent a pawn to chop some wood for a bed, and the axe slipped, causing severe bleeding. Another got a concussion from a falling tree. Meanwhile, my grazing cow ate toxic flora and dropped dead."',
            'Make the wilderness dangerous again. Harvesting, grazing, and woodcutting now carry a very small, unpredictable risk of accidents. No warnings, just RimWorld.',
        ],
    },
};

// 含這些關鍵字的「單行」會被丟掉（贊助 / 社群宣傳）
const DROP_LINE = /(patreon|ko-?fi|afdian|paypal|discord|buy\s*me\s*a\s*coffee|愛發電|爱发电|藍新|赞助|贊助|打賞|打赏|訂閱我|关注我|追蹤我)/i;
// ====================================================

// ---------- 安全輔助函式 ----------
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// 放進 HTML 屬性：同時保留換行
function attr(s) {
    return escapeHtml(s).replace(/\n/g, '&#10;');
}

function safeHttpsUrl(u) {
    try {
        const parsed = new URL(String(u));
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

// ---------- 說明文字處理 ----------
// 純文字標題：【標題】 或 [ Title ]
const H_PLAIN = [/^【\s*([^】]+?)\s*】$/, /^\[\s+(.+?)\s+\]$/];

// 1) BBCode / 純文字 -> 結構化行（h 標題 / li 條列(depth 0|1) / p 段落）
function parseDescription(raw) {
    let s = String(raw || '').replace(/\r\n?/g, '\n');

    s = s.replace(/\[(img|previewyoutube|video|youtube)(?:=[^\]]*)?\][\s\S]*?\[\/\1\]/gi, '\n'); // 圖片/影片
    s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');                                   // 連結只留文字
    s = s.replace(/\[url\][\s\S]*?\[\/url\]/gi, '');
    // 容錯：作者常把結尾寫成 [h1]（少了斜線），所以同一行內的 [hN]...[hN] 或 [hN]...[/hN] 都當標題；
    // 只有開頭沒有結尾的 [hN] 整行也當標題，落單的 [/hN] 直接移除
    s = s.replace(/\[h([1-3])\]([^\n]*?)\[\/?h\1\]/gi, (_, n, t) => '\n\u0001' + n + '\u0003' + t + '\n');
    s = s.replace(/^[ \t]*\[h([1-3])\]([^\n]*)$/gim, (_, n, t) => '\n\u0001' + n + '\u0003' + t + '\n');
    s = s.replace(/\[\/h[1-3]\]/gi, '');
    s = s.replace(/\[h([1-3])\]([\s\S]*?)\[\/h\1\]/gi, (_, n, t) => '\n\u0001' + n + '\u0003' + t.replace(/\s*\n\s*/g, ' ') + '\n');
    s = s.replace(/\[hr\]\s*\[\/hr\]|\[hr\]/gi, '\n\n');
    let depth = 0; // 追蹤巢狀 [list]
    s = s.replace(/\[(\/?)o?list\]|\[\*\]/gi, (m, close) => {
        if (m === '[*]') return '\n\u0002' + Math.max(depth - 1, 0);
        if (close) { depth = Math.max(depth - 1, 0); return '\n'; }
        depth++; return '\n';
    });
    s = s.replace(/\[\/?(?:table|tr)(?:=[^\]]*)?\]/gi, '\n');
    s = s.replace(/\[\/?(?:td|th)(?:=[^\]]*)?\]/gi, ' ');
    s = s.replace(/\[\/?(?:b|i|u|s|strike|spoiler|noparse|code|quote|color|size|font|center|left|right|justify|p)(?:=[^\]]*)?\]/gi, '');
    s = s.replace(/https?:\/\/\S+/gi, '');                                                        // 裸網址

    const rows = [];
    for (let line of s.split('\n')) {
        line = line.trim();
        let type = 'p', d = 0, lvl = 0;
        if (line.startsWith('\u0001')) { type = 'h'; lvl = Number(line[1]) || 0; line = line.slice(3).trim(); }
        else if (line.startsWith('\u0002')) { type = 'li'; d = Number(line[1]) || 0; line = line.slice(2).trim(); }
        line = line.replace(/[ \t\u3000]+/g, ' ');
        if (!/[\p{L}\p{N}]/u.test(line)) { rows.push({ type: 'blank', text: '' }); continue; } // 純符號/分隔線
        if (DROP_LINE.test(line)) continue;
        rows.push({ type, text: line, depth: d, level: lvl });
    }

    // 純文字的標題與條列（作者直接打 【標題】、「* 」、「- 」、「80% …」的情況）
    let prevLi = null;
    for (const r of rows) {
        if (r.type === 'blank') continue;
        if (r.type === 'h') { r.wrapped = /^[【\[]\s*.+?\s*[】\]]$/.test(r.text); r.text = r.text.replace(/^[【\[]\s*(.+?)\s*[】\]]$/, '$1'); prevLi = null; continue; }
        if (r.type === 'li') { r.kind = 'main'; prevLi = r; continue; }
        let hm = null;
        for (const re of H_PLAIN) { hm = r.text.match(re); if (hm) break; }
        if (hm) { r.type = 'h'; r.text = hm[1]; prevLi = null; continue; }
        const bm = r.text.match(/^([*\-•·‧＊])\s+(.+)$/);
        if (bm) {
            const star = bm[1] === '*' || bm[1] === '＊';
            r.type = 'li'; r.text = bm[2]; r.depth = 0; r.kind = 'main';
            if (star && prevLi && ((prevLi.depth === 0 && /[:：]$/.test(prevLi.text)) || (prevLi.depth === 1 && prevLi.kind === 'star'))) {
                r.depth = 1; r.kind = 'star';
            }
            prevLi = r; continue;
        }
        if (prevLi && (prevLi.depth === 1 || /[:：]$/.test(prevLi.text)) && /^\d+(?:\.\d+)?%/.test(r.text)) {
            r.type = 'li'; r.depth = 1; r.kind = 'bare'; prevLi = r;
        }
    }

    // 丟掉 Changelog / 贊助 / 鳴謝 之類的段落
    const out = [];
    let skip = null; // 'h' = 直到下一個標題；'p' = 直到下一個空行
    for (const r of rows) {
        if (r.type === 'blank') { if (skip === 'p') skip = null; continue; }
        const core = r.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (r.type === 'h') { skip = NOISE_HEADING.test(core) ? 'h' : null; if (skip) continue; }
        else if (skip) continue;
        else if (r.type === 'p' && NOISE_HEADING.test(core)) { skip = 'p'; continue; }
        out.push(r);
    }
    return out;
}

// 2) 依「每行的文字」分成英文 / 中文
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g;
function classifyLine(text) {
    const cjk = (text.match(CJK_RE) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (!cjk && !latin) return 'both';
    if (!cjk) return 'en';
    return cjk * 3 >= latin ? 'zh' : 'en';
}

// 說明最前面的 [h1]/[h2]（Steam 頁面的 bb_h1 / bb_h2，最多 2 行）= 引言與簡介，當成卡片小字，不當小標題
function promoteIntro(lines) {
    let n = 0;
    for (const ln of lines) {
        if (n >= 2) break;
        if (ln.type === 'h' && (ln.level === 1 || ln.level === 2) && !ln.wrapped) { ln.type = 'p'; ln.text = ln.text.replace(/^'(.+)'$/, '$1'); n++; }
        else break;
    }
    return lines;
}

function tidy(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.type === 'h' && (!lines[i + 1] || lines[i + 1].type === 'h')) continue; // 沒內容的標題
        const prev = out[out.length - 1];
        if (prev && prev.type === ln.type && prev.text === ln.text) continue;
        out.push(ln);
    }
    return out;
}

// 第一個標題之前 = 卡片上的「小字介紹」；第一個標題起 = 點開後的「詳細內容」
function splitIntro(lines) {
    const i = lines.findIndex(l => l.type === 'h');
    if (i === -1) return { intro: lines, body: lines };
    return { intro: lines.slice(0, i), body: lines.slice(i) };
}

function linesToText(lines, max) {
    const parts = [];
    let len = 0;
    for (const ln of lines) {
        const t = ln.type === 'h' ? `// ${ln.text}`
            : ln.type === 'li' ? `${ln.depth === 1 ? '◦' : '•'} ${ln.text}`
            : ln.text;
        if (len + t.length > max) {
            if (!parts.length) parts.push(Array.from(t).slice(0, max).join('') + '...');
            else parts.push('...');
            break;
        }
        parts.push(t);
        len += t.length + 1;
    }
    return parts.join('\n');
}

// 卡片小字：回傳「每行一個字串」的陣列
function introToLines(intro, body, max) {
    let src = intro.filter(l => l.type !== 'h');
    if (!src.length) src = body.filter(l => l.type !== 'h').slice(0, 2);
    const out = [];
    let len = 0;
    for (const l of src) {
        const t = l.text;
        if (len + t.length > max) {
            const room = max - len;
            if (room > 20) out.push(Array.from(t).slice(0, room).join('') + '...');
            else if (out.length) out[out.length - 1] += '...';
            break;
        }
        out.push(t);
        len += t.length;
    }
    return out;
}

function buildDescriptions(raw) {
    const lines = parseDescription(raw);
    let en = [], zh = [], enOwn = 0, zhOwn = 0;
    for (const ln of lines) {
        const k = classifyLine(ln.text);
        if (k !== 'zh') en.push(ln);
        if (k !== 'en') zh.push(ln);
        if (k === 'en') enOwn++;
        if (k === 'zh') zhOwn++;
    }
    // 只有一種語言時，兩邊都顯示那一種
    if (!enOwn) en = zh;
    if (!zhOwn) zh = en;
    en = tidy(promoteIntro(en)); zh = tidy(promoteIntro(zh));

    const E = splitIntro(en), Z = splitIntro(zh);
    const none = { en: ['NO_DESCRIPTION_AVAILABLE.'], zh: ['尚無說明。'] };
    const introEn = introToLines(E.intro, E.body, LIMITS.en.summary);
    const introZh = introToLines(Z.intro, Z.body, LIMITS.zh.summary);
    return {
        introEn: introEn.length ? introEn : none.en,
        introZh: introZh.length ? introZh : none.zh,
        fullEn: linesToText(E.body, LIMITS.en.full),
        fullZh: linesToText(Z.body, LIMITS.zh.full),
    };
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
            const rawTitle = mod.title || 'UNKNOWN_ENTITY';
            const title = escapeHtml(rawTitle);
            const d = buildDescriptions(mod.description || '');
            const ov = INTRO_OVERRIDES[String(mod.publishedfileid)];
            if (ov) { if (ov.en) d.introEn = ov.en; if (ov.zh) d.introZh = ov.zh; }

            const imgUrl = safeHttpsUrl(mod.preview_url);
            const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(mod.publishedfileid)}`;
            const subs = Number(mod.subscriptions) || 0;
            const favs = Number(mod.favorited) || 0;

            const ts = Number(mod.time_updated) || 0;
            const dateStr = ts
                ? new Date(ts * ).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '.')
                : 'UNKNOWN';

            const allTags = (mod.tags || []).map(t => t.tag);
            const versions = allTags.filter(t => /^\d+\.\d+$/.test(t));
            const tags = allTags.filter(t => !/^\d+\.\d+$/.test(t));

            const tagsJson = attr(JSON.stringify(tags));
            const versionsJson = attr(JSON.stringify(versions));
            const searchIndex = attr(`${rawTitle} ${d.introEn.join(' ')} ${d.introZh.join(' ')} ${d.fullEn} ${d.fullZh} ${allTags.join(' ')}`.toLowerCase().replace(/\s+/g, ' '));

            const figure = imgUrl
                ? `<img src="${imgUrl}" alt="${title}" class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity duration-300" referrerpolicy="no-referrer" loading="lazy">`
                : `<div class="w-full h-full bg-black flex items-center justify-center text-[#3f3f46] font-mono text-xs">NO_IMAGE</div>`;

            const pClass = 'text-xs text-[#717684] mb-4 leading-relaxed font-mono space-y-1.5';
            const introHtml = arr => arr.map(t => `<span class="block">&gt; ${escapeHtml(t)}</span>`).join('');

            cardsHTML += `
            <article class="relative bg-[#090a0f] border border-dashed border-[#232732] flex flex-col opacity-90 hover:opacity-100 transition-opacity gsap-reveal group cursor-pointer"
                     data-mod-card
                     data-title="${title}"
                     data-date="${dateStr}"
                     data-fav="${favs}"
                     data-sub="${subs}"
                     data-img="${imgUrl}"
                     data-url="${url}"
                     data-tags="${tagsJson}"
                     data-versions="${versionsJson}"
                     data-full-en="${attr(d.fullEn)}"
                     data-full-zh="${attr(d.fullZh)}"
                     data-search="${searchIndex}">

                <figure class="w-full bg-black aspect-video flex items-center justify-center border-b border-dashed border-[#232732] group-hover:border-[#d97706] transition-colors relative overflow-hidden">
                    <div class="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] z-10 pointer-events-none opacity-20"></div>
                    ${figure}
                </figure>

                <div class="p-4 sm:p-5 flex flex-col flex-grow bg-[#050608]">
                    <div class="text-[10px] text-[#d97706] mb-1.5 uppercase font-mono tracking-widest">FILE_ID: ${escapeHtml(mod.publishedfileid)}</div>
                    <h2 class="text-sm font-bold text-white mb-2 uppercase leading-tight" style="font-family: 'Inter', sans-serif;">${title}</h2>

                    <div class="flex flex-wrap gap-1.5 mb-3 font-mono">
                        <span class="text-[10px] bg-[#090a0f] text-[#a1a1aa] px-2 py-0.5 uppercase border border-[#1d2027]"><span data-i18n="fav">FAV</span>: ${favs}</span>
                        <span class="text-[10px] bg-[#090a0f] text-[#a1a1aa] px-2 py-0.5 uppercase border border-[#1d2027]"><span data-i18n="sub">SUB</span>: ${subs}</span>
                    </div>

                    <div class="lang-en ${pClass}">${introHtml(d.introEn)}</div>
                    <div class="lang-zh ${pClass}">${introHtml(d.introZh)}</div>

                    <div class="mt-auto pt-3 border-t border-[#1d2027] text-[10px] text-[#717684] uppercase flex justify-between font-mono">
                        <span>${dateStr}</span>
                        <span class="text-[#d97706] opacity-0 group-hover:opacity-100 transition-opacity" data-i18n="access">ACCESS -&gt;</span>
                    </div>
                </div>
            </article>
            `;
        });

        if (!fs.existsSync('index.html')) {
            throw new Error("找不到 index.html 檔案！請確認檔案名稱是否正確且位於專案最外層。");
        }

        let html = fs.readFileSync('index.html', 'utf8');

        if (!html.includes('<!-- CARDS_START -->') || !html.includes('<!-- CARDS_END -->')) {
            throw new Error("在 index.html 中找不到 <!-- CARDS_START --> 或 <!-- CARDS_END --> 標記，無法替換內容！");
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

if (require.main === module) {
    fetchAndGenerateCards();
} else {
    module.exports = { parseDescription, buildDescriptions };
}
