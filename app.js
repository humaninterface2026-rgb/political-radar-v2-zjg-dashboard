let hourChart, platformChart, mentionChart, redTrendChart, topicOwnChart, topicTrendsChart;
let zjgHourChart;
let incidentMap;
let mode = '24h';
// First-run JSON cache — mode switch (24h ↔ 7d) re-renders without re-fetching the
// 6 boot JSON files (~1MB cold). RPCs are still re-called per mode since they're
// genuinely mode-aware (hours=24 vs 168). topic_heat caches separately via
// state.topicHeat below. hotspot_history cached via _hotspotHistoryCache.
// election_priority reuses existing _epIndexCache (via loadEpIndex). Reset on
// page reload.
let _runJsonCache = null;
let _hotspotHistoryCache = null;

// Lazy-render registry: heavy sections (election + past events) skip eager render
// in run() — IntersectionObserver triggers their render when the section is ~300px
// from entering viewport. First render fetches the underlying JSON (4.4MB +
// 493KB), subsequent calls re-render from cache. Mode switch hits the cached
// path immediately for already-rendered sections.
const _lazyState = new Map();  // elementId → 'pending' | 'rendered'
function lazyRender(elementId, renderFn) {
  const state = _lazyState.get(elementId);
  if (state === 'rendered') { renderFn(); return; }
  if (state === 'pending')  return;          // observer already set up, waiting
  const el = document.getElementById(elementId);
  if (!el) { renderFn(); return; }           // element missing → just render
  _lazyState.set(elementId, 'pending');
  const obs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        obs.disconnect();
        _lazyState.set(elementId, 'rendered');
        renderFn();
      }
    }
  }, { rootMargin: '300px' });
  obs.observe(el);
}

// In-memory cache of the latest fetched comment lists + history, so the modal
// and the red-list panel don't need to re-fetch on every interaction.
const state = {
  socialSignals: null,
  comments: { facebook: [], instagram: [], threads: [] },
  history: { facebook: [], instagram: [], threads: [] },
  topicHeat: null,
  selectedTopicId: null,
  mentionArticles: {},
};

const LIGHT_ICON = { '紅':'🔴', '黃':'🟡', '綠':'🟢' };
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };
const RED_RATIO_ALERT = 0.25;     // 25%: show red banner
const YELLOW_RATIO_WARN = 0.40;   // 40% non-green: yellow banner

const DEFAULT_HOTSPOTS = [
  {
    title: '消防超勤爭議',
    place: '雲林縣政府（斗六）',
    lat: 23.7075,
    lng: 120.5439,
    level: 'red',
    source: 'news',
    platform: '新聞',
    note: '消防員加班補償／嘉獎爭議'
  }
];

const COMMENT_EVENT_RULES = [
  {
    title: '消防超勤爭議',
    place: '雲林縣政府（斗六）',
    lat: 23.7075,
    lng: 120.5439,
    level: 'red',
    keywords: ['消防', '超勤', '加班', '嘉獎', '補償']
  },
  {
    title: '議員衝突',
    place: '雲林（斗六）',
    lat: 23.7120,
    lng: 120.5400,
    level: 'red',
    keywords: ['賞巴掌', '霸凌', '議員']
  },
  {
    title: '六輕／空污',
    place: '麥寮鄉',
    lat: 23.7906,
    lng: 120.2535,
    level: 'yellow',
    keywords: ['六輕', '麥寮', '空污', '污染']
  },
  {
    title: '農業議題',
    place: '虎尾／西螺',
    lat: 23.7079,
    lng: 120.4318,
    level: 'yellow',
    keywords: ['農業', '農民', '稻', '花生']
  }
];

const LOCATION_HINTS = [
  { k: '斗六', place: '雲林縣斗六市', lat: 23.7075, lng: 120.5439 },
  { k: '虎尾', place: '雲林縣虎尾鎮', lat: 23.7079, lng: 120.4318 },
  { k: '麥寮', place: '雲林縣麥寮鄉', lat: 23.7906, lng: 120.2535 },
  { k: '北港', place: '雲林縣北港鎮', lat: 23.5755, lng: 120.3026 },
  { k: '西螺', place: '雲林縣西螺鎮', lat: 23.7980, lng: 120.4658 },
  { k: '斗南', place: '雲林縣斗南鎮', lat: 23.6797, lng: 120.4776 },
  { k: '土庫', place: '雲林縣土庫鎮', lat: 23.6776, lng: 120.3920 },
  { k: '古坑', place: '雲林縣古坑鄉', lat: 23.6420, lng: 120.5620 }
];

function lightLevelByCount(c, avg){
  if(c >= Math.max(10, avg*1.8)) return '紅';
  if(c >= Math.max(5, avg*1.2)) return '黃';
  return '綠';
}

// 結合「聲量 (volume)」與「該時段內負面新聞比例」— 取較嚴重者。
// 解決外面綠燈裡面有負面新聞 的不一致，但用「比例 + 絕對數」雙門檻避免
// 1 則負面新聞就把整天/整小時拉成黃 — 比例不夠不算。
const LIGHT_RANK = { '綠': 0, '黃': 1, '紅': 2 };
function severityOf(a){
  return a.severity || (a.is_negative ? 'yellow' : null);
}
function severityLightOf(articles){
  return severityLightWithReason(articles).level;
}
// 留言燈號：跨 FB/IG/Threads 彙總所有 comments 的 signal 計數
// 用跟新聞同樣的門檻（紅/黃/綠 比例 + 絕對數）
function commentLightWithReason(commentsState){
  let total=0, reds=0, yellows=0;
  for (const plat of ['facebook','instagram','threads']){
    const arr = (commentsState && commentsState[plat]) || [];
    for (const c of arr){
      total++;
      if (c.signal === 'red') reds++;
      else if (c.signal === 'yellow') yellows++;
    }
  }
  const neg = reds + yellows;
  if (total === 0) return { level: '綠', reasons: ['尚無留言資料'], total };
  if (reds >= 3) return { level: '紅', reasons: [`紅燈留言 ${reds} 則（≥3 即紅）`], total };
  if (reds >= 1 && reds / total >= 0.10) return { level: '紅', reasons: [`紅燈留言佔比 ${(reds/total*100).toFixed(0)}%（${reds}/${total} 則 ≥10%）`], total };
  if (neg >= 10) return { level: '黃', reasons: [`負面留言 ${neg} 則（${reds} 紅 + ${yellows} 黃 ≥ 10）`], total };
  if (neg >= 1 && neg / total >= 0.30) return { level: '黃', reasons: [`負面留言佔比 ${(neg/total*100).toFixed(0)}%（${neg}/${total} 則 ≥ 30%）`], total };
  return { level: '綠', reasons: [], total };
}
function commentLightOf(commentsState){ return commentLightWithReason(commentsState).level; }
function severityLightWithReason(articles){
  const arts = articles || [];
  const total = arts.length;
  let reds = 0, yellows = 0;
  for (const a of arts){
    const s = severityOf(a);
    if (s === 'red') reds++;
    else if (s === 'yellow') yellows++;
  }
  const neg = reds + yellows;
  if (total === 0) return { level: '綠', reasons: [] };
  // 紅
  if (reds >= 3) return { level: '紅', reasons: [`紅燈新聞 ${reds} 則（≥3 即紅）`] };
  if (reds >= 1 && reds / total >= 0.25) return { level: '紅', reasons: [`紅燈新聞佔比 ${(reds/total*100).toFixed(0)}%（${reds}/${total} 則 ≥ 25%）`] };
  // 黃
  if (neg >= 5) return { level: '黃', reasons: [`負面新聞 ${neg} 則（${reds} 紅 + ${yellows} 黃 ≥ 5）`] };
  if (neg >= 1 && neg / total >= 0.30) return { level: '黃', reasons: [`負面新聞佔比 ${(neg/total*100).toFixed(0)}%（${neg}/${total} 則 ≥ 30%）`] };
  return { level: '綠', reasons: [] };
}
function combineLights(volumeLight, articles){
  const sevLight = severityLightOf(articles);
  return LIGHT_RANK[volumeLight] >= LIGHT_RANK[sevLight] ? volumeLight : sevLight;
}

function upsertChart(instance, ctx, config){
  // 若 type 變了（例如 line ↔ bar），必須 destroy + 重建；否則只更新 data/options。
  if(instance && instance.config && instance.config.type === config.type){
    instance.data=config.data; instance.options=config.options; instance.update(); return instance;
  }
  if(instance) instance.destroy();
  return new Chart(ctx, config);
}

// Shared tooltip style matching the dashboard's dark theme.
// Pass { callbacks: {...}, mode, displayColors } etc. to override.
function darkTooltip(overrides){
  return Object.assign({
    backgroundColor: 'rgba(18, 25, 53, 0.96)',
    borderColor: '#5a79ff',
    borderWidth: 1,
    titleColor: '#d8e2ff',
    bodyColor: '#d8e2ff',
    padding: 10,
    cornerRadius: 8,
    titleFont: { weight: '600', size: 13 },
    bodyFont: { size: 13 },
    displayColors: true,      // default true so multi-series charts still show color dots
    intersect: false,
  }, overrides || {});
}

// For line/bar charts with a time/category x-axis: "hover anywhere on x" behavior.
const INDEX_HOVER = { mode: 'index', intersect: false, axis: 'x' };

function pick(d, key24, key7){ return mode==='7d' ? (d[key7] ?? d[key24]) : d[key24]; }

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

// Format updated_at strings consistently as Taiwan time.
// Two input shapes coexist (RPC vs JSON fallback):
//   "2026-05-20 16:41:44.772134+00"  ← Supabase RPC (UTC, postgres tstz)
//   "2026-05-21 00:41:41"            ← social_signals.json (no TZ, already Taipei)
// Only strings ending in ±HH[:MM] or Z are parsed and re-rendered as Asia/Taipei;
// the date-part hyphens (e.g. -05-20) are NOT mis-detected as TZ markers.
// Tz-less strings are assumed already Taiwan-local and shown verbatim.
function formatUpdatedAt(s){
  if (!s || s === '-') return '-';
  const hasTimezone = /([+-]\d{2}(?::?\d{2})?|Z)$/.test(s);
  if (!hasTimezone) return s;
  // Normalise to ISO-8601 the way Date can parse:
  //   space → T, sub-millisecond digits dropped, naked ±HH padded to ±HH:00
  const iso = String(s)
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
}

// 擋掉測試殘留 / 空 URL — 只接受 http(s) 且不是 example.* / localhost test domain
function isSafeExternalUrl(u){
  if (!u || typeof u !== 'string') return false;
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  // 擋掉常見測試 / dummy domain
  if (/^example\.(test|com|net|org)$/.test(host)) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return true;
}

// 生成 「載入更多」按鈕 — 純前端 reveal (資料已全部 client-side、只是顯示量受限)
// container: 按鈕要放進的父節點
// listEl:    新 li append 到這
// items:     完整資料陣列
// alreadyShown: 已渲染數量
// batchSize: 每次點擊 reveal 多少
// renderFn:  (item, index) => HTMLElement (li / div)
function makeShowMoreButton(container, listEl, items, alreadyShown, batchSize, renderFn) {
  if (alreadyShown >= items.length) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'platform-more-btn';
  let shown = alreadyShown;
  const refresh = () => {
    if (shown >= items.length) {
      btn.textContent = '已全部顯示';
      btn.disabled = true;
      btn.classList.add('exhausted');
    } else {
      btn.textContent = `顯示更多（已顯示 ${shown} / ${items.length} 筆）`;
    }
  };
  refresh();
  btn.addEventListener('click', () => {
    const next = Math.min(shown + batchSize, items.length);
    for (let i = shown; i < next; i++) {
      listEl.appendChild(renderFn(items[i], i));
    }
    shown = next;
    refresh();
  });
  container.appendChild(btn);
  return btn;
}

// 生成 「載入更多」按鈕 — 走 RPC 重抓 (適合 server-side 資料量大、初始只拿 N)
// container: 按鈕要放進的父節點
// listEl:    新 li append 到這
// fetchFn:   (limit) => Promise<item[]> (回該 limit 內的最新 N 筆)
// renderFn:  (item, index) => HTMLElement
// initialCount: 第一輪已渲染的數量
// batchSize:    每次點擊 fetch 多多少
// onCountUpdate: optional (newLen) => void  給上層 update heading 等
function makeLoadMoreRPC(container, listEl, fetchFn, renderFn, initialCount, batchSize, onCountUpdate) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'platform-more-btn';
  let loaded = initialCount;
  btn.textContent = `載入更多（已顯示 ${loaded} 筆）`;
  btn.addEventListener('click', async () => {
    const next = loaded + batchSize;
    btn.disabled = true;
    btn.textContent = '載入中…';
    try {
      const fresh = await fetchFn(next);
      const arr = fresh || [];
      // 跳過已渲染、append 新的
      for (let i = loaded; i < arr.length; i++) {
        listEl.appendChild(renderFn(arr[i], i));
      }
      const newLen = arr.length;
      loaded = newLen;
      if (onCountUpdate) onCountUpdate(newLen);
      if (newLen < next) {
        btn.textContent = '已全部載入';
        btn.classList.add('exhausted');
      } else {
        btn.textContent = `載入更多（已顯示 ${newLen} 筆）`;
        btn.disabled = false;
      }
    } catch (e) {
      console.error('load-more fetch failed:', e);
      btn.textContent = '載入失敗、點此再試';
      btn.disabled = false;
    }
  });
  container.appendChild(btn);
  return btn;
}

// 拿掉 topic 名前綴的城市名 — hotspot title 多半有「{city}{event}」格式 (e.g. 台北鼠患事件)
// narrative arc 是「嘉郡/台中 圍繞的議題」、顯示時前綴城市反而誤導。
// 注意：去除後內容才是真議題本身、key (encoded data-topic) 維持原樣用來查 arc[idx]
const _TOPIC_CITY_PREFIX = /^(新北|新竹[市縣]|嘉義[市縣]|台北|桃園|台中|台南|高雄|基隆|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|台東|澎湖|金門|連江)/;
function prettifyTopic(name){
  if (!name || typeof name !== 'string') return name;
  const stripped = name.replace(_TOPIC_CITY_PREFIX, '');
  return stripped || name;   // 不允許完全空字串
}

// --------- Data fetching ---------
async function fetchJSON(path){
  try {
    const r = await fetch(path + '?t=' + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// --------- War-room ranking leaderboard ---------
// 規則：把每位的「紅+黃」新聞數加總當戰情分數；分數越低戰情越佳。
// 第 1 名 = 戰情最佳（負面+爭議最少）；最後一名 = 戰情最劣（負面+爭議最多）。
const SELF_NAME = '張嘉郡';
function renderWarRoomRanking(voiceBreakdown, mentionArticles){
  const board = document.getElementById('warRoomRankBoard');
  const verdict = document.getElementById('warRoomVerdict');
  if (!board) return;
  board.innerHTML = '';
  if (verdict) verdict.textContent = '';

  const articlesByName = mentionArticles || {};
  const entries = Object.entries(voiceBreakdown || {})
    .filter(([, v]) => v && (v.total || 0) > 0)
    .map(([name, v]) => ({
      name,
      red: v.red || 0,
      yellow: v.yellow || 0,
      green: v.green || 0,
      total: v.total || 0,
      score: (v.red || 0) + (v.yellow || 0),  // 紅+黃 = 戰情分數
      isSelf: name === SELF_NAME,
      articles: articlesByName[name] || [],
    }));

  if (entries.length === 0) {
    board.innerHTML = '<p class="hint">無資料</p>';
    return;
  }

  // 改：按「總曝光量」由高至低排序 — 純客觀、無「誰戰情好」的暗示
  // 之前用 (red+yellow) 越少越好 → 暗示 ranking 是好感度比較、有 sampling bias
  entries.sort((a, b) => b.total - a.total);
  const n = entries.length;

  entries.forEach((e, idx) => {
    const rank = idx + 1;
    const row = document.createElement('div');
    // 移除 rank-best / rank-worst class — 跟「不算分」原則衝突
    row.className = 'rank-row' + (e.isSelf ? ' is-self' : '');
    // 點 row → 打開該人物 24h 新聞 modal（張嘉郡 row 也帶今日留言）
    if (e.articles && e.articles.length > 0) {
      row.classList.add('rank-clickable');
      row.title = `點擊查看 ${e.name} 24h 內 ${e.articles.length} 則新聞`;
      row.addEventListener('click', () => {
        // 我方（張嘉郡）才有留言可看；對手沒爬留言、留 empty
        const todayComments = e.isSelf ? [
          ...(state.comments.facebook || []).map(c => ({...c, platform: 'facebook'})),
          ...(state.comments.instagram || []).map(c => ({...c, platform: 'instagram'})),
          ...(state.comments.threads || []).map(c => ({...c, platform: 'threads'})),
        ] : [];
        const cmtNote = e.isSelf ? '' : '（對手無爬留言、僅有新聞）';
        const note = `共 ${e.total} 則新聞 ｜ 🔴 ${e.red} ／ 🟡 ${e.yellow} ／ 🟢 ${e.green} ${cmtNote}`;
        const titlePrefix = e.isSelf ? '張嘉郡（我方） 24h 新聞 + 留言' : `${e.name} 24h 新聞`;
        openArticlesModal(titlePrefix, note, e.articles, todayComments);
      });
    }

    // 不再標「最佳 🏆 / 最劣 🚨」— 跟「不評好感度」原則衝突
    // 改顯示純粹的順序編號 + 紅黃比例（讓使用者自己判讀，不暗示誰戰情好）
    const rankCol = document.createElement('div');
    rankCol.className = 'rank-num';
    rankCol.innerHTML = `${rank}.`;

    // 名字 + breakdown
    const nameCol = document.createElement('div');
    nameCol.className = 'rank-name';
    const selfTag = e.isSelf ? '<span class="self-tag">我方</span>' : '';
    nameCol.innerHTML = `${e.name}${selfTag}<span class="breakdown">總 ${e.total} 則 ｜ 🔴 ${e.red} ／ 🟡 ${e.yellow} ／ 🟢 ${e.green}</span>`;

    // 視覺長條（紅黃綠 比例）
    const bar = document.createElement('div');
    bar.className = 'rank-bar';
    const segs = [
      { cls: 'seg-red', val: e.red },
      { cls: 'seg-yellow', val: e.yellow },
      { cls: 'seg-green', val: e.green },
    ];
    segs.forEach(s => {
      if (s.val > 0) {
        const span = document.createElement('span');
        span.className = s.cls;
        span.style.flex = String(s.val);
        span.textContent = s.val;
        bar.appendChild(span);
      }
    });

    // 改：不再顯示「戰情分數」— 改顯示總曝光量
    // 原本 (red+yellow) 越低越好的 framing 有 sampling bias 問題（2 人媒體曝光不對等）
    const total = document.createElement('div');
    total.className = 'rank-score';
    total.innerHTML = `${e.total}<span class="score-label">則</span>`;

    row.append(rankCol, nameCol, bar, total);
    board.appendChild(row);
  });

  // 改：不再說「排第幾名」(避免暗示 cross-person 排名是好感度比較)
  if (verdict) {
    const totalAll = entries.reduce((s, e) => s + e.total, 0);
    const selfEntry = entries.find(e => e.isSelf);
    const selfShare = selfEntry && totalAll ? (selfEntry.total / totalAll * 100).toFixed(0) : '0';
    verdict.textContent = `📊 24h 曝光分布：張嘉郡 ${selfShare}%（${selfEntry?.total || 0}/${totalAll} 條）｜「曝光量本身不代表好感度，請以上方 7 天好感度趨勢為準」`;
  }
}

// --------- Self favorability 7-day trend chart ---------
let selfFavorabilityChart = null;
function renderSelfFavorability(history){
  const canvas = document.getElementById('selfFavorabilityChart');
  if (!canvas) return;
  if (!history || !history.length) {
    canvas.style.display = 'none';
    const meta = document.getElementById('selfFavorabilityMeta');
    if (meta) meta.textContent = '資料準備中…';
    return;
  }
  canvas.style.display = '';
  const labels = history.map(h => h.date.slice(5));  // MM-DD
  const scores = history.map(h => h.score);
  // 點顏色：< 50 紅 / 50-70 黃 / 70+ 綠；樣本不足空心
  const pointBg = history.map(h => {
    if (h.samples_low) return 'rgba(255,255,255,0.3)';
    if (h.score < 50) return '#c43344';
    if (h.score < 70) return '#c08c12';
    return '#1f8a4c';
  });
  selfFavorabilityChart = upsertChart(selfFavorabilityChart, canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '好感度分數',
        data: scores,
        borderColor: '#2b7aa8',
        backgroundColor: 'rgba(121,164,255,0.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: pointBg,
        pointBorderColor: '#fff',
        pointRadius: 6,
        pointHoverRadius: 8,
      }],
    },
    options: {
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      // 點擊任一資料點 → 開該日全部新聞 modal
      onClick: (evt, elements) => {
        if (!elements || !elements.length) return;
        const idx = elements[0].index;
        const h = history[idx];
        if (!h) return;
        const c = h.comments || {red:0, yellow:0, green:0, total:0};
        const samples = h.comment_samples || [];
        const cR = samples.filter(s => s.signal === 'red').length;
        const cY = samples.filter(s => s.signal === 'yellow').length;
        const cG = samples.filter(s => s.signal === 'green').length;
        const stagnantNote = c.stagnant ? ' 🟫 信號降權' : '';
        const note = `${h.date} ｜ 分數 ${h.score} ｜ 新聞 紅${h.red} 黃${h.yellow} 綠${h.green}（危機 ${h.crisis} 條） ｜ 當日留言 ${samples.length} 則（紅${cR} 黃${cY} 綠${cG}）${stagnantNote}`
          + (h.samples_low ? ' ⚠️ 樣本不足' : '');
        // load-more: 用 migration 017 的 day-drilldown RPC、拉同一天更多 articles + comments
        const dayDate = h.date;
        const drilldownCache = { lastFetch: null };
        const makeDayFetcher = (kind) => async (newLimit) => {
          // 一次 RPC 同時返 articles + comments;
          // 因為 button 各自獨立、避免兩個 button 都觸發 RPC、用 simple 快取
          if (!drilldownCache.lastFetch || drilldownCache.lastFetch.limit < newLimit) {
            const news_n = kind === 'news' ? newLimit : (drilldownCache.lastFetch?.news_n || 50);
            const cmt_n  = kind === 'cmt'  ? newLimit : (drilldownCache.lastFetch?.cmt_n  || 100);
            const r = await LxyDB.client().rpc('dashboard_favorability_day_drilldown',
              { day_date: dayDate, news_n: news_n, cmt_n: cmt_n });
            if (r.error) throw r.error;
            drilldownCache.lastFetch = { limit: newLimit, news_n, cmt_n, data: r.data };
          }
          return kind === 'news'
            ? (drilldownCache.lastFetch.data.articles || [])
            : (drilldownCache.lastFetch.data.comments || []);
        };
        // 真實 total = 當日新聞 + 當日留言 (full count、不是 sample count)
        const realTotal = (h.total || 0) + ((h.comments && h.comments.total) || 0);
        openArticlesModal(`📰 ${h.date} 張嘉郡新聞 + 留言`, note,
                          h.articles || [], samples,
                          {
                            newsFetchFn: makeDayFetcher('news'),
                            cmtFetchFn:  makeDayFetcher('cmt'),
                            newsBatch:   50,
                            cmtBatch:    100,
                          },
                          realTotal);
      },
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements && elements.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: darkTooltip({
          mode: 'index',
          callbacks: {
            label: (ctx) => {
              const h = history[ctx.dataIndex];
              const c = h.comments || {red:0, yellow:0, green:0, total:0};
              const flag = h.samples_low ? ' ⚠️ 樣本不足' : '';
              const stale = c.stagnant ? '（🟫 留言低、信號降權）' : '';
              return [
                `分數: ${h.score}${flag}`,
                `📰 新聞 紅${h.red} 黃${h.yellow} 綠${h.green} (總${h.total}, 危機${h.crisis})`,
                `💬 留言 紅${c.red} 黃${c.yellow} 綠${c.green} (總${c.total})${stale}`,
                `👆 點此查看新聞 ${(h.articles || []).length} 則 + 留言`,
              ];
            },
          },
        }),
      },
      scales: {
        y: { min: 0, max: 100, ticks: { color: '#b9c3f2' }, grid: { color: 'rgba(0,85,132,0.08)' } },
        x: { ticks: { color: '#b9c3f2' }, grid: { color: 'rgba(0,85,132,0.08)' } },
      },
    },
  });
  // 摘要文字
  const meta = document.getElementById('selfFavorabilityMeta');
  if (meta) {
    const today = history[history.length - 1];
    const yesterday = history[history.length - 2];
    let trendIcon = '➡️';
    let trendText = '持平';
    if (today && yesterday) {
      const delta = today.score - yesterday.score;
      if (delta > 5) { trendIcon = '⬆️'; trendText = `較昨日 +${delta.toFixed(1)}`; }
      else if (delta < -5) { trendIcon = '⬇️'; trendText = `較昨日 ${delta.toFixed(1)}`; }
      else trendText = `較昨日 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
    }
    const sevenDayMin = Math.min(...history.map(h => h.score));
    const sevenDayMax = Math.max(...history.map(h => h.score));
    meta.innerHTML = `今日 <b>${today.score}</b> ${trendIcon} ${trendText} ｜ 7 天區間 ${sevenDayMin.toFixed(1)} - ${sevenDayMax.toFixed(1)}` +
      (today.samples_low ? ' ｜ ⚠️ 今日樣本不足、信賴度低' : '');
  }
}


// --------- Topic narrative 7-day arc rendering ---------
function renderTopicNarrative(arcs){
  const wrap = document.getElementById('topicNarrativeBoard');
  if (!wrap) return;
  wrap.innerHTML = '';
  const topics = Object.entries(arcs || {});
  if (!topics.length) {
    wrap.innerHTML = '<p class="hint">過去 7 天無重點議題敘事資料</p>';
    return;
  }
  // 按 7 天 total 紅燈比例排序、最先顯示「最危險」議題
  topics.sort(([, a], [, b]) => {
    const aRed = a.reduce((s, x) => s + x.red, 0);
    const bRed = b.reduce((s, x) => s + x.red, 0);
    if (aRed !== bRed) return bRed - aRed;
    return b.reduce((s, x) => s + x.total, 0) - a.reduce((s, x) => s + x.total, 0);
  });
  for (const [topic, arc] of topics) {
    const totalRed = arc.reduce((s, x) => s + x.red, 0);
    const totalYellow = arc.reduce((s, x) => s + x.yellow, 0);
    const totalGreen = arc.reduce((s, x) => s + x.green, 0);
    const total = totalRed + totalYellow + totalGreen;

    const row = document.createElement('div');
    row.className = 'topic-arc-row';
    const displayName = prettifyTopic(topic);
    // 標題列
    const headerHtml = `<div class="topic-arc-header">
      <span class="topic-arc-name">${escapeHtml(displayName)}</span>
      <span class="topic-arc-summary">7 天 ${total} 條 ｜ 🔴 ${totalRed} ／ 🟡 ${totalYellow} ／ 🟢 ${totalGreen}</span>
    </div>`;
    // 7 天 stacked bar — 每個 cell 點擊可看當日該議題新聞
    const maxDay = Math.max(...arc.map(x => x.total), 1);
    const cellsHtml = arc.map((x, dayIdx) => {
      const heightPct = (x.total / maxDay) * 100;
      const segs = [];
      if (x.red > 0) segs.push(`<span class="seg-red" style="flex:${x.red}" title="紅 ${x.red}"></span>`);
      if (x.yellow > 0) segs.push(`<span class="seg-yellow" style="flex:${x.yellow}" title="黃 ${x.yellow}"></span>`);
      if (x.green > 0) segs.push(`<span class="seg-green" style="flex:${x.green}" title="綠 ${x.green}"></span>`);
      const clickable = x.total > 0 ? ' topic-arc-cell-clickable' : '';
      return `<div class="topic-arc-cell${clickable}" data-topic="${encodeURIComponent(topic)}" data-day="${dayIdx}" title="${x.date}: 紅${x.red}/黃${x.yellow}/綠${x.green}${x.total > 0 ? ' — 點擊看新聞' : ''}">
        <div class="topic-arc-bar" style="height:${heightPct}%">${segs.join('')}</div>
        <div class="topic-arc-date">${x.date.slice(5)}</div>
      </div>`;
    }).join('');
    row.innerHTML = headerHtml + `<div class="topic-arc-cells">${cellsHtml}</div>`;
    // 綁 cell click → 開 modal 顯示當日該議題新聞 + 該日留言（按 topic filter）
    row.querySelectorAll('.topic-arc-cell-clickable').forEach((cell) => {
      cell.addEventListener('click', () => {
        const t = decodeURIComponent(cell.dataset.topic);
        const tDisplay = prettifyTopic(t);
        const dayIdx = parseInt(cell.dataset.day, 10);
        const dayData = arc[dayIdx];
        if (!dayData) return;
        // 留言用「prettified topic」match — 比 raw (含城市前綴) 寬鬆、抓到更多相關留言
        const dayComments = (state.commentsByDate || {})[dayData.date] || [];
        const topicComments = dayComments.filter(c => (c.text || '').includes(tDisplay));
        const cmtNote = topicComments.length === 0
          ? `（${dayData.date} 留言中無命中此議題）`
          : '';
        const note = `${dayData.date} ｜ 議題「${tDisplay}」 ｜ 紅 ${dayData.red} ／ 黃 ${dayData.yellow} ／ 綠 ${dayData.green} ｜ 共 ${dayData.total} 條 ${cmtNote}`;
        openArticlesModal(`🔥 ${tDisplay} — ${dayData.date} 新聞 + 留言`, note, dayData.articles || [], topicComments);
      });
    });
    wrap.appendChild(row);
  }
}


// --------- Social signal cards (clickable) ---------
function renderSocialCards(){
  const wrap = document.getElementById('socialSignals');
  if (!wrap) return;
  wrap.innerHTML = '';
  const ss = state.socialSignals || {};
  ['facebook', 'instagram', 'threads'].forEach(p => {
    const s = ss[p] || { total: 0, red: 0, yellow: 0, green: 0, updated_at: '-' };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'social-card';
    btn.setAttribute('aria-label', `${PLATFORM_LABEL[p]} 留言明細`);
    btn.innerHTML = `
      <h3>${PLATFORM_LABEL[p]}（總留言 ${s.total || 0}）</h3>
      <div class="social-row"><span class="tag">🔴 紅燈</span><strong>${s.red || 0}</strong></div>
      <div class="social-row"><span class="tag">🟡 黃燈</span><strong>${s.yellow || 0}</strong></div>
      <div class="social-row"><span class="tag">🟢 綠燈</span><strong>${s.green || 0}</strong></div>
      <div class="social-row" style="opacity:.75;font-size:12px"><span>更新</span><span>${escapeHtml(formatUpdatedAt(s.updated_at))}</span></div>
      <div class="drill-hint">▸ 點擊查看完整留言</div>
    `;
    btn.addEventListener('click', () => openModal(p, 'all'));
    wrap.appendChild(btn);
  });
}

// --------- Red-ratio alert ---------
function updateAlertBanner(){
  const el = document.getElementById('alertBanner');
  if (!el) return;
  const ss = state.socialSignals || {};
  const redPlatforms = [];
  const warnPlatforms = [];
  ['facebook','instagram','threads'].forEach(p => {
    const s = ss[p] || {};
    const total = Number(s.total) || 0;
    if (!total) return;
    const redPct = total ? (Number(s.red) || 0) / total : 0;
    const nonGreenPct = total ? ((Number(s.red) || 0) + (Number(s.yellow) || 0)) / total : 0;
    if (redPct >= RED_RATIO_ALERT) redPlatforms.push({p, redPct});
    else if (nonGreenPct >= YELLOW_RATIO_WARN) warnPlatforms.push({p, nonGreenPct});
  });
  if (redPlatforms.length){
    el.classList.remove('hidden', 'level-yellow');
    el.classList.add('level-red');
    const chips = redPlatforms.map(x =>
      `<span class="chip">${PLATFORM_LABEL[x.p]} 紅 ${(x.redPct*100).toFixed(1)}%</span>`
    ).join('');
    el.innerHTML = `
      <span class="icon">🚨</span>
      <span class="msg">紅燈留言占比達警示門檻（≥${(RED_RATIO_ALERT*100)}%）。建議立即檢視紅燈留言清單。</span>
      <span class="platform-chips">${chips}</span>
    `;
  } else if (warnPlatforms.length){
    el.classList.remove('hidden', 'level-red');
    el.classList.add('level-yellow');
    const chips = warnPlatforms.map(x =>
      `<span class="chip">${PLATFORM_LABEL[x.p]} 非綠 ${(x.nonGreenPct*100).toFixed(1)}%</span>`
    ).join('');
    el.innerHTML = `
      <span class="icon">⚠️</span>
      <span class="msg">非綠燈（紅+黃）占比偏高，請關注輿情走向。</span>
      <span class="platform-chips">${chips}</span>
    `;
  } else {
    el.classList.add('hidden');
    el.classList.remove('level-red', 'level-yellow');
    el.innerHTML = '';
  }
}

// --------- Red-ratio trend chart (historical) ---------
function renderRedTrendChart(){
  const canvas = document.getElementById('redTrendChart');
  if (!canvas) return;
  const hist = state.history || {};
  const fmtLabel = (iso) => (iso || '').slice(5, 16).replace('T', ' ');

  // Build unified x-axis from the union of timestamps
  const allTs = new Set();
  ['facebook','instagram','threads'].forEach(p => (hist[p] || []).forEach(x => allTs.add(x.ts)));
  const labels = Array.from(allTs).sort();
  const series = {
    facebook: new Map((hist.facebook||[]).map(x => [x.ts, x.red_pct])),
    instagram: new Map((hist.instagram||[]).map(x => [x.ts, x.red_pct])),
    threads: new Map((hist.threads||[]).map(x => [x.ts, x.red_pct])),
  };
  const datasets = [
    { label: 'Facebook', color: '#5a79ff' },
    { label: 'Instagram', color: '#e83e8c' },
    { label: 'Threads', color: '#c08c12' },
  ].map(({label, color}) => {
    const key = label.toLowerCase();
    return {
      label,
      data: labels.map(ts => series[key].get(ts) ?? null),
      borderColor: color,
      backgroundColor: color + '33',
      tension: 0.3,
      spanGaps: true,
    };
  });

  // Enhance dataset styling for nicer hover markers
  datasets.forEach(ds => {
    ds.pointRadius = 0;
    ds.pointHoverRadius = 5;
    ds.pointHoverBackgroundColor = '#fff';
    ds.pointHoverBorderColor = ds.borderColor;
    ds.pointHoverBorderWidth = 2;
    ds.borderWidth = 1.8;
  });
  redTrendChart = upsertChart(redTrendChart, canvas, {
    type: 'line',
    data: { labels: labels.map(fmtLabel), datasets },
    options: {
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: darkTooltip({
          mode: 'index',
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}：${ctx.parsed.y == null ? '—' : ctx.parsed.y.toFixed(1) + '%'}`,
          },
        }),
      },
      scales: {
        x: { ticks: { color: '#b9c3f2', maxRotation: 30 } },
        y: { ticks: { color: '#b9c3f2', callback: v => v + '%' }, beginAtZero: true, suggestedMax: 50 },
      },
    }
  });
}

// --------- Red comments panel (grouped by platform) ---------
function renderRedCommentsPanel(){
  const wrap = document.getElementById('redComments');
  if (!wrap) return;
  wrap.innerHTML = '';
  let anyShown = false;
  ['facebook','instagram','threads'].forEach(p => {
    const reds = (state.comments[p] || []).filter(c => c.signal === 'red');
    if (!reds.length) return;
    anyShown = true;
    const group = document.createElement('div');
    group.className = 'red-group';
    const title = document.createElement('h3');
    title.textContent = `${PLATFORM_LABEL[p]}（${reds.length} 則）`;
    group.appendChild(title);
    const ul = document.createElement('ul');
    const INITIAL_RED = 30;
    const renderRedLi = (c) => {
      const li = document.createElement('li');
      const authorHtml = `<span class="author">${escapeHtml(c.author || '匿名')}</span>` +
                        (c.time_text ? `<span class="when">（${escapeHtml(c.time_text)}）</span>` : '');
      let textHtml = escapeHtml(c.text || '');
      if (c.url) {
        textHtml = `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${textHtml}</a>`;
      }
      li.innerHTML = `${authorHtml}<br/>${textHtml}`;
      return li;
    };
    reds.slice(0, INITIAL_RED).forEach(c => ul.appendChild(renderRedLi(c)));
    group.appendChild(ul);
    // 客戶端 reveal more (資料已 client-side 全載入、只是 UI 限量)
    makeShowMoreButton(group, ul, reds, INITIAL_RED, 30, renderRedLi);
    wrap.appendChild(group);
  });
  if (!anyShown){
    wrap.innerHTML = '<p class="hint">目前無紅燈留言。</p>';
  }
}

// --------- Topic heat (Google Trends iframe + our-data chart) ---------
// Link to the public Google Trends explore page (opens in a new tab).
// trends.google.com blocks iframe embedding from most origins, so we link out
// instead of iframing — cleaner and always works.
function buildTrendsExploreUrl(topic){
  const q = encodeURIComponent(topic.trends_keyword);
  const geo = encodeURIComponent(topic.geo || 'TW');
  const date = encodeURIComponent(topic.time_range || 'today 5-y');
  return `https://trends.google.com/trends/explore?date=${date}&geo=${geo}&q=${q}&hl=zh-TW`;
}

function renderTopicHeat(){
  const heat = state.topicHeat;
  if (!heat || !heat.topics || !heat.topics.length) return;
  const sel = document.getElementById('topicSelect');
  if (!sel) return;
  // Rebuild select options only if changed
  const existingIds = Array.from(sel.options).map(o => o.value).join(',');
  const newIds = heat.topics.map(t => t.id).join(',');
  if (existingIds !== newIds){
    sel.innerHTML = '';
    heat.topics.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.label;
      sel.appendChild(opt);
    });
  }
  if (!state.selectedTopicId || !heat.topics.some(t => t.id === state.selectedTopicId)){
    state.selectedTopicId = heat.topics[0].id;
  }
  sel.value = state.selectedTopicId;
  const topic = heat.topics.find(t => t.id === state.selectedTopicId) || heat.topics[0];
  // Google Trends external link (interactive version, opens in new tab)
  const link = document.getElementById('topicTrendsLink');
  const linkLabel = document.getElementById('topicTrendsLinkLabel');
  if (link){
    link.href = buildTrendsExploreUrl(topic);
    if (linkLabel) linkLabel.textContent = `在 Google Trends 查看「${topic.label}」互動版`;
  }
  // Google Trends inline line chart (5y weekly series fetched by pytrends)
  renderTrendsChart(topic);
  // Info text
  const info = document.getElementById('topicInfo');
  if (info){
    const total = topic.our_data?.total || 0;
    const kws = (topic.match_keywords || []).join('、');
    info.textContent = `（關鍵字：${kws}　我方共 ${total} 則）`;
  }
  // Our-data bar chart
  const canvas = document.getElementById('topicOwnChart');
  if (!canvas) return;
  const daily = topic.our_data?.daily || [];
  const labels = daily.map(d => d.date);
  const counts = daily.map(d => d.count);
  topicOwnChart = upsertChart(topicOwnChart, canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `提及數（${topic.label}）`,
        data: counts,
        backgroundColor: '#5a79ff',
        hoverBackgroundColor: '#5a79ff',
        borderRadius: 4,
      }],
    },
    options: {
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (ctx) => `提及：${ctx.parsed.y} 則`,
          },
        }),
      },
      scales: {
        x: { ticks: { color: '#b9c3f2' }, grid: { color: 'rgba(0,85,132,0.08)' } },
        y: { ticks: { color: '#b9c3f2', precision: 0 }, beginAtZero: true, grid: { color: 'rgba(0,85,132,0.08)' } },
      },
    },
  });
}

function renderTrendsChart(topic){
  const canvas = document.getElementById('topicTrendsChart');
  const meta = document.getElementById('topicTrendsMeta');
  if (!canvas) return;
  const gt = topic.google_trends;
  if (!gt || !gt.points || !gt.points.length){
    // Nothing to draw — clear canvas and show a note
    if (topicTrendsChart){ topicTrendsChart.destroy(); topicTrendsChart = null; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (meta) meta.innerHTML = '<span class="trends-warn">⚠️ Google Trends 尚未取得資料（可能 Google 暫時封鎖 pytrends）。請稍後重跑 <code>update_topic_heat_lxy.py</code>。</span>';
    return;
  }
  const pts = gt.points;
  const labels = pts.map(p => p.date);
  const values = pts.map(p => p.value);
  const peak = values.reduce((a,b) => a > b ? a : b, 0);
  const peakIdx = values.indexOf(peak);
  const peakDate = labels[peakIdx];
  topicTrendsChart = upsertChart(topicTrendsChart, canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `${topic.label} 熱度 (0–100)`,
        data: values,
        borderColor: '#5a79ff',
        backgroundColor: 'rgba(127,192,255,0.18)',
        fill: true,
        tension: 0.15,
        pointRadius: 0,           // baseline: dots hidden for a clean line
        pointHoverRadius: 5,      // highlight the point under the cursor
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#5a79ff',
        pointHoverBorderWidth: 2,
        borderWidth: 1.8,
      }],
    },
    options: {
      // Index mode: hover anywhere on the x-axis shows the nearest week's
      // tooltip (instead of requiring a pixel-exact hover on a data point).
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      hover: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(18, 25, 53, 0.96)',
          borderColor: '#5a79ff',
          borderWidth: 1,
          titleColor: '#d8e2ff',
          bodyColor: '#d8e2ff',
          padding: 10,
          cornerRadius: 8,
          titleFont: { weight: '600', size: 13 },
          bodyFont: { size: 13 },
          displayColors: false,
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (ctx) => `熱度：${ctx.parsed.y} / 100`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#b9c3f2',
            maxTicksLimit: 8,   // 262 個點，Chart.js 自動挑子集顯示 label
            maxRotation: 0,
            autoSkip: true,
          },
          grid: { color: 'rgba(120,140,200,0.06)' },
        },
        y: {
          beginAtZero: true, suggestedMax: 100,
          ticks: { color: '#b9c3f2', stepSize: 25 },
          grid: { color: 'rgba(0,85,132,0.08)' },
        },
      },
    },
  });
  canvas.style.cursor = 'crosshair';   // affordance: hints the line is interactive
  if (meta){
    const fetched = gt.fetched_at ? new Date(gt.fetched_at).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }) : '—';
    const stale = gt.stale ? `<span class="trends-warn">（快取資料，最新一次 fetch 失敗）</span>` : '';
    meta.innerHTML = `
      共 ${pts.length} 筆（週頻率）　｜　峰值 <b>${peak}</b> @ ${peakDate}　｜　抓取時間：${fetched} ${stale}
    `;
  }
}

function initTopicHeat(){
  const sel = document.getElementById('topicSelect');
  if (sel && !sel.dataset.bound){
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      state.selectedTopicId = sel.value;
      renderTopicHeat();
    });
  }
  initCustomTrendQuery();
}

// --------- Custom keyword Google Trends query ---------
const _CUSTOM_TREND_LS_KEY = 'lxy.dashboard.customTrendRecent.v1';

function _loadRecentCustomTrends(){
  try {
    const raw = localStorage.getItem(_CUSTOM_TREND_LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function _saveRecentCustomTrends(list){
  try {
    localStorage.setItem(_CUSTOM_TREND_LS_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {}
}

function _renderRecentCustomTrends(){
  const wrap = document.getElementById('topicCustomRecent');
  if (!wrap) return;
  const list = _loadRecentCustomTrends();
  if (list.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '<span class="recent-label">最近查過：</span>' +
    list.map((kw, i) => `<button type="button" class="recent-chip" data-kw="${encodeURIComponent(kw)}">${kw}</button>`).join('') +
    '<button type="button" class="recent-clear" title="清除歷史">✕</button>';
  wrap.querySelectorAll('.recent-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const kw = decodeURIComponent(btn.dataset.kw || '');
      const inp = document.getElementById('topicCustomInput');
      if (inp) inp.value = kw;
      _runCustomTrendQuery();
    });
  });
  const clearBtn = wrap.querySelector('.recent-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    _saveRecentCustomTrends([]); _renderRecentCustomTrends();
  });
}

function _runCustomTrendQuery(){
  const inp = document.getElementById('topicCustomInput');
  const geoSel = document.getElementById('topicCustomGeo');
  const rangeSel = document.getElementById('topicCustomRange');
  const kw = (inp?.value || '').trim();
  if (!kw){
    if (inp) { inp.focus(); inp.placeholder = '請先輸入關鍵字'; }
    return;
  }
  const range = rangeSel?.value || 'today 12-m';
  const geo = geoSel?.value || 'TW';

  // 內嵌式 Google Trends widget — 用官方 embed URL（tz=-480 = UTC+8）
  const req = {
    comparisonItem: [{ keyword: kw, geo: geo, time: range }],
    category: 0,
    property: '',
  };
  const embedUrl = `https://trends.google.com/trends/embed/explore/TIMESERIES?req=${encodeURIComponent(JSON.stringify(req))}&tz=-480&hl=zh-TW`;
  const exploreUrl = `https://trends.google.com/trends/explore?date=${encodeURIComponent(range)}&geo=${encodeURIComponent(geo)}&q=${encodeURIComponent(kw)}&hl=zh-TW`;

  const embedWrap = document.getElementById('topicCustomEmbed');
  if (embedWrap){
    embedWrap.innerHTML = `
      <div class="topic-custom-embed-header">
        🔎 <b>「${_escapeHtml(kw)}」</b> ｜ ${_geoLabel(geo)} ｜ ${_rangeLabel(range)}
        <span class="topic-custom-embed-hint" id="topicCustomEmbedHint">載入中… <span class="muted">（如數秒未顯示，可點右側「開新分頁」）</span></span>
      </div>
      <iframe class="topic-custom-embed-iframe"
              src="${embedUrl}"
              loading="lazy"
              referrerpolicy="no-referrer"></iframe>
    `;
    const iframe = embedWrap.querySelector('iframe');
    if (iframe){
      iframe.addEventListener('load', () => {
        const hint = document.getElementById('topicCustomEmbedHint');
        if (hint) hint.textContent = '';
      });
    }
  }

  // 同時更新「外開新分頁」按鈕（萬一 iframe 被擋）
  const extBtn = document.getElementById('topicCustomExternalBtn');
  if (extBtn){
    extBtn.href = exploreUrl;
    extBtn.style.display = 'inline-flex';
    extBtn.title = `在新分頁開啟 Google Trends：${kw}`;
  }

  // 寫入 localStorage 最近清單（最新在前、去重、最多 10 筆）
  const list = _loadRecentCustomTrends().filter(x => x !== kw);
  list.unshift(kw);
  _saveRecentCustomTrends(list);
  _renderRecentCustomTrends();
}

function _escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function _geoLabel(g){ return g === 'TW' ? '台灣' : (g === '' ? '全球' : g); }

function _rangeLabel(r){
  return ({
    'now 1-d': '過去 24 小時',
    'now 7-d': '過去 7 天',
    'today 1-m': '過去 30 天',
    'today 3-m': '過去 90 天',
    'today 12-m': '過去 1 年',
    'today 5-y': '過去 5 年',
  })[r] || r;
}

function initCustomTrendQuery(){
  const btn = document.getElementById('topicCustomBtn');
  const inp = document.getElementById('topicCustomInput');
  if (btn && !btn.dataset.bound){
    btn.dataset.bound = '1';
    btn.addEventListener('click', _runCustomTrendQuery);
  }
  if (inp && !inp.dataset.bound){
    inp.dataset.bound = '1';
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter'){ e.preventDefault(); _runCustomTrendQuery(); }
    });
  }
  _renderRecentCustomTrends();
}

// --------- Drilldown modal ---------
const modalState = { platform: 'facebook', filter: 'all' };

function openModal(platform, filter){
  modalState.platform = platform;
  modalState.filter = filter || 'all';
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('modalTitle').textContent = `${PLATFORM_LABEL[platform]} 留言明細`;
  // sync filter buttons
  document.querySelectorAll('#modalFilters .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === modalState.filter);
  });
  renderModalBody();
}

function closeModal(){
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function renderModalBody(){
  const body = document.getElementById('modalBody');
  const summary = document.getElementById('modalSummary');
  if (!body) return;
  const list = (state.comments[modalState.platform] || []);
  const filtered = modalState.filter === 'all'
    ? list
    : list.filter(c => c.signal === modalState.filter);
  const counts = { red: 0, yellow: 0, green: 0 };
  list.forEach(c => { if (counts[c.signal] != null) counts[c.signal]++; });
  if (summary) {
    summary.textContent = `共 ${list.length} 則（🔴 ${counts.red} / 🟡 ${counts.yellow} / 🟢 ${counts.green}）　｜　本視圖：${filtered.length} 則`;
  }
  body.innerHTML = '';
  if (!filtered.length){
    body.innerHTML = '<p class="hint" style="padding:20px;text-align:center">沒有符合條件的留言。</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach(c => {
    const div = document.createElement('div');
    div.className = 'comment-item';
    const lightClass = c.signal || 'green';
    const lightLabel = { red:'🔴 紅', yellow:'🟡 黃', green:'🟢 綠' }[lightClass] || lightClass;
    const url = c.url
      ? `<div class="linkrow"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">原文連結 ↗</a></div>`
      : '';
    div.innerHTML = `
      <div class="hdr">
        <span class="author">${escapeHtml(c.author || '匿名')}</span>
        <span class="when">${escapeHtml(c.time_text || '')}</span>
        <span class="light-chip ${lightClass}">${lightLabel}</span>
      </div>
      <div class="text">${escapeHtml(c.text || '')}</div>
      ${url}
    `;
    // LLM feedback loop — admin sees 🚩 標錯了 on each comment.
    // target_id comes from update_lxy_social_signals.py's _comment_id()
    // and matches social_comments.comment_id (trigger in migration 015).
    if (c.comment_id) {
      attachCorrectionAffordance(div, {
        target_type:    'comment',
        target_id:      c.comment_id,
        original_label: lightClass,
        context:        (c.text || '').slice(0, 80),
      });
    }
    frag.appendChild(div);
  });
  body.appendChild(frag);
}

function inferLocationFromText(text){
  const t = String(text || '');
  const hit = LOCATION_HINTS.find(x => t.includes(x.k));
  return hit || null;
}

function deriveCommentHotspots(){
  const out = [];
  COMMENT_EVENT_RULES.forEach(rule => {
    const platforms = new Set();
    let hits = 0;
    let inferred = null;

    ['facebook','instagram','threads'].forEach(p => {
      (state.comments[p] || []).forEach(c => {
        const txt = String(c.text || '');
        if (rule.keywords.some(k => txt.includes(k))) {
          hits += 1;
          platforms.add(PLATFORM_LABEL[p] || p);
          if (!inferred) inferred = inferLocationFromText(txt);
        }
      });
    });

    if (hits > 0) {
      out.push({
        title: rule.title,
        place: inferred?.place || rule.place,
        lat: inferred?.lat ?? rule.lat,
        lng: inferred?.lng ?? rule.lng,
        level: rule.level,
        source: 'comment',
        platform: `留言：${Array.from(platforms).join(' / ')}`,
        note: `自動偵測 ${hits} 則相關留言`
      });
    }
  });
  return out;
}

function formatLifetimeHint(h){
  const newsCount = h.news_count || 0;
  const commentCount = h.comment_count || 0;
  const expiresIso = h.news_full_expires_at;

  if (newsCount > 0 && expiresIso){
    const expires = new Date(expiresIso).getTime();
    const now = Date.now();
    const hoursLeft = Math.max(0, (expires - now) / 3600000);
    const hoursStr = hoursLeft >= 1 ? `${hoursLeft.toFixed(0)} 小時` : '不到 1 小時';
    if (commentCount > 0){
      return `預估新聞訊號 ${hoursStr}後完全退場（留言訊號可能延長壽命）`;
    }
    return `預估 ${hoursStr}後完全退場（新聞滑出 24h 窗）`;
  }

  if (commentCount > 0){
    return `依粉專留言下一次抓取結果調整（每小時更新）`;
  }
  return '';
}

// 雲林議題熱點：用 DEFAULT_HOTSPOTS + COMMENT_EVENT_RULES 的關鍵字配對真實 24h 新聞，
// 掛上 news_articles / level / 計數 → 地圖標得出來、卡片點開有新聞。
function buildZjgHotspots(d){
  const articles = (Array.isArray(d.articles_24h) && d.articles_24h.length)
    ? d.articles_24h
    : ((typeof state !== 'undefined' && state.articles24h) || []);
  const rules = [...DEFAULT_HOTSPOTS, ...COMMENT_EVENT_RULES];
  const seen = new Set();
  const out = [];
  rules.forEach(rule => {
    if (seen.has(rule.title)) return;
    const kws = (rule.keywords && rule.keywords.length) ? rule.keywords : [rule.title];
    const matched = articles.filter(a => { const t = (a.title || ''); return kws.some(k => t.indexOf(k) >= 0); });
    if (!matched.length) return;  // 沒配對到新聞就不出卡
    seen.add(rule.title);
    let red = 0, yellow = 0, green = 0;
    matched.forEach(a => { const s = a.severity; if (s === 'red') red++; else if (s === 'yellow') yellow++; else green++; });
    const level = red > 0 ? 'red' : (yellow > 0 ? 'yellow' : 'green');
    out.push({
      title: rule.title, place: rule.place, lat: rule.lat, lng: rule.lng,
      level, city: '雲林', source: 'news', platform: '新聞',
      news_count: matched.length, comment_count: 0,
      negativity_pct: Math.round((red + yellow) / matched.length * 100),
      news_articles: matched.map(a => ({ title: a.title, url: a.url, severity: a.severity, time: a.time || a.hour })),
    });
  });
  return out;
}

function renderIncidentMap(d){
  const mapEl = document.getElementById('incidentMap');
  if (!mapEl || typeof window.L === 'undefined') return;

  let hotspots = (Array.isArray(d.hotspots) && d.hotspots.length) ? d.hotspots : buildZjgHotspots(d);
  {
    const suggestEl = document.getElementById('hotspotSuggestions');
    if (suggestEl) suggestEl.textContent = hotspots.length
      ? '雲林議題熱點（自動配對 24h 新聞）'
      : '24h 內未配對到雲林議題新聞。';
  }

  if (hotspots.length && Array.isArray(d.hotspots) && d.hotspots.length) {
    const suggestEl = document.getElementById('hotspotSuggestions');
    if (suggestEl) suggestEl.textContent = '目前採用 data.json 既有 hotspots 設定（手動/外部來源）。';
  }

  if (!incidentMap) {
    incidentMap = L.map('incidentMap', { scrollWheelZoom: false }).setView([23.71, 120.45], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap'
    }).addTo(incidentMap);
  }

  if (incidentMap._markerLayer) incidentMap.removeLayer(incidentMap._markerLayer);
  const layer = L.featureGroup();
  const markersByTitle = {};

  // 同座標熱點會疊在一起（雲林政治新聞多半只寫「雲林」→ 全擠到斗六預設點）。
  //   (1) 依燈號排序、紅燈最後畫＝疊最上層、永不被黃/綠蓋掉
  //   (2) 同座標 >1 個時做扇形散開、每顆各自看得到、各自可點
  const _SEV_DRAW = { green: 0, yellow: 1, red: 2 };
  const _coordKey = h => `${(+h.lat).toFixed(4)},${(+h.lng).toFixed(4)}`;
  const drawList = hotspots
    .filter(h => h.lat != null && h.lng != null)
    .slice()
    .sort((a, b) => (_SEV_DRAW[a.level] ?? 2) - (_SEV_DRAW[b.level] ?? 2));
  const _coordCount = {};
  drawList.forEach(h => { const k = _coordKey(h); _coordCount[k] = (_coordCount[k] || 0) + 1; });
  const _coordSeen = {};

  drawList.forEach(h => {
    const level = h.level || 'red';
    const color = level === 'red' ? '#c43344' : level === 'yellow' ? '#f7c948' : '#1f8a4c';
    // 扇形散開：同座標多顆時、平均分佈在 ~2.4km 半徑的圓周上（lng 除以 cos(lat) 修正成圓形）
    let lat = +h.lat, lng = +h.lng;
    const k = _coordKey(h), n = _coordCount[k];
    if (n > 1) {
      const idx = (_coordSeen[k] = (_coordSeen[k] || 0) + 1) - 1;
      const R = 0.022, ang = -Math.PI / 2 + (2 * Math.PI * idx) / n;
      lat += R * Math.cos(ang);
      lng += R * Math.sin(ang) / Math.cos((+h.lat) * Math.PI / 180);
    }
    const marker = L.circleMarker([lat, lng], {
      radius: level === 'red' ? 11 : 9,   // 紅燈略大、更顯眼
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.65
    });
    const lifetime = formatLifetimeHint(h);
    marker.bindPopup(`
      <div class="map-popup">
        <strong>${escapeHtml(h.title || '事件')}</strong><br/>
        地點：${escapeHtml(h.place || '-') }<br/>
        等級：${escapeHtml(level.toUpperCase())}<br/>
        來源：${escapeHtml(h.source || '-') }<br/>
        平台：${escapeHtml(h.platform || '-') }<br/>
        備註：${escapeHtml(h.note || '-') }
        ${lifetime ? `<br/><span class="lifetime-hint">⏳ ${escapeHtml(lifetime)}</span>` : ''}
      </div>
    `);
    if (h.title) markersByTitle[h.title] = marker;
    layer.addLayer(marker);
  });

  layer.addTo(incidentMap);
  incidentMap._markerLayer = layer;

  const bounds = layer.getBounds();
  if (bounds.isValid()) incidentMap.fitBounds(bounds.pad(0.25));

  renderHotspotCards(hotspots, markersByTitle);
}

function renderHotspotCards(hotspots, markersByTitle){
  const container = document.getElementById('hotspotList');
  const summary = document.getElementById('hotspotSummary');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(hotspots) ? hotspots : [];

  // 摘要列：🔴 X / 🟡 Y / 🟢 Z + 🚨 緊急 N
  if (summary){
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    list.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });
    const urgentPart = urgent > 0 ? `　🚨 緊急 ${urgent} 件` : '';
    summary.textContent = `🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}${urgentPart}`;
  }

  if (!list.length){
    container.innerHTML = '<p class="hint">目前沒有偵測到熱點事件。</p>';
    return;
  }

  // 依城市分組
  // 顯示順序：張嘉郡主場（雲林）首位 → 6 都 → 3 省轄市 → 13 縣 → 其他
  const CITY_ORDER = [
    '雲林',
    '台北', '新北', '桃園', '台中', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
    '其他',
  ];
  const groups = {};
  list.forEach(h => {
    const city = h.city || '其他';
    (groups[city] = groups[city] || []).push(h);
  });

  // 每城市內排序：緊急 > 級別（紅黃綠）> urgency_score 降冪
  const levelOrder = { red: 0, yellow: 1, green: 2 };
  const sortInCity = arr => arr.sort((a, b) => {
    if (!!a.is_urgent !== !!b.is_urgent) return a.is_urgent ? -1 : 1;
    const av = levelOrder[a.level] ?? 9;
    const bv = levelOrder[b.level] ?? 9;
    if (av !== bv) return av - bv;
    return (b.urgency_score || 0) - (a.urgency_score || 0);
  });

  const renderCity = (city) => {
    const arr = groups[city];
    if (!arr || !arr.length) return;
    sortInCity(arr);

    const section = document.createElement('div');
    section.className = 'hotspot-city-section';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'hotspot-city-header';
    header.setAttribute('aria-expanded', 'true');
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    arr.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });
    header.innerHTML = `
      <span class="city-arrow">▾</span>
      <h4>${escapeHtml(city)}</h4>
      <span class="city-counts">
        ${urgent ? `<span class="city-urgent">🚨 ${urgent} 件待處理</span>　` : ''}
        🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}
      </span>
    `;
    header.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
    });
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'hotspot-list';

    arr.forEach(h => {
      const level = h.level || 'green';
      const isPlaceholder = !!h.is_placeholder;
      const card = document.createElement('div');
      card.className = `hotspot-card level-${level}${h.is_urgent ? ' urgent' : ''}${isPlaceholder ? ' placeholder' : ''}`;
      card.dataset.title = h.title || '';
      const total = (h.news_count || 0) + (h.comment_count || 0);
      const lifetime = formatLifetimeHint(h);
      const sourceTag = (h.news_count || 0) > 0 && (h.comment_count || 0) > 0 ? '混合'
                      : (h.news_count || 0) > 0 ? '新聞主導'
                      : '留言主導';
      const negPart = (h.news_count || 0) > 0
        ? `<span class="hc-negativity ${h.negativity_pct >= 50 ? 'high' : h.negativity_pct >= 25 ? 'mid' : 'low'}">${h.negativity_pct || 0}% 負面</span>`
        : '';
      const urgentBadge = h.is_urgent ? '<span class="hc-urgent-badge">🚨 緊急</span>' : '';
      if (isPlaceholder) {
        card.innerHTML = `
          <div class="hc-row1">
            <span class="hc-level-chip green">QUIET</span>
            <span class="hc-title">${escapeHtml(h.title || '暫無動態')}</span>
          </div>
          <div class="hc-row2 hc-placeholder-msg">📭 24h 內未抓到該縣市相關新聞或留言</div>
          <div class="hc-place">📍 ${escapeHtml(h.place || '-')}</div>
        `;
      } else {
        card.innerHTML = `
          <div class="hc-row1">
            <span class="hc-level-chip ${level}">${level.toUpperCase()}</span>
            <span class="hc-title">${escapeHtml(h.title || '事件')}</span>
            ${urgentBadge}
          </div>
          <div class="hc-row2">
            <span class="hc-count">${total} 則</span>
            ${negPart}
            <span class="hc-source-tag">${sourceTag}</span>
          </div>
          <div class="hc-place">📍 ${escapeHtml(h.place || '-')}</div>
          <div class="hc-platform">${escapeHtml(h.platform || '')}</div>
          ${lifetime ? `<div class="hc-lifetime">⏳ ${escapeHtml(lifetime)}</div>` : ''}
        `;
      }
      card.addEventListener('click', () => {
        if (isPlaceholder) return;  // 占位卡不打開 modal
        openHotspotDetailModal(h, markersByTitle);
      });
      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);
  };

  CITY_ORDER.forEach(renderCity);
  // 任何沒在 CITY_ORDER 列出的城市
  Object.keys(groups).forEach(city => {
    if (!CITY_ORDER.includes(city)) renderCity(city);
  });
}

// --------- Past events history ---------
const PAST_EVENTS_DEFAULT_LIMIT = 14;  // 預設顯示近 14 天
let _pastEventsAll = [];               // cached全部 days，分頁時用
let _pastEventsShown = 0;

async function renderPastEvents(){
  const wrap = document.getElementById('pastEventsWrap');
  const list = document.getElementById('pastEventsList');
  const meta = document.getElementById('pastEventsMeta');
  if (!wrap || !list) return;

  const hist = _hotspotHistoryCache || (_hotspotHistoryCache = await fetchJSON('./hotspot_history.json'));
  if (!hist || !Array.isArray(hist.days) || hist.days.length === 0){
    if (meta) meta.textContent = '（暫無歷史資料）';
    list.innerHTML = '';
    return;
  }

  // 倒序：最新日期在最上
  _pastEventsAll = [...hist.days].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  _pastEventsShown = 0;
  if (meta) meta.textContent = `（共 ${_pastEventsAll.length} 天紀錄，預設顯示近 ${PAST_EVENTS_DEFAULT_LIMIT} 天）`;

  list.innerHTML = '';
  appendPastEventsBatch(PAST_EVENTS_DEFAULT_LIMIT);
}

function appendPastEventsBatch(count){
  const list = document.getElementById('pastEventsList');
  if (!list) return;

  // 如果之前有「載入更多」按鈕，先移除
  list.querySelectorAll('.past-load-more').forEach(b => b.remove());

  const end = Math.min(_pastEventsShown + count, _pastEventsAll.length);
  const PAST_CITY_ORDER = [
    '雲林',
    '台北', '新北', '桃園', '台中', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
    '其他',
  ];

  // 「今日」用台北時區判斷（後端 d.date 也是台北日期），避免 UTC vs +8 跨日誤標
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

  for (let i = _pastEventsShown; i < end; i++){
    const d = _pastEventsAll[i];
    const dayWrap = document.createElement('div');
    dayWrap.className = 'past-day';

    const hs = d.hotspots || [];
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    hs.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });

    const isToday = d.date === todayStr;
    const dateLabel = isToday ? `${d.date}（今日）` : d.date;
    const dayHeader = document.createElement('button');
    dayHeader.type = 'button';
    dayHeader.className = 'past-day-header';
    dayHeader.setAttribute('aria-expanded', 'true');
    dayHeader.innerHTML = `
      <span class="past-day-arrow">▾</span>
      <span class="past-day-date">${escapeHtml(dateLabel)}</span>
      <span class="past-day-counts">
        ${urgent ? `<span class="past-urgent">🚨 ${urgent}</span>　` : ''}
        🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}
      </span>
    `;
    dayHeader.addEventListener('click', () => {
      const collapsed = dayWrap.classList.toggle('collapsed');
      dayHeader.setAttribute('aria-expanded', String(!collapsed));
    });
    dayWrap.appendChild(dayHeader);

    // 依城市分組
    const byCity = {};
    hs.forEach(h => {
      const city = h.city || '其他';
      (byCity[city] = byCity[city] || []).push(h);
    });

    const renderPastCity = (city) => {
      const arr = byCity[city];
      if (!arr || !arr.length) return;
      const cityCnts = { red: 0, yellow: 0, green: 0 };
      let cityUrg = 0;
      arr.forEach(h => {
        if (cityCnts[h.level] != null) cityCnts[h.level] += 1;
        if (h.is_urgent) cityUrg += 1;
      });

      const citySec = document.createElement('div');
      citySec.className = 'past-city-section';
      // 預設展開；點 header 可收合
      const headerBtn = document.createElement('button');
      headerBtn.type = 'button';
      headerBtn.className = 'past-city-header';
      headerBtn.setAttribute('aria-expanded', 'true');
      headerBtn.innerHTML = `
        <span class="past-city-arrow">▾</span>
        <span class="past-city-name">${escapeHtml(city)}</span>
        <span class="past-city-counts">
          ${cityUrg ? `<span class="past-urgent">🚨 ${cityUrg}</span>　` : ''}
          🔴 ${cityCnts.red}　🟡 ${cityCnts.yellow}　🟢 ${cityCnts.green}
        </span>
      `;
      citySec.appendChild(headerBtn);

      const ul = document.createElement('ul');
      ul.className = 'past-day-events';
      [...arr].sort((a, b) => (b.urgency_score || 0) - (a.urgency_score || 0)).forEach(h => {
        const li = document.createElement('li');
        li.className = 'past-event-item';
        const level = h.level || 'green';
        const total = (h.news_count || 0) + (h.comment_count || 0);
        const urgentMark = h.is_urgent ? '🚨 ' : '';
        const sample = (h.sample_titles || [])
          .filter(t => t)
          .slice(0, 2)
          .map(t => `<div class="past-sample">・${escapeHtml(t)}</div>`)
          .join('');
        li.innerHTML = `
          <div class="past-event-row">
            <span class="hc-level-chip ${level}">${level.toUpperCase()}</span>
            <span class="past-event-title">${urgentMark}${escapeHtml(h.title || '事件')}</span>
            <span class="past-event-count">${total} 則${h.negativity_pct ? ` · ${h.negativity_pct}% 負面` : ''}</span>
          </div>
          ${sample}
        `;
        li.addEventListener('click', () => openPastEventModal(h, d.date));
        ul.appendChild(li);
      });
      citySec.appendChild(ul);

      // toggle：點 header 收合/展開
      headerBtn.addEventListener('click', () => {
        const collapsed = citySec.classList.toggle('collapsed');
        headerBtn.setAttribute('aria-expanded', String(!collapsed));
      });

      dayWrap.appendChild(citySec);
    };

    PAST_CITY_ORDER.forEach(renderPastCity);
    Object.keys(byCity).forEach(city => {
      if (!PAST_CITY_ORDER.includes(city)) renderPastCity(city);
    });

    list.appendChild(dayWrap);
  }
  _pastEventsShown = end;

  // 還有更多 → 加「載入更多」按鈕
  if (_pastEventsShown < _pastEventsAll.length){
    const remaining = _pastEventsAll.length - _pastEventsShown;
    const btn = document.createElement('button');
    btn.className = 'past-load-more';
    btn.type = 'button';
    btn.textContent = `▾ 顯示更多（還有 ${remaining} 天）`;
    btn.addEventListener('click', () => appendPastEventsBatch(30));
    list.appendChild(btn);
  }
}

// 每天 archive 的記憶體 cache（避免重複 fetch 同一天）
const _pastArchiveCache = {};

// 把任意 articles 陣列開到既有 hotspot detail modal
// 純清單用途（卡片/圖表 click），沒 level/place/壽命概念，meta 只顯示 note
// loadMoreCtx (optional 5th arg):
//   {
//     newsFetchFn: (newLimit) => Promise<articles[]>   // 給 modal 內新聞區的「載入更多」按鈕用
//     cmtFetchFn:  (newLimit) => Promise<comments[]>   // 給 modal 內留言區的「載入更多」按鈕用
//     newsBatch:   50  (default)
//     cmtBatch:    100 (default)
//   }
// totalCountOverride (optional 6th arg):
//   number — 用真實 total (而非 articles.length + comments.length) 渲染 modal title
//             給 chart click 場景用：實際資料量可能 100+ 但 modal 只 fetch 了 20、
//             title 顯示「20 則」會誤導
function openArticlesModal(title, note, articles, commentsList, loadMoreCtx, totalCountOverride){
  const news = (articles || []).map(a => ({
    title: a.title || '（無標題）',
    url: a.url || '',
    time: a.time || '',
    publisher: a.publisher || '',
    is_negative: !!a.is_negative,
    severity: a.severity || (a.is_negative ? 'yellow' : null),  // 沒 severity 的舊資料退回二級
  }));
  // commentsList 為可選 — 燈號 panel 點擊時會帶（綜合燈號要顯示留言）
  const comments = (commentsList || []).map(c => ({
    author: c.author || c.username || '',
    text: c.text || '',
    time_text: c.time_text || c.time || '',
    url: c.url || '',
    signal: c.signal || 'green',
    platform: c.platform || '',
  }));
  openHotspotDetailModal({
    title: title,
    note: note,
    news_count: news.length,
    comment_count: comments.length,
    news_articles: news,
    comments: comments,
    loadMoreCtx: loadMoreCtx,
    total_count_override: (typeof totalCountOverride === 'number') ? totalCountOverride : null,
  }, null);
}

// 在卡片上 bind click：開 modal 顯示資料
// 卡片點擊綁定。重要：每次 run()（mode 切換）都會 re-call bindCardClick；
// 早期版本用 dataset.clickBound 避免重綁、結果讓 title/note/articles 卡在第一次 bind 時的值（24h），
// 改成把最新 config 存在 _cardBindings，handler 只綁一次但每次點擊讀最新 config。
const _cardBindings = {};
function bindCardClick(elemId, title, note, getArticlesFn){
  const num = document.getElementById(elemId);
  if (!num) return;
  const card = num.closest('.card');
  if (!card) return;
  _cardBindings[elemId] = { title, note, getArticlesFn };
  if (card.dataset.clickBound === '1') return;
  card.dataset.clickBound = '1';
  card.classList.add('card-clickable');
  card.addEventListener('click', () => {
    const cfg = _cardBindings[elemId];
    if (!cfg) return;
    const articles = cfg.getArticlesFn() || [];
    openArticlesModal(cfg.title, cfg.note, articles);
  });
}

async function openPastEventModal(h, dateStr){
  // Lazy-load 該日完整 archive；不存在就 fallback 到 entry 內嵌的舊格式資料
  let archiveEvents = _pastArchiveCache[dateStr];
  if (archiveEvents === undefined){
    const archive = await fetchJSON(`./hotspot_archive/${dateStr}.json`);
    archiveEvents = (archive && Array.isArray(archive.hotspots)) ? archive.hotspots : null;
    _pastArchiveCache[dateStr] = archiveEvents;
  }
  let news = [];
  let comments = [];
  // 給 modal 的 count：優先用 archive 真實值（backfill 後可能比 index 大）
  let newsCount = h.news_count || 0;
  let commentCount = h.comment_count || 0;
  if (archiveEvents){
    const found = archiveEvents.find(x => x.title === h.title);
    if (found){
      news = found.news_articles || [];
      comments = found.comments || [];
      // 用 archive 的實際數
      if (typeof found.news_count === 'number') newsCount = found.news_count;
      if (typeof found.comment_count === 'number') commentCount = found.comment_count;
    }
  } else {
    // 沒 archive 檔 → 用舊版 index 自帶的資料
    // 舊格式 1（split 之前）：news_articles_top + comments_top
    // 舊格式 2（更早）：sample_titles（只剩標題沒 url）
    if (Array.isArray(h.news_articles_top) && h.news_articles_top.length){
      news = h.news_articles_top;
    } else if (Array.isArray(h.sample_titles) && h.sample_titles.length){
      news = h.sample_titles.map(t => ({ title: t, url: '', time: '' }));
    }
    if (Array.isArray(h.comments_top) && h.comments_top.length){
      comments = h.comments_top;
    }
  }

  const fakeHotspot = {
    title: `[${dateStr}] ${h.title || '事件'}`,
    place: h.place,
    level: h.level,
    source: (news.length ? 'news' : '') + (comments.length ? ((news.length ? ' + ' : '') + 'comment') : ''),
    platform: '',
    note: `${dateStr} 命中 ${newsCount + commentCount} 則（新聞 ${newsCount}、留言 ${commentCount}）`,
    news_count: newsCount,
    comment_count: commentCount,
    news_articles: news,
    comments: comments,
    news_full_expires_at: null,  // 歷史不算壽命
  };
  openHotspotDetailModal(fakeHotspot, null);
}

// --------- Media framing matrix (city × candidate) ---------
function renderMediaFraming(d){
  const wrap = document.getElementById('mediaFramingMatrix');
  const meta = document.getElementById('mediaFramingMeta');
  if (!wrap) return;
  wrap.innerHTML = '';

  const data = d.media_framing_7d;
  if (!data || !Array.isArray(data.cells) || data.cells.length === 0){
    wrap.innerHTML = '<p class="hint">7 日內樣本不足，無法顯示矩陣。</p>';
    if (meta) meta.textContent = '';
    return;
  }

  const CANDIDATES = ['張嘉郡', '劉建國'];
  const CITY_ORDER = [
    '台中', '台北', '新北', '桃園', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '雲林', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
  ];

  // Build lookup: cells[(city,cand)] = cell
  const lookup = {};
  data.cells.forEach(c => { lookup[`${c.city}|${c.candidate}`] = c; });

  // Only show cities that have at least one cell
  const citiesWithData = CITY_ORDER.filter(city =>
    CANDIDATES.some(cand => lookup[`${city}|${cand}`])
  );

  // Build table
  const table = document.createElement('table');
  table.className = 'mf-table';
  // Header
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(Object.assign(document.createElement('th'), { textContent: '縣市', className: 'mf-col-city' }));
  CANDIDATES.forEach(cand => {
    const th = document.createElement('th');
    th.textContent = cand;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  citiesWithData.forEach(city => {
    const tr = document.createElement('tr');
    const cityTd = document.createElement('td');
    cityTd.className = 'mf-cell-city';
    cityTd.textContent = city;
    tr.appendChild(cityTd);
    CANDIDATES.forEach(cand => {
      const td = document.createElement('td');
      td.className = 'mf-cell';
      const cell = lookup[`${city}|${cand}`];
      if (!cell){
        td.classList.add('mf-empty');
        td.textContent = '—';
      } else {
        const pct = cell.negativity_pct;
        const tone = pct <= 20 ? 'pos' : pct <= 40 ? 'mid' : pct <= 70 ? 'neg' : 'verybad';
        td.classList.add(`mf-tone-${tone}`);
        td.classList.add('mf-clickable');
        td.innerHTML = `
          <div class="mf-num">${cell.news_count} 篇</div>
          <div class="mf-pct">負面 ${pct}%</div>
        `;
        td.title = `點擊查看 ${city} × ${cand} 相關新聞清單（news_count=${cell.news_count}, negative=${cell.negative_count}, sentiment=${cell.sentiment_score}）`;
        td.addEventListener('click', () => {
          const articles = Array.isArray(cell.articles) ? cell.articles : [];
          const note = `近 7 日全國新聞中，標題同時提到「${city}」與「${cand}」的命中：${cell.news_count} 篇（負面 ${pct}%）`;
          openArticlesModal(`${city} × ${cand} · 媒體 framing 樣本`, note, articles);
        });
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (meta){
    meta.textContent = `樣本：7 日全國新聞共 ${data.sample_size} 篇 ｜ 顯示門檻：≥ ${data.min_sample} 篇 ｜ 共 ${data.cells.length} 個有效格。`;
  }
}

// --------- Election village chloropleth map ---------
let electionMap;
let electionMapLayer;
const _emGeoCache = {};   // code → GeoJSON
const STRATEGY_COLORS = {
  'A_LOCKED':            '#1d3a72',  // 深藍：鎖定區
  'B_PURE_SWING':        '#ff7b1f',  // 橙：純搖擺主戰場
  'C_FLIPPABLE':         '#f7c948',  // 黃：翻轉潛力
  'D_LOW_TURNOUT':       '#1f8a4c',  // 綠：低投票率動員
  'E_AGEING_SATURATED':  '#777777',  // 灰：飽和
};
const PERSISTENCE_MAP_COLORS = {
  '永藍': '#1d3a72', '永綠': '#1a5031', '永白': '#bbbbbb',
  '翻轉': '#f7c948', '搖擺': '#ff7b1f', '其他': '#444444',
};
// 總統得票/預測的政黨色 — 只用在 presidential_2024 / presidential_predict 兩個模式，
// 比 PERSISTENCE_MAP_COLORS 亮，方便在地圖上一眼辨認。
const PARTY_MAP_COLORS = {
  KMT: '#5a79ff',  // 亮藍（Tailwind blue-500）
  DPP: '#1f8a4c',  // 亮綠（green-500）
  TPP: '#c0d0dd',  // 亮白（neutral-200，深底也看得見）
  PFP: '#f97316',  // 橘（親民黨）
};
function presidentialColorByYear(v, year){
  const r = (v.presidential_history || []).find(x => x.year === year);
  if (!r) return '#444';
  return PARTY_MAP_COLORS[r.winner] || '#444';
}
function presidentialColorByPrediction(v){
  const pred = v.presidential_prediction;
  if (!pred) return '#444';
  return PARTY_MAP_COLORS[pred.predicted_winner] || '#444';
}
function presidentialColorByPredictionPolls(v){
  const pred = v.presidential_prediction_polls;
  if (!pred) return '#444';
  return PARTY_MAP_COLORS[pred.predicted_winner] || '#444';
}
function mayorColorByPrediction(v){
  // 雲林縣長基本面預測（gen_yunlin_mayor_forecast.py 寫的 local_prediction）
  const pred = v.local_prediction;
  if (!pred) return '#444';
  return PARTY_MAP_COLORS[pred.predicted_winner] || '#444';
}
function priorityToColor(p){
  // 0-100 → 淡藍 → 黃 → 紅
  const x = Math.max(0, Math.min(100, p)) / 100;
  if (x < 0.5){
    // 淡藍 → 黃
    const t = x * 2;
    const r = Math.round(70 + (247-70)*t);
    const g = Math.round(115 + (201-115)*t);
    const b = Math.round(180 + (72-180)*t);
    return `rgb(${r},${g},${b})`;
  } else {
    // 黃 → 紅
    const t = (x - 0.5) * 2;
    const r = Math.round(247 + (255-247)*t);
    const g = Math.round(201 + (77-201)*t);
    const b = Math.round(72 + (79-72)*t);
    return `rgb(${r},${g},${b})`;
  }
}

// --------- Election forecast aggregate (6 都/縣市總票數預測) ---------
async function renderElectionForecast(){
  const container = document.getElementById('forecastBody');
  if (!container) return;
  let city;
  try {
    // 雲林縣長基本面（gen_yunlin_mayor_forecast.py 產的 mayor_forecast）。
    // 不再用全國 22 縣市總統 aggregate — 那是總統基本盤、對縣長選舉會誤導。
    city = await loadEpCity('yun');
  } catch (e) {
    container.innerHTML = '<p class="hint">資料載入失敗。</p>';
    return;
  }
  const mf = city && city.mayor_forecast;
  const pred = mf && mf.predicted;
  if (!mf || !pred){
    container.innerHTML = '<p class="hint">尚未產生雲林縣長預測（請跑 scripts/gen_yunlin_mayor_forecast.py）。</p>';
    return;
  }

  const fmt = (n) => (n != null ? Number(n).toLocaleString() : '—');
  const partyClass = (p) => p === 'KMT' ? 'persist-blue' : p === 'DPP' ? 'persist-green'
                          : p === 'TPP' ? 'persist-white' : 'persist-other';
  const confLabel = { high: '高（差距 ≥15pt）', medium: '中（差距 5–15pt）',
                      low: '低（差距 <5pt 膠著）' }[pred.confidence] || pred.confidence;
  const stackBar = (kmt, dpp, tpp) => `
    <div class="forecast-stack-bar">
      <div class="forecast-seg" style="width:${kmt}%;background:#3b82f6"  title="KMT ${kmt.toFixed(1)}%">${kmt >= 8 ? 'KMT ' + kmt.toFixed(1) + '%' : ''}</div>
      <div class="forecast-seg" style="width:${dpp}%;background:#22c55e"  title="DPP ${dpp.toFixed(1)}%">${dpp >= 8 ? 'DPP ' + dpp.toFixed(1) + '%' : ''}</div>
      <div class="forecast-seg" style="width:${tpp}%;background:#e5e7eb;color:#888" title="TPP ${tpp.toFixed(1)}%">${tpp >= 8 ? 'TPP ' + tpp.toFixed(1) + '%' : ''}</div>
    </div>`;
  const arrow = (d) => d > 0.1 ? '▲' : d < -0.1 ? '▼' : '＝';
  const fmtDelta = (d) => (d > 0 ? '+' : '') + d.toFixed(1) + 'pt';

  const est = pred.est_votes || 0;
  const kmtVotes = Math.round(pred.kmt_pct / 100 * est);
  const dppVotes = Math.round(pred.dpp_pct / 100 * est);

  // vs 2022 縣長（張麗善連任那屆）
  const a22 = mf.actual_2022;
  let compareHtml = '';
  if (a22){
    const dK = pred.kmt_pct - a22.kmt_pct;
    const dD = pred.dpp_pct - a22.dpp_pct;
    compareHtml = `
      <div class="forecast-compare">
        <div class="forecast-compare-title">vs 2022 縣長實際得票（張麗善 KMT 連任那屆）</div>
        <div class="forecast-compare-row"><span class="forecast-compare-cell">KMT　${a22.kmt_pct.toFixed(1)}%　→　${pred.kmt_pct.toFixed(1)}%　<span class="forecast-delta ${dK>=0?'pos':'neg'}">${arrow(dK)} ${fmtDelta(dK)}</span></span></div>
        <div class="forecast-compare-row"><span class="forecast-compare-cell">DPP　${a22.dpp_pct.toFixed(1)}%　→　${pred.dpp_pct.toFixed(1)}%　<span class="forecast-delta ${dD>=0?'pos':'neg'}">${arrow(dD)} ${fmtDelta(dD)}</span></span></div>
      </div>`;
  }

  const totalCard = `
    <div class="forecast-six-card">
      <div class="forecast-headline">
        <span class="forecast-label">雲林縣長 基本面預測勝者</span>
        <span class="ep-persist-pill ${partyClass(pred.predicted_winner)}" style="font-size:15px">${pred.predicted_winner}</span>
        <span class="hint">　領先 ${pred.predicted_margin.toFixed(1)} 個百分點　信心 ${confLabel}　涵蓋 ${pred.sample_villages} 里</span>
      </div>
      ${stackBar(pred.kmt_pct, pred.dpp_pct, pred.tpp_pct)}
      <div class="forecast-vote-grid">
        <div><span class="forecast-vote-label">KMT</span><span class="forecast-vote-num">${fmt(kmtVotes)} 票</span></div>
        <div><span class="forecast-vote-label">DPP</span><span class="forecast-vote-num">${fmt(dppVotes)} 票</span></div>
        <div><span class="forecast-vote-label">推估投票數</span><span class="forecast-vote-num">${fmt(est)} 票</span></div>
      </div>
      ${compareHtml}
    </div>`;

  const townRows = (mf.by_town || []).map(t => {
    const confL = { high: '高', medium: '中', low: '低' }[t.confidence] || t.confidence;
    return `
      <div class="forecast-city-row">
        <div class="forecast-city-name">${escapeHtml(t.town)}</div>
        <div class="forecast-city-bar">${stackBar(t.kmt_pct, t.dpp_pct, t.tpp_pct)}</div>
        <div class="forecast-city-meta">
          <span class="ep-persist-pill ${partyClass(t.predicted_winner)}">${t.predicted_winner}</span>
          <span class="hint">領先 ${t.predicted_margin.toFixed(1)}pt　信心 ${confL}</span>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    ${totalCard}
    <h3 style="margin-top:18px;color:#d8e2ff;font-size:14px">各鄉鎮市預測明細（${(mf.by_town || []).length} 鄉鎮市，得票多→少）</h3>
    <div class="forecast-city-list">${townRows}</div>
    <p class="hint" style="margin-top:12px">
      <strong>模型方法</strong>：${escapeHtml(mf.method || '')}<br>
      <strong>資料來源</strong>：${escapeHtml(mf.source || '')}<br>
      <strong>模型局限</strong>：${escapeHtml(mf.limitations || '')}<br>
      <em>基本面 = 過去 5 屆縣長基本盤的延伸，不是 2026 候選人民調。當參考、不要當真值用。</em>
    </p>
  `;
}

async function renderElectionMap(){
  const container = document.getElementById('electionMap');
  if (!container || typeof window.L === 'undefined') return;

  const citySelect = document.getElementById('emCitySelect');
  const modeSelect = document.getElementById('emModeSelect');
  const status = document.getElementById('emStatus');
  const legendEl = document.getElementById('emLegend');

  const TW_CENTERS = {
    tpe: [25.05, 121.55], ntpc: [24.99, 121.55], tyc: [24.99, 121.30],
    txg: [24.16, 120.65], tnn: [22.99, 120.21], khh: [22.62, 120.31],
    kee: [25.13, 121.74], hsz: [24.81, 120.97], cyi: [23.48, 120.45],
    hsq: [24.70, 121.10], mil: [24.49, 120.92], cha: [24.05, 120.51],
    nan: [23.91, 120.96], yun: [23.71, 120.43], cyq: [23.45, 120.35],
    pif: [22.55, 120.62], ila: [24.70, 121.74], hua: [23.83, 121.40],
    ttt: [22.81, 121.10], peh: [23.57, 119.58],
    kin: [24.43, 118.31], lja: [26.16, 119.95],
  };
  const SIX_CITIES = new Set(['tpe', 'ntpc', 'tyc', 'txg', 'tnn', 'khh']);

  if (!electionMap){
    electionMap = L.map('electionMap', { scrollWheelZoom: false }).setView([23.7, 121], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(electionMap);
  }

  const renderLayer = async () => {
    const code = (citySelect && citySelect.value) || 'yun';   // 鎖定雲林
    const mode = modeSelect.value;

    if (status) status.textContent = '載入中…';

    let activeMode = mode;

    // Lazy fetch geo + city data
    if (!_emGeoCache[code]){
      const geo = await fetchJSON(`./election_priority/geo/${code}.geo.json`);
      _emGeoCache[code] = geo;
    }
    // 22 縣市現在都有 election_priority/{code}.json（完整 priority/strategy/總統 預測都齊）
    const cityData = await loadEpCity(code);
    if (!cityData || !_emGeoCache[code]){
      if (status) status.textContent = '載入失敗。';
      return;
    }

    // Lookup by (town, village). GeoJSON 來源 plotdb/pdmaptw 已用 2010 升格後新名，
    // 直接和 priority 資料對齊。
    const lookup = {};
    cityData.villages.forEach(v => {
      lookup[`${v.town}|${v.village}`] = v;
    });
    const lookupVillage = (town, village) => lookup[`${town}|${village}`];

    if (electionMapLayer){
      electionMap.removeLayer(electionMapLayer);
    }

    const styleFn = (feat) => {
      const p = feat.properties || {};
      const v = lookupVillage(p.TOWNNAME, p.VILLAGENAM);
      let color = '#333';
      if (v){
        if (activeMode === 'priority') color = priorityToColor(v.priority);
        else if (activeMode === 'strategy') color = STRATEGY_COLORS[v.strategy_type] || '#444';
        else if (activeMode === 'persistence') color = PERSISTENCE_MAP_COLORS[v.persistence] || '#444';
        else if (activeMode === 'mayor_predict') color = mayorColorByPrediction(v);
        else if (activeMode === 'presidential_2024') color = presidentialColorByYear(v, 2024);
        else if (activeMode === 'presidential_predict') color = presidentialColorByPrediction(v);
        else if (activeMode === 'presidential_predict_polls') color = presidentialColorByPredictionPolls(v);
      }
      return {
        color: '#9fb0ea', weight: 0.4,
        fillColor: color, fillOpacity: v ? 0.75 : 0.25,
      };
    };

    electionMapLayer = L.geoJSON(_emGeoCache[code], {
      style: styleFn,
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const v = lookupVillage(p.TOWNNAME, p.VILLAGENAM);
        let tooltipHtml;
        if (!v){
          tooltipHtml = `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（無資料）`;
        } else if (activeMode === 'mayor_predict'){
          const pred = v.local_prediction;
          tooltipHtml = pred
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
               縣長基本面預測：<strong>${pred.predicted_winner}</strong>（領先 ${pred.predicted_margin}pt，信心 ${pred.confidence}）<br>
               KMT ${pred.kmt_pct}%　DPP ${pred.dpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（縣長預測資料缺）`;
        } else if (activeMode === 'presidential_2024'){
          const r = (v.presidential_history || []).find(x => x.year === 2024);
          tooltipHtml = r
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>2024 勝者：<strong>${r.winner}</strong><br>
               KMT ${r.kmt_pct}%　DPP ${r.dpp_pct}%　TPP ${r.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（總統選舉資料缺）`;
        } else if (activeMode === 'presidential_predict'){
          const pred = v.presidential_prediction;
          tooltipHtml = pred
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
               預測勝者：<strong>${pred.predicted_winner}</strong>（領先 ${pred.predicted_margin}pt，信心 ${pred.confidence}）<br>
               KMT ${pred.kmt_pct}%　DPP ${pred.dpp_pct}%　TPP ${pred.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（預測資料缺）`;
        } else if (activeMode === 'presidential_predict_polls'){
          const pred = v.presidential_prediction_polls;
          tooltipHtml = pred
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
               民調校正預測：<strong>${pred.predicted_winner}</strong>（領先 ${pred.predicted_margin}pt，信心 ${pred.confidence}）<br>
               KMT ${pred.kmt_pct}%　DPP ${pred.dpp_pct}%　TPP ${pred.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（民調校正預測缺）`;
        } else {
          tooltipHtml = `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
             priority: <strong>${v.priority}</strong><br>
             ${v.strategy_label}<br>
             ${v.persistence}　搖擺度 ${v.volatility}<br>
             人口 ${v.pop.toLocaleString()}　投票率 ${v.turnout != null ? v.turnout + '%' : '—'}`;
        }
        layer.bindTooltip(tooltipHtml, { sticky: true, direction: 'top' });
        layer.on('click', () => {
          if (!v) return;
          openVillageDetail({ ...v, city: code, cityName: cityData.name, source: cityData.source });
        });
        layer.on('mouseover', e => e.target.setStyle({ weight: 2, color: '#5a79ff' }));
        layer.on('mouseout',  e => e.target.setStyle({ weight: 0.4, color: '#9fb0ea' }));
      },
    }).addTo(electionMap);

    // Pan / zoom to city
    const bounds = electionMapLayer.getBounds();
    if (bounds.isValid()) electionMap.fitBounds(bounds, { padding: [10, 10] });

    // Render legend
    if (legendEl){
      let html = '';
      if (activeMode === 'priority'){
        html = `<div class="em-legend-title">Priority 分數（高 = 主戰場）</div>
          <div class="em-legend-gradient"></div>
          <div class="em-legend-scale"><span>0（鎖定）</span><span>50</span><span>100（必爭）</span></div>`;
      } else if (activeMode === 'strategy'){
        html = `<div class="em-legend-title">策略類型</div>
          ${Object.entries(STRATEGY_COLORS).map(([k, c]) => {
            const labels = {A_LOCKED:'A 永○鎖定區', B_PURE_SWING:'B 純搖擺主戰場',
                            C_FLIPPABLE:'C 翻轉潛力', D_LOW_TURNOUT:'D 低投票率動員',
                            E_AGEING_SATURATED:'E 高齡飽和'};
            return `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${labels[k]}</span>`;
          }).join('')}`;
      } else if (activeMode === 'mayor_predict'){
        html = `<div class="em-legend-title">下屆縣長基本面預測（勝者）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}
          <div class="hint" style="margin-top:6px;font-size:11px">模型：加權近 5 屆<strong>縣長</strong>得票（最近 0.55 / 上屆 0.30）+ momentum ×0.3。反映張家／KMT 現任基本盤、非候選人民調。</div>`;
      } else if (activeMode === 'presidential_2024'){
        html = `<div class="em-legend-title">2024 總統得票（實際勝者）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}`;
      } else if (activeMode === 'presidential_predict'){
        html = `<div class="em-legend-title">下屆總統預測勝者（純基本面）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}
          <div class="hint" style="margin-top:6px;font-size:11px">模型：加權近 5 屆得票（最近權重 0.55、上一屆 0.30）+ momentum 趨勢延伸 ×0.3。沒考慮民調與全國風向，只看歷史基本盤。</div>`;
      } else if (activeMode === 'presidential_predict_polls'){
        html = `<div class="em-legend-title">下屆總統預測勝者（民調校正後）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}
          <div class="hint" style="margin-top:6px;font-size:11px">純基本面預測 + 全國 uniform swing（每個里都加上「民調 - 2024 實際」的差）。民調來源 / 數字編輯 dashboard/polls_config.json。</div>`;
      } else {
        html = `<div class="em-legend-title">政治屬性</div>
          ${Object.entries(PERSISTENCE_MAP_COLORS).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}`;
      }
      // 16 縣市用「縣市長」作為 priority 基礎，6 都用「直轄市長」
      if (cityData.source === 'local_mayor'){
        html += `<div class="hint" style="margin-top:6px;font-size:11px;color:#9fb0ea">ℹ️ 此縣市的 priority/策略/政治屬性 是基於 5 屆縣市長選舉（2005-2022）計算。獨立候選人（IND）在花蓮/臺東/金門等地常獲勝，會反映在 winner 與 volatility 上。</div>`;
      } else if (cityData.source === 'presidential'){
        html += `<div class="hint" style="margin-top:6px;font-size:11px;color:#9fb0ea">ℹ️ 此縣市的 priority/策略/政治屬性 是基於 5 屆總統選舉（2008-2024）計算（fallback 來源）。</div>`;
      }
      legendEl.innerHTML = html;
    }

    if (status) status.textContent = `${cityData.name} ${cityData.village_count} 里 · 顏色：${modeSelect.options[modeSelect.selectedIndex].text}`;
  };

  citySelect?.addEventListener('change', renderLayer);
  modeSelect?.addEventListener('change', renderLayer);
  await renderLayer();
}

// --------- Election priority map (黃金戰場版圖) ---------
const _epIndexCache = { data: null };
const _epCityCache = {};  // code → full city data
const PERSISTENCE_COLORS = {
  '永藍': 'persist-blue',
  '永綠': 'persist-green',
  '永白': 'persist-white',
  '翻轉': 'persist-flip',
  '搖擺': 'persist-swing',
  '其他': 'persist-other',
};
// 動作（行動類別）對應的友善 label。第一個欄位是色塊文字，title 提供 hover 補充。
const ACTION_LABELS = {
  GOTV:       { short: 'GOTV · 催票',     full: 'GOTV（Get Out The Vote）｜把已支持的選民帶到投票所。手段：簡訊提醒、人工電話、志工挨家催票、長者接送。' },
  persuasion: { short: 'persuasion · 說服', full: 'persuasion｜針對中間/未表態選民改變投票意向。手段：客製化議題傳單、家戶深度對談、KOL 背書、政策廣告。' },
  mixed:      { short: 'mixed · 雙軌',     full: 'mixed｜對基本盤打 GOTV、對搖擺者打 persuasion，兩線並進。' },
  maintain:   { short: 'maintain · 維護',  full: 'maintain｜不投放新資源，靠樁腳/節慶/宗親會維繫關係，不犯錯比拉票更重要。' },
  skip:       { short: 'skip · 略過',      full: 'skip｜資源效益太低，不主動投放。' },
};
function actionLabel(action){
  return ACTION_LABELS[action] || { short: action || '—', full: '' };
}

async function loadEpIndex(){
  if (_epIndexCache.data) return _epIndexCache.data;
  const d = await fetchJSON('./election_priority.json');
  _epIndexCache.data = d;
  return d;
}

async function loadEpCity(code){
  if (_epCityCache[code]) return _epCityCache[code];
  const d = await fetchJSON(`./election_priority/${code}.json`);
  if (d) _epCityCache[code] = d;
  return d;
}


async function renderElectionPriority(){
  const wrap = document.getElementById('epTableWrap');
  const stats = document.getElementById('epCityStats');
  const status = document.getElementById('epStatus');
  if (!wrap) return;

  const idx = await loadEpIndex();
  if (!idx){
    wrap.innerHTML = '<p class="hint">尚未產生選舉版圖資料。</p>';
    return;
  }

  const citySelect = document.getElementById('epCitySelect');
  const limitSelect = document.getElementById('epLimitSelect');

  const renderTable = async () => {
    const cityCode = (citySelect && citySelect.value) || 'yun';   // 鎖定雲林
    const limit = parseInt(limitSelect.value, 10) || 100;
    if (status) status.textContent = '載入中…';

    let villages = [];
    if (cityCode === 'all'){
      // Top N across all cities — 從 index 拿 top_villages 合併
      idx.cities.forEach(c => {
        c.top_villages.forEach(v => villages.push({ ...v, city: c.code, cityName: c.name }));
      });
      villages.sort((a, b) => b.priority - a.priority);
    } else {
      const cityData = await loadEpCity(cityCode);
      if (!cityData){
        wrap.innerHTML = '<p class="hint">找不到該縣市資料。</p>';
        return;
      }
      villages = cityData.villages.map(v => ({ ...v, city: cityCode, cityName: cityData.name }));
    }
    const display = villages.slice(0, limit);

    if (status) status.textContent = `顯示前 ${display.length} 名（總共 ${cityCode === 'all' ? idx.cities.reduce((s,c)=>s+c.village_count, 0) : villages.length} 里）`;

    // Render city stats
    if (stats){
      stats.innerHTML = '';
      idx.cities.forEach(c => {
        if (cityCode !== 'all' && c.code !== cityCode) return;
        const counts = c.persistence_counts || {};
        const item = document.createElement('div');
        item.className = 'ep-city-stat';
        item.innerHTML = `
          <strong>${escapeHtml(c.name)}</strong>（${c.village_count} 里）
          <span class="ep-persist-pill persist-blue">永藍 ${counts['永藍']||0}</span>
          <span class="ep-persist-pill persist-green">永綠 ${counts['永綠']||0}</span>
          <span class="ep-persist-pill persist-flip">翻轉 ${counts['翻轉']||0}</span>
          <span class="ep-persist-pill persist-swing">搖擺 ${counts['搖擺']||0}</span>
        `;
        stats.appendChild(item);
      });
    }

    // Build table
    wrap.innerHTML = '';
    if (!display.length){
      wrap.innerHTML = '<p class="hint">目前沒有資料。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'ep-table';
    table.innerHTML = `
      <thead><tr>
        <th>排名</th>
        <th>區 / 里</th>
        <th>人口</th>
        <th>屬性</th>
        <th>策略</th>
        <th title="GOTV=催票（已支持者）｜persuasion=說服（中間選民）｜mixed=雙軌｜maintain=維護">行動方式</th>
        <th>預算</th>
        <th>投票率</th>
        <th>搖擺度</th>
        <th>Priority</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');
    display.forEach((v, i) => {
      const tr = document.createElement('tr');
      tr.className = 'ep-row';
      const persistCls = PERSISTENCE_COLORS[v.persistence] || 'persist-other';
      const stratCls = `strategy-${(v.strategy_type || '').toLowerCase().replace('_', '-')}`;
      const actionCls = `action-${(v.action || '').toLowerCase()}`;
      const budgetCls = `budget-${(v.budget_hint || '').toLowerCase()}`;
      tr.innerHTML = `
        <td class="ep-rank">${i + 1}</td>
        <td class="ep-village"><strong>${escapeHtml(v.town)}</strong> ${escapeHtml(v.village)}</td>
        <td class="ep-num">${v.pop.toLocaleString()}</td>
        <td><span class="ep-persist-pill ${persistCls}">${escapeHtml(v.persistence)}</span></td>
        <td><span class="ep-strategy-pill ${stratCls}" title="${escapeHtml((v.outreach || []).join('、'))}">${escapeHtml(v.strategy_label || '—')}</span></td>
        <td><span class="ep-action-pill ${actionCls}" title="${escapeHtml(actionLabel(v.action).full)}">${escapeHtml(actionLabel(v.action).short)}</span></td>
        <td><span class="ep-budget-pill ${budgetCls}">${escapeHtml(v.budget_hint || '—')}</span></td>
        <td class="ep-num">${v.turnout != null ? v.turnout + '%' : '—'}</td>
        <td class="ep-num">${v.volatility}</td>
        <td class="ep-priority"><strong>${v.priority}</strong></td>
      `;
      tr.addEventListener('click', () => openVillageDetail(v));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  };

  citySelect?.addEventListener('change', renderTable);
  limitSelect?.addEventListener('change', renderTable);
  await renderTable();
}

function renderMayorPredictionCard(v){
  // 里級「縣長」基本面預測（gen_yunlin_mayor_forecast.py 的 local_prediction）
  const p = v.local_prediction;
  if (!p) return '';
  const partyClass = (x) => x === 'KMT' ? 'persist-blue' : x === 'DPP' ? 'persist-green'
                          : x === 'TPP' ? 'persist-white' : 'persist-other';
  const confLabel = { high: '高（差距 ≥15pt）', medium: '中（差距 5–15pt）',
                      low: '低（差距 <5pt 膠著）' }[p.confidence] || p.confidence;
  return `
    <div class="ep-prediction-box">
      <div class="ep-prediction-headline">
        🔮 下屆縣長基本面預測：
        <span class="ep-persist-pill ${partyClass(p.predicted_winner)}" style="font-size:14px">${p.predicted_winner}</span>
        <span class="hint">　領先 ${p.predicted_margin}pt　信心 ${confLabel}</span>
      </div>
      <div class="ep-prediction-bars">
        <div class="ep-bar-row"><span class="ep-bar-label">KMT</span>
          <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.kmt_pct}%;background:#3b82f6"></div></div>
          <span class="ep-bar-pct">${p.kmt_pct}%</span></div>
        <div class="ep-bar-row"><span class="ep-bar-label">DPP</span>
          <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.dpp_pct}%;background:#22c55e"></div></div>
          <span class="ep-bar-pct">${p.dpp_pct}%</span></div>
      </div>
      <div class="hint" style="margin-top:8px">加權近 5 屆<strong>縣長</strong>得票 + momentum ×0.3、標準化。純基本面、沒抓 2026 候選人（張嘉郡 vs 劉建國）與現任效應。</div>
    </div>`;
}

function renderPresidentialBlock(v){
  const hist = v.presidential_history || [];
  const pred = v.presidential_prediction;
  if (!hist.length) return '';

  const partyClass = (p) => p === 'KMT' ? 'persist-blue' : p === 'DPP' ? 'persist-green'
                          : p === 'TPP' ? 'persist-white' : p === 'PFP' ? 'persist-flip' : 'persist-other';

  const histRows = hist.map(r => `
    <tr>
      <td>${r.year}</td>
      <td><span class="ep-persist-pill ${partyClass(r.winner)}">${r.winner || '—'}</span></td>
      <td class="ep-num">${r.kmt_pct}%</td>
      <td class="ep-num">${r.dpp_pct}%</td>
      <td class="ep-num">${r.tpp_pct > 0 ? r.tpp_pct + '%' : '—'}</td>
      <td class="ep-num">${r.pfp_pct > 0 ? r.pfp_pct + '%' : '—'}</td>
      <td class="ep-num">${r.total.toLocaleString()}</td>
    </tr>`).join('');

  const renderPredCard = (p, label, extraNote='') => {
    if (!p) return '';
    const cls = partyClass(p.predicted_winner);
    const confLabel = { high: '高（差距 ≥15pt）',
                        medium: '中（差距 5-15pt）',
                        low: '低（差距 <5pt 膠著）' }[p.confidence] || p.confidence;
    return `
      <div class="ep-prediction-box ${label === '民調校正後' ? 'ep-prediction-polls' : ''}">
        <div class="ep-prediction-headline">
          🔮 ${label}：
          <span class="ep-persist-pill ${cls}" style="font-size:14px">${p.predicted_winner}</span>
          <span class="hint">　領先 ${p.predicted_margin}pt　信心 ${confLabel}</span>
        </div>
        <div class="ep-prediction-bars">
          <div class="ep-bar-row"><span class="ep-bar-label">KMT</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.kmt_pct}%;background:#3b82f6"></div></div>
            <span class="ep-bar-pct">${p.kmt_pct}%</span></div>
          <div class="ep-bar-row"><span class="ep-bar-label">DPP</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.dpp_pct}%;background:#22c55e"></div></div>
            <span class="ep-bar-pct">${p.dpp_pct}%</span></div>
          <div class="ep-bar-row"><span class="ep-bar-label">TPP</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.tpp_pct}%;background:#e5e7eb"></div></div>
            <span class="ep-bar-pct">${p.tpp_pct}%</span></div>
        </div>
        ${extraNote ? `<div class="hint" style="margin-top:8px">${extraNote}</div>` : ''}
      </div>`;
  };

  const predBaselineNote = '模型：加權近 5 屆得票（最近 0.55、上一屆 0.30、再上一屆 0.10）+ momentum（最近 2 屆 vs 之前的趨勢延伸 ×0.3）。沒考慮民調 — 純歷史基本盤。';
  const predBaseline = renderPredCard(pred, '下屆總統預測（純基本面）', predBaselineNote);

  const predPolls = v.presidential_prediction_polls;
  let predPollsBlock = '';
  if (predPolls && pred){
    const swing = predPolls.swing_applied || {};
    const note = `對純基本面套上全國 uniform swing：KMT ${swing.KMT >= 0 ? '+' : ''}${swing.KMT}pt、DPP ${swing.DPP >= 0 ? '+' : ''}${swing.DPP}pt、TPP ${swing.TPP >= 0 ? '+' : ''}${swing.TPP}pt（民調 - 2024 實際）後再正規化。`;
    predPollsBlock = renderPredCard(predPolls, '民調校正後', note);
  }
  const predBlock = predBaseline + predPollsBlock;

  return `
    <h3>🗳️ 歷年總統選舉（${hist[0].year}–${hist[hist.length-1].year}，全 ${hist.length} 屆）</h3>
    <table class="ep-history-table">
      <thead><tr>
        <th>年</th><th>勝者</th><th>KMT</th><th>DPP</th><th>TPP</th><th>PFP</th><th>總票數</th>
      </tr></thead>
      <tbody>${histRows}</tbody>
    </table>
    ${predBlock}
  `;
}

// 把里級地圖聚焦到指定里，加上閃爍高亮 + 開 tooltip
function focusVillageOnMap({ city, town, village }){
  if (!city || !town || !village) return;
  const emCity = document.getElementById('emCitySelect');
  if (!emCity) return;
  const needsCityChange = emCity.value !== city;
  if (needsCityChange){
    emCity.value = city;
    emCity.dispatchEvent(new Event('change'));
  }

  const tryFocus = (attempts = 0) => {
    if (!electionMapLayer || electionMapLayer.getLayers().length < 2){
      if (attempts < 30) return setTimeout(() => tryFocus(attempts + 1), 250);
      console.warn('focusVillageOnMap: layer not loaded');
      return;
    }
    let found = null;
    electionMapLayer.eachLayer(layer => {
      const p = (layer.feature && layer.feature.properties) || {};
      if (p.TOWNNAME === town && p.VILLAGENAM === village){
        found = layer;
      }
    });
    // 找不到時試正規化（plotdb 偶有 鎮/鄉/市 vs 區、村 vs 里 的差）
    if (!found){
      electionMapLayer.eachLayer(layer => {
        const p = (layer.feature && layer.feature.properties) || {};
        const normTown = (p.TOWNNAME || '').replace(/[鎮鄉市]$/, '區');
        const normVil  = (p.VILLAGENAM || '').replace(/村$/, '里');
        if ((normTown === town || p.TOWNNAME === town) &&
            (normVil === village || p.VILLAGENAM === village)){
          found = layer;
        }
      });
    }
    if (!found){
      console.warn(`focusVillageOnMap: ${town}|${village} 找不到對應 polygon`);
      return;
    }
    // pan/zoom + 閃爍高亮
    const bounds = found.getBounds();
    if (bounds && bounds.isValid()){
      electionMap.fitBounds(bounds, { maxZoom: 15, padding: [80, 80] });
    }
    // 高亮 — 黃色粗邊 3 秒後恢復
    const origStyle = { weight: 0.4, color: '#9fb0ea' };
    found.setStyle({ weight: 5, color: '#c08c12' });
    setTimeout(() => { try { found.setStyle(origStyle); } catch(e){} }, 3000);
    if (found.getTooltip()) found.openTooltip();
    document.getElementById('electionMapPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  setTimeout(tryFocus, needsCityChange ? 200 : 0);
}

// 全域 click handler 處理 .ep-maps-btn — 用 event delegation 因為按鈕在動態 modal 裡
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ep-maps-btn');
  if (!btn) return;
  const payload = btn.getAttribute('data-focus');
  if (!payload) return;
  try {
    const v = JSON.parse(payload);
    focusVillageOnMap(v);
    // 關閉 modal
    const modal = document.getElementById('hotspotDetailModal');
    if (modal){
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  } catch(err){
    console.warn('focus btn payload parse failed:', err);
  }
});

function openVillageDetail(v){
  // 重用既有 hotspotDetailModal — 把里資訊塞進去顯示
  const years = v.years || [];
  const histRows = years.map((y, i) => {
    const kmt = v.kmt_rates?.[i] ?? 0;
    const dpp = v.dpp_rates?.[i] ?? 0;
    const tpp = v.tpp_rates?.[i] ?? 0;
    const winner = v.winner_parties?.[i] || '';
    const winnerCls = winner === 'KMT' ? 'persist-blue' : winner === 'DPP' ? 'persist-green' : winner === 'TPP' ? 'persist-white' : 'persist-other';
    const off = (v.official_by_year || {})[String(y)];
    return `
      <tr>
        <td>${y}</td>
        <td><span class="ep-persist-pill ${winnerCls}">${winner || '—'}</span></td>
        <td class="ep-num">${kmt}%</td>
        <td class="ep-num">${dpp}%</td>
        <td class="ep-num">${tpp}%</td>
        <td class="ep-num">${off ? off.turnout + '%' : '—'}</td>
      </tr>`;
  }).join('');

  const stratCls = `strategy-${(v.strategy_type || '').toLowerCase().replace('_', '-')}`;
  const actionCls = `action-${(v.action || '').toLowerCase()}`;
  const budgetCls = `budget-${(v.budget_hint || '').toLowerCase()}`;
  const dp = v.demo_profile || {};
  const ageMap = { young: '青年化', mid: '中壯年', senior: '高齡化', mixed: '混合' };
  const eduMap = { high: '高教育', mid: '中等教育', low: '基礎教育' };
  const genderMap = { male: '男性偏多', female: '女性偏多', balanced: '性別均衡' };

  // 「在里級地圖上查看」— 切到該縣市的 Leaflet 地圖、聚焦該里、高亮並開 tooltip
  const focusBtnPayload = JSON.stringify({ city: v.city, town: v.town, village: v.village });

  const html = `
    <div class="ep-detail-meta">
      <div class="ep-detail-meta-headline">
        <strong style="font-size:15px">${escapeHtml(v.cityName || '')} ${escapeHtml(v.town || '')} ${escapeHtml(v.village || '')}</strong>
        <span class="ep-priority-tag">priority ${v.priority}</span>
        <button class="ep-maps-btn" type="button" data-focus='${escapeHtml(focusBtnPayload)}' title="在上方「里級地理視覺化」地圖上聚焦此里">📍 在地圖上聚焦</button>
      </div>
      <div class="hint">人口 ${v.pop.toLocaleString()}　選舉人數 ${v.voters.toLocaleString()}　投票率 ${v.turnout != null ? v.turnout + '%' : '—'}${v.turnout_source === 'cec_2022' ? '（中選會官方 2022）' : ''}　中位年齡 ${v.median_age || '—'} 歲</div>
      <div class="hint">屬性：<span class="ep-persist-pill ${PERSISTENCE_COLORS[v.persistence] || 'persist-other'}">${escapeHtml(v.persistence)}</span>　搖擺度 ${v.volatility}　翻盤 ${v.flips} 次　最近差距 ${v.latest_margin}%　說服空間 ${v.persuadability}</div>
    </div>

    <h3>🎯 拉票策略建議（給幕僚操作用）</h3>
    <div class="ep-strategy-box">
      <div class="ep-strategy-headline">
        <span class="ep-strategy-pill ${stratCls}">${escapeHtml(v.strategy_label || '—')}</span>
        <span class="ep-action-pill ${actionCls}" title="${escapeHtml(actionLabel(v.action).full)}">${escapeHtml(actionLabel(v.action).short)}</span>
        <span class="ep-budget-pill ${budgetCls}">預算：${escapeHtml(v.budget_hint || '—')}</span>
      </div>
      ${actionLabel(v.action).full ? `<p class="ep-action-explainer">${escapeHtml(actionLabel(v.action).full)}</p>` : ''}
      ${v.strategy_reason ? `<p class="ep-strategy-reason">${escapeHtml(v.strategy_reason)}</p>` : ''}

      <div class="ep-detail-list-title">建議接觸方式（${(v.outreach || []).length} 種）</div>
      <ul class="ep-detail-list">
        ${(v.outreach || []).map(o => `
          <li>
            <span class="ep-list-name">${escapeHtml(o)}</span>
            <span class="ep-list-reason">${escapeHtml((_epIndexCache.data?.reasons?.outreach || {})[o] || '')}</span>
          </li>`).join('')}
      </ul>

      <div class="ep-detail-list-title">議題優先序（${(v.topics || []).length} 個）</div>
      <ul class="ep-detail-list">
        ${(v.topics || []).map((t, i) => `
          <li>
            <span class="ep-list-num">${i + 1}.</span>
            <span class="ep-list-name">${escapeHtml(t)}</span>
            <span class="ep-list-reason">${escapeHtml((_epIndexCache.data?.reasons?.topics || {})[t] || '')}</span>
          </li>`).join('')}
      </ul>
    </div>

    <h3>👥 人口圖像</h3>
    <div class="ep-demo-box">
      <div class="ep-demo-row">
        <span class="ep-demo-tag">${escapeHtml(ageMap[dp.age_skew] || dp.age_skew || '—')}</span>
        <span class="ep-demo-tag">${escapeHtml(eduMap[dp.edu_skew] || dp.edu_skew || '—')}</span>
        <span class="ep-demo-tag">${escapeHtml(genderMap[dp.gender_skew] || dp.gender_skew || '—')}</span>
      </div>
      <div class="hint">20-39 歲 ${v.a20_39_pct}%　60+ 歲 ${v.a60up_pct}%　大專以上 ${v.high_edu_pct}%（含研究所 ${v.graduate_pct}%）　男性比例 ${v.male_pct}%</div>
    </div>

    ${v.source === 'presidential' ? '' : `
    <h3>📜 ${v.source === 'local_mayor' ? '歷次縣市長選舉' : '歷次直轄市長選舉'}</h3>
    <table class="ep-history-table">
      <thead><tr><th>年</th><th>勝者</th><th>KMT</th><th>DPP</th><th>TPP</th><th title="中選會官方投票率（elprof）">投票率</th></tr></thead>
      <tbody>${histRows}</tbody>
    </table>
    `}

    ${renderMayorPredictionCard(v)}
    ${renderPresidentialBlock(v)}
  `;

  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  document.getElementById('hotspotDetailTitle').textContent =
    `${v.cityName || ''} ${v.town || ''} ${v.village || ''}（priority ${v.priority}）`;
  const body = document.getElementById('hotspotDetailBody');
  body.innerHTML = html;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function initPastEventsToggle(){
  const wrap = document.getElementById('pastEventsWrap');
  const btn = document.getElementById('pastEventsToggle');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

function initModal(){
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  document.getElementById('modalClose')?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === '1') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });
  document.querySelectorAll('#modalFilters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modalState.filter = btn.dataset.filter;
      document.querySelectorAll('#modalFilters .filter-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      renderModalBody();
    });
  });
}

// --------- Person-mention drilldown modal ---------
function openMentionModal(name){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  const articles = (state.mentionArticles && state.mentionArticles[name]) || [];
  const windowLabel = mode === '7d' ? '近 7 日' : '近 24h';
  document.getElementById('mentionModalTitle').textContent = `${name}（${windowLabel} 提及 ${articles.length} 則）`;
  const body = document.getElementById('mentionModalBody');
  body.innerHTML = '';
  if (articles.length === 0){
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '此時段沒有提及紀錄。';
    body.appendChild(p);
  } else {
    const ol = document.createElement('ol');
    ol.className = 'mention-list';
    articles.forEach(x => {
      const li = document.createElement('li');
      const co = Array.isArray(x.co_mentioned) ? x.co_mentioned : [];
      if (co.length > 0) li.classList.add('co-mention');
      // 燈號 badge：紅 / 黃 / 綠 — 用跟平台 modal 同一套 hd-news-badge 樣式（淡背景框＋文字）
      const sev = x.severity;
      const sevTier = sev === 'red' ? 'red' : (sev === 'yellow' ? 'yellow' : 'green');
      li.classList.add('hd-news-' + sevTier);
      const sevBadge = document.createElement('span');
      sevBadge.className = 'hd-news-badge hd-news-badge-' + sevTier;
      sevBadge.textContent = sevTier === 'red' ? '🔴 紅燈' : (sevTier === 'yellow' ? '🟡 黃燈' : '🟢 綠燈');
      sevBadge.title = sevTier === 'red' ? '紅燈：負面/攻擊' : (sevTier === 'yellow' ? '黃燈：爭議/質疑' : '綠燈：正面/中性');
      li.appendChild(sevBadge);
      const meta = document.createElement('span');
      meta.className = 'mention-meta';
      const t = (x.time || '').slice(5, 16);
      meta.textContent = `${t}　[${x.platform || '-'}]　`;
      li.appendChild(meta);
      if (x.publisher){
        const pub = document.createElement('span');
        pub.className = 'hd-news-publisher';
        pub.textContent = x.publisher;
        li.appendChild(pub);
      }
      if (co.length > 0) {
        const chip = document.createElement('span');
        chip.className = 'co-chip';
        chip.textContent = `🔗 共現：${co.join('、')}`;
        chip.title = '此篇同時提及多位候選人';
        li.appendChild(chip);
        li.appendChild(document.createTextNode(' '));
      }
      const a = document.createElement('a');
      a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (x.title || '').trim() || '（無標題）';
      li.appendChild(a);
      // LLM feedback loop：mention modal 也能標錯了
      attachCorrectionAffordance(li, {
        target_type:    'event',
        target_id:      x.url || x.title || '',
        original_label: sevTier,
        context:        (x.title || '').slice(0, 80),
      });
      ol.appendChild(li);
    });
    body.appendChild(ol);
    // 標題加上一行共現摘要
    const coCount = articles.filter(x => Array.isArray(x.co_mentioned) && x.co_mentioned.length).length;
    if (coCount > 0) {
      const note = document.createElement('p');
      note.className = 'mention-summary-note';
      note.textContent = `※ 其中 ${coCount} 則同時提及其他市長（已標記🔗）`;
      body.insertBefore(note, ol);
    }
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeMentionModal(){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initMentionModal(){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  document.getElementById('mentionModalClose')?.addEventListener('click', closeMentionModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === 'mention') closeMentionModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeMentionModal();
  });
}

// --------- Hotspot detail modal ---------
const PLATFORM_CHIP_CLASS = { facebook: 'fb', instagram: 'ig', threads: 'th' };
const PLATFORM_DISPLAY = { facebook: 'FB', instagram: 'IG', threads: 'Threads' };

function openHotspotDetailModal(h, markersByTitle){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  // 用 total_count_override (chart click 場景) 或 fallback 到 news_count + comment_count (hotspot 場景)
  const total = (typeof h.total_count_override === 'number')
    ? h.total_count_override
    : ((h.news_count || 0) + (h.comment_count || 0));
  document.getElementById('hotspotDetailTitle').textContent = `${h.title || '事件'}（${total} 則）`;

  const body = document.getElementById('hotspotDetailBody');
  body.innerHTML = '';

  // 摘要列：等級 chip + 地點 + 平台 + 壽命
  // 從卡片/圖表開的「純清單」modal 不需要 level/place（會傳 null/undefined），
  // 此時整列只顯示 note 與 lifetime
  const meta = document.createElement('div');
  meta.className = 'hd-meta';
  const lifetime = formatLifetimeHint(h);
  const parts = [];
  if (h.level) parts.push(`<span class="hc-level-chip ${h.level}">${h.level.toUpperCase()}</span>`);
  if (h.place) parts.push(`<span class="hd-meta-place">📍 ${escapeHtml(h.place)}</span>`);
  if (h.platform) parts.push(`<span class="hd-meta-platform">${escapeHtml(h.platform)}</span>`);
  if (h.note) parts.push(`<span class="hd-meta-note">${escapeHtml(h.note)}</span>`);
  if (lifetime) parts.push(`<span class="hd-meta-life">⏳ ${escapeHtml(lifetime)}</span>`);
  meta.innerHTML = parts.join('');
  if (parts.length) body.appendChild(meta);

  // 「在地圖上定位」按鈕
  if (markersByTitle && markersByTitle[h.title]){
    const locateBtn = document.createElement('button');
    locateBtn.className = 'hd-locate-btn';
    locateBtn.type = 'button';
    locateBtn.textContent = '🗺️ 在地圖上定位 →';
    locateBtn.addEventListener('click', () => {
      const m = markersByTitle[h.title];
      if (m && incidentMap){
        closeHotspotDetailModal();
        incidentMap.setView(m.getLatLng(), 13, { animate: true });
        m.openPopup();
        document.getElementById('incidentMap')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    body.appendChild(locateBtn);
  }

  const articles = Array.isArray(h.news_articles) ? h.news_articles : [];
  const comments = Array.isArray(h.comments) ? h.comments : [];
  const loadMoreCtx = h.loadMoreCtx || null;

  // 提出 li 構造邏輯給 load-more append 也能用
  const renderModalNewsLi = (x) => {
    const li = document.createElement('li');
    const sev = x.severity || (x.is_negative ? 'yellow' : null);
    const origSev = (sev === 'red' || sev === 'yellow' || sev === 'green') ? sev : 'green';
    li.classList.add('hd-news-' + origSev);
    const badge = document.createElement('span');
    badge.className = 'hd-news-badge hd-news-badge-' + origSev;
    badge.textContent = origSev === 'red' ? '🔴 紅燈' : (origSev === 'yellow' ? '🟡 黃燈' : '🟢 綠燈');
    badge.title = origSev === 'red' ? '標題命中嚴重事件詞（刑事 / 公共安全 / 重大）'
                : origSev === 'yellow' ? '標題命中政治批評／環境問題詞'
                : '正面 / 中性 / 利多';
    li.appendChild(badge);
    attachCorrectionAffordance(li, {
      target_type:    'event',
      target_id:      x.url || x.title || '',
      original_label: origSev,
      context:        (x.title || '').slice(0, 80),
    });
    const meta = document.createElement('span');
    meta.className = 'mention-meta';
    meta.textContent = `${(x.time || '').slice(5, 16)}　`;
    li.appendChild(meta);
    if (x.publisher){
      const pub = document.createElement('span');
      pub.className = 'hd-news-publisher';
      pub.textContent = x.publisher;
      li.appendChild(pub);
    }
    const a = document.createElement('a');
    a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = (x.title || '').trim() || '（無標題）';
    li.appendChild(a);
    return li;
  };

  // 新聞區塊
  const newsSec = document.createElement('section');
  newsSec.className = 'hd-section';
  newsSec.innerHTML = `<h3>📰 相關新聞（${articles.length} 則）</h3>`;
  if (articles.length === 0){
    newsSec.insertAdjacentHTML('beforeend', '<p class="hint">此事件目前沒有對應的新聞報導。</p>');
  } else {
    const ol = document.createElement('ol');
    ol.className = 'hd-news-list';
    let redCount = 0, yellowCount = 0;
    articles.forEach(x => {
      const sev = x.severity || (x.is_negative ? 'yellow' : null);
      if (sev === 'red') redCount += 1;
      else if (sev === 'yellow') yellowCount += 1;
      ol.appendChild(renderModalNewsLi(x));
    });
    if (redCount > 0 || yellowCount > 0){
      const note = document.createElement('p');
      note.className = 'hint hd-neg-note';
      const parts = [];
      if (redCount > 0) parts.push(`🔴 紅燈 ${redCount} 則（刑事 / 公共安全 / 重大事件）`);
      if (yellowCount > 0) parts.push(`🟡 黃燈 ${yellowCount} 則（政治批評 / 環境問題）`);
      note.textContent = `※ ${parts.join('，')}`;
      newsSec.appendChild(note);
    }
    newsSec.appendChild(ol);
    // Load-more button — 只在 caller 有提供 newsFetchFn 時加
    if (loadMoreCtx && typeof loadMoreCtx.newsFetchFn === 'function') {
      makeLoadMoreRPC(newsSec, ol,
        loadMoreCtx.newsFetchFn,
        renderModalNewsLi,
        articles.length,
        loadMoreCtx.newsBatch || 50);
    }
  }
  body.appendChild(newsSec);

  const renderModalCmtLi = (c) => {
    const li = document.createElement('li');
    li.className = 'hd-comment';
    const platCls = PLATFORM_CHIP_CLASS[c.platform] || '';
    const platName = PLATFORM_DISPLAY[c.platform] || c.platform;
    const sigCls = c.signal === 'red' ? 'red' : c.signal === 'yellow' ? 'yellow' : c.signal === 'green' ? 'green' : '';
    const time = c.time_text ? `<span class="hd-c-time">${escapeHtml(c.time_text)}</span>` : '';
    const author = c.author ? `<span class="hd-c-author">${escapeHtml(c.author)}</span>` : '';
    const sigChip = sigCls ? `<span class="light-chip ${sigCls}">${sigCls === 'red' ? '🔴' : sigCls === 'yellow' ? '🟡' : '🟢'}</span>` : '';
    const link = c.url ? `<a class="hd-c-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">原文 →</a>` : '';
    li.innerHTML = `
      <div class="hd-c-hdr">
        <span class="hd-c-platform plat-${platCls}">${platName}</span>
        ${sigChip}
        ${author}
        ${time}
        ${link}
      </div>
      <div class="hd-c-text">${escapeHtml(c.text || '')}</div>
    `;
    const cmtTargetId = c.url || `cmt:${c.platform || '?'}::${(c.text || '').slice(0, 80)}`;
    attachCorrectionAffordance(li, {
      target_type:    'comment',
      target_id:      cmtTargetId,
      original_label: sigCls || 'green',
      context:        ((c.author ? c.author + '：' : '') + (c.text || '')).slice(0, 80),
    });
    return li;
  };

  // 留言區塊
  const cmtSec = document.createElement('section');
  cmtSec.className = 'hd-section';
  cmtSec.innerHTML = `<h3>💬 相關留言（${comments.length} 則）</h3>`;
  if (comments.length === 0){
    cmtSec.insertAdjacentHTML('beforeend', '<p class="hint">此事件目前沒有對應的留言。</p>');
  } else {
    const ul = document.createElement('ul');
    ul.className = 'hd-comment-list';
    comments.forEach(c => ul.appendChild(renderModalCmtLi(c)));
    cmtSec.appendChild(ul);
    // Load-more button — 只在 caller 有提供 cmtFetchFn 時加
    if (loadMoreCtx && typeof loadMoreCtx.cmtFetchFn === 'function') {
      makeLoadMoreRPC(cmtSec, ul,
        loadMoreCtx.cmtFetchFn,
        renderModalCmtLi,
        comments.length,
        loadMoreCtx.cmtBatch || 100);
    }
  }
  body.appendChild(cmtSec);

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeHotspotDetailModal(){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initHotspotDetailModal(){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  document.getElementById('hotspotDetailClose')?.addEventListener('click', closeHotspotDetailModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === 'hotspot') closeHotspotDetailModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeHotspotDetailModal();
  });
}

// --------- Main render ---------
async function run(){
  let d;
  if (_runJsonCache) {
    // Mode switch (24h ↔ 7d) — reuse cached JSON, skip 6 file fetches.
    // state.* (socialSignals/history/comments) already populated by first run.
    d = _runJsonCache.d;
  } else {
    d = await fetchJSON('./data.json');
    if (!d) return;

    // New signal/comment/history artefacts — optional, safe if absent
    state.socialSignals = await fetchJSON('./social_signals.json') || null;
    state.history = await fetchJSON('./social_signals_history.json') || { facebook: [], instagram: [], threads: [] };
    state.comments.facebook = await fetchJSON('./comments_facebook.json') || [];
    state.comments.instagram = await fetchJSON('./comments_instagram.json') || [];
    state.comments.threads = await fetchJSON('./comments_threads.json') || [];
    _runJsonCache = { d };
  }

  // [Migration C — Phase 4] RPC PRIMARY (data.json 變成 fallback only)
  //
  // 預設行為：所有 section 用 Supabase RPC 即時資料、data.json 是 boot fallback
  //   - 一個 RPC 失敗 → 該 section fallback to data.json (其他 section 不受影響)
  //   - 全部 RPC 失敗 / LxyDB 沒載入 → 整個 fall back to data.json
  //   - ?source=json → 強制走 data.json (debug / disaster recovery 用)
  //
  // 加速：13 個 RPC 並行打、每個 cache 5 分；total cold time ~1-2s、warm 0ms。
  // data.json 還是會載 (5.8MB 慢)、但裡面所有欄位都被 RPC 覆寫 → 未來把 data.json
  // 砍到 50KB 也不影響功能。
  const SOURCE_MODE = new URLSearchParams(location.search).get('source') || 'rpc';
  const useRpc = (SOURCE_MODE !== 'json') && (typeof LxyDB !== 'undefined');
  if (useRpc) {
    const hours = (mode === '7d') ? 168 : 24;
    const isWeek = (mode === '7d');
    try {
      const [signals, metrics, byHour, topNews, articles, articlesPrev,
             personsSum, byPlatAll, byPlatLu, latestFb, latestNews,
             favHistory, topicArc, mediaFraming, commentsByDate, personSections,
             metricsSelf, byHourSelf, hotspotsRpc]
        = await Promise.all([
          LxyDB.signalsByPlatform(hours).catch(() => null),
          LxyDB.dashboardMetrics(hours).catch(() => null),
          LxyDB.dashboardByHour(hours).catch(() => null),
          LxyDB.dashboardTopNews(hours, 20).catch(() => null),
          LxyDB.dashboardArticles(hours, false).catch(() => null),
          LxyDB.dashboardArticles(hours, true).catch(() => null),
          LxyDB.dashboardPersonsSummary(hours).catch(() => null),
          LxyDB.dashboardByPlatform(hours, false).catch(() => null),
          LxyDB.dashboardByPlatform(hours, true).catch(() => null),
          LxyDB.dashboardLatestByPlatform('facebook', null, 20).catch(() => null),
          LxyDB.dashboardLatestByPlatform('news', null, 20).catch(() => null),
          LxyDB.dashboardSelfFavorabilityHistory(7).catch(() => null),
          LxyDB.dashboardTopicNarrativeArc(7).catch(() => null),
          LxyDB.dashboardMediaFraming(168).catch(() => null),
          LxyDB.dashboardCommentsByDate(7).catch(() => null),
          LxyDB.dashboardPersonSections(20, 20).catch(() => null),
          LxyDB.dashboardMetricsSelf(hours).catch(() => null),
          LxyDB.dashboardByHourSelf(hours).catch(() => null),
          LxyDB.dashboardHotspots(14, 50).catch(() => null),
        ]);

      // 把 RPC 結果覆寫進 d (data.json 對應 key)；null = RPC 失敗、保留 data.json 原值
      if (signals)      state.socialSignals = signals;
      // Overwrite state.comments.* with live N-hour-window queries so the modal
      // count matches the card count (both reflect signals_by_platform's
      // first_seen_at > NOW() - hours window). Uses outer `hours` already
      // declared above (24 / 168 by mode). JSON fallback stays for offline.
      try {
        const [fbCmt, igCmt, threadsCmt] = await Promise.all([
          LxyDB.recentComments('facebook',  5000, hours).catch(() => null),
          LxyDB.recentComments('instagram', 5000, hours).catch(() => null),
          LxyDB.recentComments('threads',   5000, hours).catch(() => null),
        ]);
        if (fbCmt)      state.comments.facebook  = fbCmt;
        if (igCmt)      state.comments.instagram = igCmt;
        if (threadsCmt) state.comments.threads   = threadsCmt;
      } catch (e) { /* keep JSON fallback */ }
      if (metrics)      { if (isWeek) d.metrics_7d = metrics; else d.metrics = metrics; }
      if (byHour)       { if (isWeek) d.by_hour_7d = byHour; else d.by_hour = byHour; }
      if (metricsSelf)  { if (isWeek) d.metrics_self_7d = metricsSelf; else d.metrics_self = metricsSelf; }
      if (byHourSelf)   { if (isWeek) d.by_hour_self_7d = byHourSelf; else d.by_hour_self = byHourSelf; }
      // hotspots（RPC 版）：把 metadata 攤平到 top-level，前端讀 h.lat/h.level/h.news_articles/h.title
      if (Array.isArray(hotspotsRpc) && hotspotsRpc.length) {
        d.hotspots = hotspotsRpc.map(h => ({
          ...h, ...(h.metadata || {}),
          title: (h.metadata && h.metadata.title) || h.topic,
        }));
      }
      if (topNews)      { if (isWeek) d.top_news_7d = topNews; else d.top_news = topNews; }
      if (articles)     { if (isWeek) d.articles_7d = articles; else d.articles_24h = articles; }
      if (articlesPrev) { if (isWeek) d.articles_prev_7d = articlesPrev; else d.articles_prev_24h = articlesPrev; }
      if (personsSum) {
        if (isWeek) {
          d.mention_articles_7d = personsSum.mention_articles;
          d.mention_compare_7d  = personsSum.mention_compare;
          d.voice_breakdown_7d  = personsSum.voice_breakdown;
        } else {
          d.mention_articles_24h = personsSum.mention_articles;
          d.mention_compare_24h  = personsSum.mention_compare;
          d.voice_breakdown_24h  = personsSum.voice_breakdown;
        }
      }
      if (byPlatAll) { if (isWeek) d.by_platform_7d = byPlatAll; else d.by_platform = byPlatAll; }
      if (byPlatLu) { if (isWeek) d.mention_by_platform_7d = byPlatLu; else d.mention_by_platform_24h = byPlatLu; }
      if (latestFb)   d.latest_facebook_20 = latestFb;
      if (latestNews) d.latest_news_20 = latestNews;
      // latest_by_platform_24h/7d (dict)
      const latestByPlat = {};
      if (latestFb && latestFb.length) latestByPlat.facebook = latestFb;
      if (latestNews && latestNews.length) latestByPlat.news = latestNews;
      if (Object.keys(latestByPlat).length) {
        if (isWeek) d.latest_by_platform_7d = latestByPlat;
        else        d.latest_by_platform_24h = latestByPlat;
      }
      if (favHistory)     d.self_favorability_history_7d = favHistory;
      if (topicArc) {
        // RPC v2 (migration 012) 回 {topic: {dates, counts, articles_by_day, total}}
        // Frontend 期望 {topic: [{date, red, yellow, green, total, articles}, ...]} per-day array
        const _arcXform = {};
        for (const [_topic, _v] of Object.entries(topicArc)) {
          if (Array.isArray(_v)) { _arcXform[_topic] = _v; continue; }
          if (_v && _v.dates && _v.counts) {
            const _articlesByDay = _v.articles_by_day || [];
            _arcXform[_topic] = _v.dates.map((_d, _i) => ({
              date:    _d,
              red:     (_v.counts.red    || [])[_i] || 0,
              yellow:  (_v.counts.yellow || [])[_i] || 0,
              green:   (_v.counts.green  || [])[_i] || 0,
              total:   ((_v.counts.red||[])[_i] || 0) +
                       ((_v.counts.yellow||[])[_i] || 0) +
                       ((_v.counts.green||[])[_i] || 0),
              articles: Array.isArray(_articlesByDay[_i]) ? _articlesByDay[_i] : [],
            }));
          }
        }
        d.topic_narrative_arc_7d = _arcXform;
      }
      if (mediaFraming) {
        // RPC 用 'window_hours'、data.json 原本 key 是 'window' — 補相容
        if (mediaFraming.window_hours != null && mediaFraming.window == null) {
          mediaFraming.window = mediaFraming.window_hours;
        }
        d.media_framing_7d = mediaFraming;
      }
      if (commentsByDate) d.comments_by_date_7d = commentsByDate;
      if (personSections) d.person_sections = personSections;

      // 衍生：event_stream 從 articles 按 severity 分流 (data.json 原本是 Python 算的、現在 JS 算)
      const deriveEventStream = (arts) => ({
        minute: (arts || []).filter(a => a.severity === 'red'),
        hour:   (arts || []).filter(a => a.severity === 'yellow'),
        day:    (arts || []).filter(a => !a.severity || a.severity === 'green'),
      });
      if (articles) {
        if (isWeek) d.event_stream_7d = deriveEventStream(articles);
        else        d.event_stream    = deriveEventStream(articles);
      }

      // 結果統計
      const _results = [signals, metrics, byHour, topNews, articles, articlesPrev,
                        personsSum, byPlatAll, byPlatLu, latestFb, latestNews,
                        favHistory, topicArc, mediaFraming, commentsByDate, personSections];
      const _ok = _results.filter(x => x !== null).length;
      const _fail = _results.length - _ok;
      console.log(`%c[LxyDB] RPC primary: ${_ok} ok / ${_fail} fallback (mode=${mode})`,
                  _fail === 0 ? 'color:#1f8a4c' : 'color:#c08c12');
      window.__lxy_supabase = {
        signals, metrics, byHour, topNews, articles, articlesPrev, personsSum,
        byPlatAll, byPlatLu, latestFb, latestNews,
        favHistory, topicArc, mediaFraming, commentsByDate, personSections,
      };
    } catch (e) {
      console.warn('[LxyDB] RPC primary mode 整段失敗、全 fallback 到 data.json:', e && e.message);
    }
  } else if (SOURCE_MODE === 'json') {
    console.log('[LxyDB] ?source=json — 跳過 RPC、純 data.json 模式');
  }
  // 留言按發布日期 group（給 topic arc click 用）— backend 已 parse 好
  state.commentsByDate = d.comments_by_date_7d || {};
  if (!state.topicHeat) state.topicHeat = await fetchJSON('./topic_heat.json') || null;

  const m = pick(d, 'metrics', 'metrics_7d') || {};
  document.getElementById('updated').textContent = '更新時間：' + new Date(d.generated_at).toLocaleString('zh-TW',{hour12:false, timeZone:'Asia/Taipei'});
  document.getElementById('modeHint').textContent = mode==='7d' ? '（近7日聚合）' : '（近24h）';
  document.getElementById('total24').textContent = m.total ?? m.total_24h ?? '-';
  document.getElementById('prev24').textContent = m.prev ?? m.prev_24h ?? '-';
  document.getElementById('growth').textContent = m.growth_pct==null ? '-' : `${m.growth_pct}%`;
  document.getElementById('news24').textContent = m.news ?? m.news_24h ?? '-';

  // 張嘉郡 only 聲量卡片（_self_filter）— 跟雲林版並排、一眼看出曝光落差
  const mSelf = pick(d, 'metrics_self', 'metrics_self_7d') || {};
  { const e = document.getElementById('zjgTotal24'); if (e) e.textContent = mSelf.total ?? '-'; }
  { const e = document.getElementById('zjgPrev24');  if (e) e.textContent = mSelf.prev  ?? '-'; }

  // 卡片點擊 → 開 modal 顯示對應的新聞清單
  state.articles24h = d.articles_24h || [];
  state.articlesPrev24h = d.articles_prev_24h || [];
  state.articles7d = d.articles_7d || [];
  state.articlesPrev7d = d.articles_prev_7d || [];
  const isWeekMode = mode === '7d';
  const totalArticles  = () => isWeekMode ? state.articles7d : state.articles24h;
  const prevArticles   = () => isWeekMode ? state.articlesPrev7d : state.articlesPrev24h;
  const newsArticles   = () => totalArticles().filter(a => a.platform === 'news');
  bindCardClick('total24', isWeekMode ? '雲林近 7 日聲量明細'  : '雲林 24h 聲量明細',
    isWeekMode ? '近 7 日所有與雲林有關的事件' : '近 24 小時所有與雲林有關的事件', totalArticles);
  bindCardClick('prev24',  isWeekMode ? '雲林前 7 日聲量明細'  : '雲林前 24h 聲量明細',
    isWeekMode ? '7-14 天前所有與雲林有關的事件' : '24-48 小時前所有與雲林有關的事件',
    prevArticles);
  bindCardClick('news24',  isWeekMode ? '7 日新聞量明細' : '今日新聞量明細',
    isWeekMode ? '近 7 日所有與雲林有關的新聞' : '近 24 小時所有與雲林有關的新聞', newsArticles);

  // 張嘉郡 only 卡片點擊 — 篩出「提及張嘉郡/嘉郡」的事件
  const _isZjgCard = (a) => { const t=(a.title||''); return t.indexOf('張嘉郡')>=0 || t.indexOf('嘉郡')>=0; };
  const zjgTotalArticles = () => totalArticles().filter(_isZjgCard);
  const zjgPrevArticles  = () => prevArticles().filter(_isZjgCard);
  bindCardClick('zjgTotal24', isWeekMode ? '張嘉郡近 7 日聲量明細' : '張嘉郡 24h 聲量明細',
    isWeekMode ? '近 7 日提及張嘉郡的事件' : '近 24 小時提及張嘉郡的事件', zjgTotalArticles);
  bindCardClick('zjgPrev24',  isWeekMode ? '張嘉郡前 7 日聲量明細' : '張嘉郡前 24h 聲量明細',
    isWeekMode ? '7-14 天前提及張嘉郡的事件' : '24-48 小時前提及張嘉郡的事件', zjgPrevArticles);

  // 三盞燈：新聞燈號（純內容）/ 留言燈號（社群情緒）/ 綜合燈號（兩者取較嚴重）
  const newsResult = severityLightWithReason(totalArticles());
  const cmtResult = commentLightWithReason(state.comments);
  const newsLevel = newsResult.level;
  const cmtLevel = cmtResult.level;
  const overallLevel = LIGHT_RANK[newsLevel] >= LIGHT_RANK[cmtLevel] ? newsLevel : cmtLevel;
  const renderBadge = (lvl, tooltip) => `<span class="badge ${lvl}" style="cursor:pointer" title="${tooltip || ''}">${LIGHT_ICON[lvl]||'🟢'} ${lvl}</span>`;
  document.getElementById('light').innerHTML = renderBadge(overallLevel, '點擊查看原因 + 相關新聞 + 留言（新聞 + 留言取較嚴重者）');
  document.getElementById('lightNews').innerHTML = renderBadge(newsLevel, '點擊查看原因 + 相關新聞 — ' + ((newsResult.reasons||[]).join('; ') || '無紅黃新聞'));
  document.getElementById('lightComments').innerHTML = renderBadge(cmtLevel, '點擊查看原因 + 紅/黃留言 — ' + ((cmtResult.reasons||[]).join('; ') || '無紅黃留言'));

  // 紅+黃留言（跨 3 平台彙總）— 給綜合 / 留言燈號 modal 用
  const allRedYellowComments = (() => {
    const out = [];
    for (const plat of ['facebook','instagram','threads']) {
      for (const c of (state.comments[plat] || [])) {
        if (c.signal === 'red' || c.signal === 'yellow') {
          out.push({...c, platform: plat});
        }
      }
    }
    out.sort((a,b) => {
      const ra = a.signal === 'red' ? 0 : 1;
      const rb = b.signal === 'red' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.time_text || '').localeCompare(a.time_text || '');
    });
    return out;
  })();

  // 三盞燈的 click handler
  const lightClick = (lvl, kind) => {
    const titleMap = { overall: '綜合燈號', news: '新聞燈號', comments: '留言燈號' };
    const noteParts = [];
    let arts = null, comments = null;
    if (kind === 'overall') {
      (newsResult.reasons||[]).forEach(r => noteParts.push(`📰 ${r}`));
      (cmtResult.reasons||[]).forEach(r => noteParts.push(`💬 ${r}`));
      arts = totalArticles();
      comments = allRedYellowComments;
    } else if (kind === 'news') {
      (newsResult.reasons||[]).forEach(r => noteParts.push(`📰 ${r}`));
      arts = totalArticles();
      comments = null;
    } else if (kind === 'comments') {
      (cmtResult.reasons||[]).forEach(r => noteParts.push(`💬 ${r}`));
      arts = null;
      comments = allRedYellowComments;
    }
    const note = noteParts.length ? `觸發原因：${noteParts.join('；')}` : '無觸發原因（綠燈）';
    openArticlesModal(`${titleMap[kind]}：${lvl}`, note, arts, comments);
  };
  document.getElementById('light').onclick = () => lightClick(overallLevel, 'overall');
  document.getElementById('lightNews').onclick = () => lightClick(newsLevel, 'news');
  document.getElementById('lightComments').onclick = () => lightClick(cmtLevel, 'comments');

  const cmp = pick(d, 'mention_compare_24h', 'mention_compare_7d') || {};
  const names = Object.keys(cmp);
  const vals = names.map(n => cmp[n] || 0);
  document.getElementById('compare').textContent = names.map(n => `${n}：${cmp[n]||0}`).join(' ｜ ');
  state.mentionArticles = pick(d, 'mention_articles_24h', 'mention_articles_7d') || {};

  // 戰情排名（24h）：用 voice_breakdown_24h 渲染 leaderboard，
  // 並把 mention_articles_24h 一起傳進去做「排名 row 可點擊看新聞」
  renderWarRoomRanking(
    pick(d, 'voice_breakdown_24h', 'voice_breakdown_7d') || {},
    pick(d, 'mention_articles_24h', 'mention_articles_7d') || {}
  );

  // 同人縱向追蹤 — 比跨人比較務實
  renderSelfFavorability(d.self_favorability_history_7d || []);
  renderTopicNarrative(d.topic_narrative_arc_7d || {});

  const byPlatform = pick(d, 'mention_by_platform_24h', 'mention_by_platform_7d') || [];
  const ul = document.getElementById('platforms'); ul.innerHTML='';
  byPlatform.forEach(x=>{ const li=document.createElement('li'); li.textContent=`${x.platform}: ${x.count}`; ul.appendChild(li); });

  // Clickable social cards + alert + trend chart + red panel — all read from state
  renderSocialCards();
  updateAlertBanner();
  renderRedTrendChart();
  renderRedCommentsPanel();
  renderTopicHeat();
  renderIncidentMap(d);
  // Lazy: 4.9MB of JSON (election_priority 4.4MB + hotspot_history 493KB)
  // is below the fold. Render only when section approaches viewport.
  lazyRender('pastEventsWrap',        () => renderPastEvents());
  renderMediaFraming(d);
  lazyRender('electionPriorityPanel', () => renderElectionPriority());
  lazyRender('electionForecastPanel', () => renderElectionForecast());
  lazyRender('electionMapPanel',      () => renderElectionMap());
  // If modal is open, re-render its body with fresh data
  const modal = document.getElementById('commentsModal');
  if (modal && !modal.classList.contains('hidden')) renderModalBody();

  const topNews = pick(d, 'top_news', 'top_news_7d') || [];
  const news = document.getElementById('news'); news.innerHTML='';
  const displayText = (x)=>{
    const t=(x.title||'').trim();
    if(t) return t;
    try{ return new URL(x.url).hostname + '（原文）'; }catch{ return '來源連結'; }
  };
  const renderTopNewsLi = (x) => {
    const li=document.createElement('li');
    const a=document.createElement('a');
    a.href=x.url; a.target='_blank'; a.rel='noopener';
    a.textContent=displayText(x) + (x.time ? `（${x.time.slice(5,16)}）` : '');
    li.appendChild(a);
    return li;
  };
  const INITIAL_TOP_NEWS = 12;
  topNews.slice(0, INITIAL_TOP_NEWS).forEach(x => news.appendChild(renderTopNewsLi(x)));
  // 清掉 run() 上次 append 的舊 button (避免累積)
  const newsParent = news.parentElement;
  newsParent?.querySelectorAll('button.platform-more-btn[data-for-list="news"]').forEach(b => b.remove());
  if (topNews.length > INITIAL_TOP_NEWS) {
    const btn = makeShowMoreButton(newsParent, news, topNews, INITIAL_TOP_NEWS, 20, renderTopNewsLi);
    if (btn) btn.dataset.forList = 'news';
  }

  // 共用：給 li 加上 hd-news-{red/yellow/green} class + 對應的 hd-news-badge pill
  // 跟 hotspot modal / 平台 modal 用同一套樣式，視覺一致
  // 第二個 arg 接受 sev string 或 article object — 後者會順手接上 LLM 修正 🚩
  const attachSeverityBadge = (li, sevOrArticle) => {
    const isArticle = sevOrArticle && typeof sevOrArticle === 'object';
    const sev = isArticle ? sevOrArticle.severity : sevOrArticle;
    const tier = sev === 'red' ? 'red' : (sev === 'yellow' ? 'yellow' : 'green');
    li.classList.add('hd-news-' + tier);
    const badge = document.createElement('span');
    badge.className = 'hd-news-badge hd-news-badge-' + tier;
    badge.textContent = tier === 'red' ? '🔴 紅燈' : (tier === 'yellow' ? '🟡 黃燈' : '🟢 綠燈');
    badge.title = tier === 'red' ? '紅燈：負面/攻擊' : (tier === 'yellow' ? '黃燈：爭議/質疑' : '綠燈：正面/中性');
    li.appendChild(badge);
    // LLM feedback loop：admin 登入時、其他列表也能標錯了
    if (isArticle) {
      attachCorrectionAffordance(li, {
        target_type:    'event',
        target_id:      sevOrArticle.url || sevOrArticle.title || '',
        original_label: tier,
        context:        (sevOrArticle.title || '').slice(0, 80),
      });
    }
  };

  const detailMap = pick(d, 'latest_by_platform_24h', 'latest_by_platform_7d') || {};
  const platformDetail = document.getElementById('platformDetail');
  if(platformDetail){
    platformDetail.innerHTML='';
    const renderArticleLi = (x) => {
      const li=document.createElement('li');
      attachSeverityBadge(li, x);
      if (x.publisher){
        const pub=document.createElement('span'); pub.className='hd-news-publisher';
        pub.textContent=x.publisher; li.appendChild(pub);
      }
      const a=document.createElement('a'); a.href=x.url; a.target='_blank'; a.rel='noopener';
      a.textContent=displayText(x) + (x.time ? `（${x.time.slice(5,16)}）` : '');
      li.appendChild(a);
      return li;
    };
    Object.keys(detailMap).forEach(p=>{
      const initialList = detailMap[p] || [];
      const box=document.createElement('div'); box.className='platform-box';
      const h=document.createElement('h3'); box.appendChild(h);
      const ol=document.createElement('ol');
      initialList.forEach(x => ol.appendChild(renderArticleLi(x)));
      box.appendChild(ol);
      // 「載入更多」按鈕 — 每次點擊向 RPC fetch 多 50 筆、append 進列表
      // 只在初始 list 已滿 (=cap 20) 且當前 mode 是 7d 時顯示（24h 預設 20 通常夠看）
      const isCapped = initialList.length >= 20;
      if (isCapped) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'platform-more-btn';
        moreBtn.dataset.platform = p;
        moreBtn.dataset.loaded = String(initialList.length);
        moreBtn.textContent = `載入更多（已顯示 ${initialList.length} 筆）`;
        moreBtn.addEventListener('click', async () => {
          const cur = parseInt(moreBtn.dataset.loaded, 10) || 20;
          const next = cur + 50;
          moreBtn.disabled = true;
          moreBtn.textContent = '載入中…';
          try {
            // 用當前 mode 對應的 hours_back: 7d=168, 24h=24
            const hours = mode === '7d' ? 168 : 24;
            const fresh = await LxyDB.dashboardLatestByPlatform(p, hours, next);
            // 跳過已渲染的、append 剩下的
            (fresh || []).slice(cur).forEach(x => ol.appendChild(renderArticleLi(x)));
            const newLen = (fresh || []).length;
            moreBtn.dataset.loaded = String(newLen);
            h.textContent = `${p}（${newLen} 筆）`;
            if (newLen < next) {
              moreBtn.textContent = '已全部載入';
              moreBtn.disabled = true;
              moreBtn.classList.add('exhausted');
            } else {
              moreBtn.textContent = `載入更多（已顯示 ${newLen} 筆）`;
              moreBtn.disabled = false;
            }
          } catch (e) {
            console.error('platform-more fetch failed:', e);
            moreBtn.textContent = '載入失敗、點此再試';
            moreBtn.disabled = false;
          }
        });
        box.appendChild(moreBtn);
      }
      h.textContent = `${p}（${initialList.length} 筆${isCapped ? '+' : ''}）`;
      platformDetail.appendChild(box);
    });
  }

  const renderArticleLiPerson = (x) => {
    const li=document.createElement('li');
    attachSeverityBadge(li, x);
    if (x.publisher){
      const pub=document.createElement('span'); pub.className='hd-news-publisher';
      pub.textContent=x.publisher; li.appendChild(pub);
    }
    const a=document.createElement('a'); a.href=x.url; a.target='_blank'; a.rel='noopener';
    a.textContent=displayText(x)+(x.time?`（${x.time.slice(5,16)}）`:'' );
    li.appendChild(a);
    return li;
  };
  function renderList(elId, arr, moreCtx){
    const el=document.getElementById(elId); if(!el) return; el.innerHTML='';
    (arr||[]).forEach(x => el.appendChild(renderArticleLiPerson(x)));
    // 移除「上次 renderList 為這個 elId 加的 button」(避免 run() 多次跑時累積)
    const parent = el.parentElement;
    parent?.querySelectorAll(`button.platform-more-btn[data-for-list="${elId}"]`).forEach(b => b.remove());
    if (moreCtx && (arr||[]).length >= (moreCtx.currentLimit || 20)) {
      // 8 個 list 共用同一 RPC、但 per-list 獨立 grow
      const btn = makeLoadMoreRPC(parent, el,
        async (newLimit) => {
          const fresh = await LxyDB.dashboardPersonSections(newLimit, newLimit);
          if (!fresh) return arr;
          d.person_sections = fresh;
          const person = moreCtx.person, listKey = moreCtx.listKey;
          return (fresh[person] || {})[listKey] || [];
        },
        renderArticleLiPerson,
        (arr||[]).length,
        50);
      if (btn) btn.dataset.forList = elId;
    }
  }
  function renderAllPersonLists(limit) {
    const ps = d.person_sections || {};
    const cfg = (person, listKey) => ({ person, listKey, currentLimit: limit });
    renderList('luFb',      (ps['張嘉郡']||{}).facebook || [], cfg('張嘉郡','facebook'));
    renderList('luNews',    (ps['張嘉郡']||{}).news     || [], cfg('張嘉郡','news'));
    renderList('chiangFb',  (ps['劉建國']||{}).facebook || [], cfg('劉建國','facebook'));
    renderList('chiangNews',(ps['劉建國']||{}).news     || [], cfg('劉建國','news'));
  }
  renderAllPersonLists(20);  // 初始 RPC 拉 20 / list

  const byHourRaw = pick(d, 'by_hour', 'by_hour_7d') || [];
  // 7d 模式聚合到「日」（過去 7 天的週幾）；24h 模式維持小時級
  const isWeek = mode === '7d';
  const dayWeekdayLabel = (d) => {
    // d = "2026-04-30"
    const t = new Date(d + 'T00:00+08:00');  // 假設 Asia/Taipei
    const wd = ['日','一','二','三','四','五','六'][t.getDay()];
    return `${d.slice(5)}（週${wd}）`;
  };
  let byHour;
  if (isWeek){
    // Aggregate by_hour_7d to per-day counts; ensure all 7 days present (zero-fill)
    const dayCounts = {};
    byHourRaw.forEach(h => {
      const day = (h.hour||'').slice(0, 10);
      if (!day) return;
      dayCounts[day] = (dayCounts[day] || 0) + (h.count || 0);
    });
    // Generate last 7 days in order
    const today = new Date(); today.setHours(0,0,0,0);
    const days = [];
    for (let i = 6; i >= 0; i--){
      const d2 = new Date(today.getTime() - i*86400000);
      const ymd = d2.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
      days.push(ymd);
    }
    byHour = days.map(d => ({ hour: d, day: d, count: dayCounts[d] || 0 }));
  } else {
    byHour = byHourRaw;
  }

  // 燈號狀態與原因（可視化）
  const an = m.anomaly || {};
  const reasons = an.reasons || [];
  // 7d 模式優先用 event_stream_7d；fallback 到 24h（資料還沒重新生成時）
  const es = (mode === '7d' && d.event_stream_7d) ? d.event_stream_7d : (d.event_stream || {});
  state.eventStream = es;  // 給點擊 handler 用
  const minuteN = (es.minute || []).length;
  const hourN = (es.hour || []).length;
  const dayN = (es.day || []).length;
  const totalN = minuteN + hourN + dayN;
  const ls = document.getElementById('lightStatus');
  if(ls){
    // 兩盞燈：今日綜合 vs 昨日綜合（新聞 + 留言皆來自 DB 時序快取）
    const todayArts = isWeek ? (state.articles7d || []) : (state.articles24h || []);
    const prevArts  = isWeek ? (state.articlesPrev7d || []) : (state.articlesPrev24h || []);
    const prevNewsResult = severityLightWithReason(prevArts);
    // 昨日留言：用 data.json 內 comments_history.yesterday aggregate（從 social_comments DB 撈）
    const yh = (d.comments_history || {}).yesterday || {total:0, red:0, yellow:0, green:0};
    const prevCmtResult = (function(h){
      // 跟 commentLightWithReason 同公式：紅 ≥3 或 ≥10%；黃 neg ≥10 或 ≥30%
      const total = h.total || 0;
      const red = h.red || 0;
      const yellow = h.yellow || 0;
      const neg = red + yellow;
      if (total === 0) return { level: '綠', reasons: ['昨日尚無留言時序資料（DB cache 累積中）'], total };
      if (red >= 3) return { level: '紅', reasons: [`昨日紅燈留言 ${red} 則（≥3 即紅）`], total };
      if (red >= 1 && red/total >= 0.10) return { level: '紅', reasons: [`昨日紅燈留言佔比 ${(red/total*100).toFixed(0)}%（${red}/${total} ≥ 10%）`], total };
      if (neg >= 10) return { level: '黃', reasons: [`昨日負面留言 ${neg} 則（${red} 紅 + ${yellow} 黃 ≥ 10）`], total };
      if (neg >= 1 && neg/total >= 0.30) return { level: '黃', reasons: [`昨日負面留言佔比 ${(neg/total*100).toFixed(0)}%（${neg}/${total} ≥ 30%）`], total };
      return { level: '綠', reasons: [], total };
    })(yh);
    const prevCmtLevel = prevCmtResult.level;
    const prevLevel = LIGHT_RANK[prevNewsResult.level] >= LIGHT_RANK[prevCmtLevel] ? prevNewsResult.level : prevCmtLevel;
    const todayLabel = isWeek ? '7 日燈號' : '今日燈號';
    const prevLabel  = isWeek ? '前 7 日燈號' : '昨日燈號';

    ls.innerHTML = `
      <span class="badge ${overallLevel} ls-clickable" data-which="today" style="cursor:pointer" title="點擊查看今日燈號的觸發原因 + 相關新聞 + 留言">${LIGHT_ICON[overallLevel]||'🟢'} ${todayLabel}：${overallLevel}</span>
      <span class="badge ${prevLevel} ls-clickable" data-which="prev" style="cursor:pointer;margin-left:10px" title="點擊查看${prevLabel}的觸發原因 + 相關新聞 + 留言">${LIGHT_ICON[prevLevel]||'🟢'} ${prevLabel}：${prevLevel}</span>
    `;

    ls.querySelectorAll('.ls-clickable').forEach(el => {
      el.addEventListener('click', () => {
        const which = el.dataset.which;
        const arts = which === 'today' ? todayArts : prevArts;
        const noteParts = [];
        let commentsForModal = null;
        let modalLevel;
        if (which === 'today') {
          // 含新聞 + 留言原因 + 把今日紅/黃留言帶進 modal
          const todayNews = severityLightWithReason(todayArts);
          (todayNews.reasons || []).forEach(r => noteParts.push(`📰 ${r}`));
          const cmt = commentLightWithReason(state.comments);
          (cmt.reasons || []).forEach(r => noteParts.push(`💬 ${r}`));
          commentsForModal = [];
          for (const plat of ['facebook','instagram','threads']) {
            for (const c of (state.comments[plat] || [])) {
              if (c.signal === 'red' || c.signal === 'yellow') {
                commentsForModal.push({...c, platform: plat});
              }
            }
          }
          commentsForModal.sort((a,b) => {
            const ra = a.signal === 'red' ? 0 : 1;
            const rb = b.signal === 'red' ? 0 : 1;
            if (ra !== rb) return ra - rb;
            return (b.time_text || '').localeCompare(a.time_text || '');
          });
          modalLevel = overallLevel;
        } else {
          // 昨日：新聞 reason + 留言 reason（DB 時序撈出來）+ DB 撈昨日紅黃留言
          (prevNewsResult.reasons || []).forEach(r => noteParts.push(`📰 ${r}`));
          (prevCmtResult.reasons || []).forEach(r => noteParts.push(`💬 ${r}`));
          commentsForModal = ((d.comments_history || {}).yesterday_redyellow || []);
          modalLevel = prevLevel;
        }
        const note = noteParts.length ? `觸發原因：${noteParts.join('；')}` : '無觸發原因（綠燈）';
        const title = `${which === 'today' ? todayLabel : prevLabel}：${modalLevel}`;
        openArticlesModal(title, note, arts, commentsForModal);
      });
    });
  }
  const lr = document.getElementById('lightReasons');
  if(lr){
    // 合併 volume-based reasons (聲量 anomaly) 與 severity-based reasons (新聞嚴重度)
    const combined = [];
    const sevReasons = (mode === '7d'
      ? severityLightWithReason(state.articles7d || []).reasons
      : severityLightWithReason(state.articles24h || []).reasons);
    sevReasons.forEach(r => combined.push(`📰 ${r}`));
    reasons.forEach(r => combined.push(`📈 ${r}`));
    lr.textContent = combined.length ? `觸發原因：${combined.join('；')}` : '觸發原因：無（目前屬常態 — 聲量未異常 + 無紅黃燈新聞）';
  }
  const lstream = document.getElementById('lightStreams');
  if(lstream){
    if (totalN === 0){
      lstream.innerHTML = `<span class="badge 綠">✓ 24h 內無事件需處理（資料尚未抓到，或目前確實無新聞）</span>`;
    } else {
      // 每個分流級別都做成可點按鈕（count > 0 才可點）
      const btn = (icon, label, kind, n, color) => n > 0
        ? `<button type="button" class="stream-btn" data-stream="${kind}" style="border-color:${color};color:${color}">${icon} ${label} ${n}</button>`
        : `<span class="stream-btn-empty">${icon} ${label} ${n}</span>`;
      const buttons = `
        ${btn('🚨', '分鐘級', 'minute', minuteN, '#c43344')}
        ${btn('⚠️', '小時級', 'hour', hourN, '#ffb84d')}
        ${btn('📅', '日級', 'day', dayN, '#9fb0ea')}
      `;
      const explainer = `
        <div class="hint" style="margin-top:6px;font-size:11px;line-height:1.7">
          <strong>分流邏輯</strong>：依新聞 severity 分到不同響應級別（點 badge 看該級別所有新聞）。
          <span style="color:#ff8a8a">🚨 分鐘級 = 紅燈事件</span>（刑事 / 公共安全 / 重大 — 候選人 / 服務處應在 30 分鐘內回應）；
          <span style="color:#ffb84d">⚠️ 小時級 = 黃燈事件</span>（政治批評 / 環境問題 — 當小時內擬好回應稿）；
          <span style="color:#9fb0ea">📅 日級 = 中性事件</span>（常態露出 — 日結時掃過即可，不必個別回應）。
        </div>`;
      lstream.innerHTML = `<div class="stream-row">${buttons}</div>${explainer}`;
    }
  }
  const lt = document.getElementById('lightTrend');
  if(lt){
    const avg = byHour.length ? byHour.reduce((a,b)=>a+(b.count||0),0)/byHour.length : 0;
    const renderClickable = (label, key, count, lv, kind /* 'hour' | 'day' */) => {
      const inner = `${label} ${LIGHT_ICON[lv]}${lv}（${count} 則）`;
      if (count > 0){
        return `<button type="button" class="light-item" data-${kind}="${escapeHtml(key)}" title="點擊查看當${kind === 'day' ? '日' : '小時'}新聞">${inner}</button>`;
      }
      return `<span class="light-item-empty" title="該${kind === 'day' ? '日' : '小時'}沒有新聞">${inner}</span>`;
    };
    // 燈號邏輯：純依該時段內負面新聞分布（severity），不混入 volume —
    // 避免「高聲量但 0 負面」也被標黃。聲量資訊由 chart 柱高 + 旁邊 N 則 數字呈現。
    if (isWeek){
      const items = byHour.map(x => {
        const dayArticles = (state.articles7d || []).filter(a => a.day === x.day);
        const lv = severityLightOf(dayArticles);
        return renderClickable(dayWeekdayLabel(x.day), x.day, x.count || 0, lv, 'day');
      });
      lt.innerHTML = '近 7 日：' + items.join(' ｜ ');
    } else {
      const last = byHour.slice(-12);
      const items = last.map(x => {
        const hourArticles = (state.articles24h || []).filter(a => a.hour === x.hour);
        const lv = severityLightOf(hourArticles);
        const hourLabel = (x.hour || '').slice(11, 16);
        return renderClickable(hourLabel, x.hour, x.count || 0, lv, 'hour');
      });
      lt.innerHTML = '近 12 小時：' + items.join(' ｜ ');
    }
  }

  hourChart = upsertChart(hourChart, document.getElementById('hourChart'), {
    type: isWeek ? 'bar' : 'line',
    data:{
      labels: isWeek
        ? byHour.map(x => dayWeekdayLabel(x.day))
        : byHour.map(x => (x.hour||'').slice(5, 16)),
      datasets:[{
        label:'聲量', data:byHour.map(x=>x.count||0),
        borderColor:'#5a79ff', backgroundColor:isWeek ? '#5a79ff' : 'rgba(127,192,255,0.2)',
        tension:0.25, fill:!isWeek,
        pointRadius: isWeek ? 0 : 4,
        pointHoverRadius: isWeek ? 0 : 7,
        pointBackgroundColor:'rgba(127,192,255,0.4)',
        pointBorderColor:'#5a79ff',
        pointHoverBackgroundColor:'#fff', pointHoverBorderColor:'#5a79ff',
        borderRadius: isWeek ? 6 : 0,
      }],
    },
    options:{
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins:{
        legend:{display:false},
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: { label: (ctx) => `聲量：${ctx.parsed.y}（點擊查看清單）` },
        }),
      },
      scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}, beginAtZero:true}},
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        if (isWeek){
          const dayKey = byHour[idx]?.day;
          if (!dayKey) return;
          const dayArticles = (state.articles7d || []).filter(a => a.day === dayKey);
          openArticlesModal(`${dayWeekdayLabel(dayKey)} 聲量明細`, `當日所有與張嘉郡有關的事件`, dayArticles);
        } else {
          const hourFull = byHour[idx]?.hour;
          if (!hourFull) return;
          const hourArticles = (state.articles24h || []).filter(a => a.hour === hourFull);
          const hourLabel = hourFull.slice(5, 16);
          openArticlesModal(`${hourLabel} 聲量明細`, `該小時內所有與張嘉郡有關的事件`, hourArticles);
        }
      },
    }
  });

  // 張嘉郡 only 聲量趨勢（_self_filter、跟雲林版分開、橘色區分、可點）
  const byHourSelfRaw = pick(d, 'by_hour_self', 'by_hour_self_7d') || [];
  let byHourSelf;
  if (isWeek){
    // 7d：小時聚合成「天」（跟雲林圖一致、補零）
    const dc = {};
    byHourSelfRaw.forEach(h => { const day=(h.hour||'').slice(0,10); if(day) dc[day]=(dc[day]||0)+(h.count||0); });
    const today = new Date(); today.setHours(0,0,0,0);
    const days = [];
    for (let i=6;i>=0;i--){ const d2=new Date(today.getTime()-i*86400000); days.push(d2.toLocaleDateString('en-CA',{timeZone:'Asia/Taipei'})); }
    byHourSelf = days.map(d => ({ hour:d, day:d, count: dc[d]||0 }));
  } else {
    byHourSelf = byHourSelfRaw;
  }
  // 從雲林文章池篩出「提及張嘉郡/嘉郡」的（給點擊 modal 用）
  const isZjgArticle = (a) => { const t=(a.title||''); return t.indexOf('張嘉郡')>=0 || t.indexOf('嘉郡')>=0; };
  if (document.getElementById('zjgHourChart')) {
    zjgHourChart = upsertChart(zjgHourChart, document.getElementById('zjgHourChart'), {
      type: isWeek ? 'bar' : 'line',
      data: {
        labels: isWeek ? byHourSelf.map(x => dayWeekdayLabel(x.day))
                       : byHourSelf.map(x => (x.hour||'').slice(5,16)),
        datasets: [{
          label: '張嘉郡聲量', data: byHourSelf.map(x => x.count||0),
          borderColor:'#ff9f5a', backgroundColor: isWeek ? '#ff9f5a' : 'rgba(255,159,90,0.2)',
          tension:0.25, fill:!isWeek, pointRadius: isWeek?0:4, pointHoverRadius: isWeek?0:7,
          borderRadius: isWeek?6:0,
        }],
      },
      options: {
        interaction: INDEX_HOVER, hover: INDEX_HOVER,
        plugins: { legend:{display:false},
          tooltip: darkTooltip({ mode:'index', displayColors:false,
            callbacks:{ label:(ctx)=>`張嘉郡聲量：${ctx.parsed.y}（點擊查看清單）` } }) },
        scales: { x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}, beginAtZero:true} },
        onHover: (evt, els) => { const t=evt?.native?.target; if(t) t.style.cursor = els.length?'pointer':'default'; },
        onClick: (evt, els) => {
          if (!els.length) return;
          const idx = els[0].index;
          if (isWeek){
            const dayKey = byHourSelf[idx]?.day; if (!dayKey) return;
            const arts = (state.articles7d||[]).filter(a => a.day===dayKey && isZjgArticle(a));
            openArticlesModal(`${dayWeekdayLabel(dayKey)} 張嘉郡聲量明細`, `當日提及張嘉郡的事件`, arts);
          } else {
            const hourFull = byHourSelf[idx]?.hour; if (!hourFull) return;
            const arts = (state.articles24h||[]).filter(a => a.hour===hourFull && isZjgArticle(a));
            openArticlesModal(`${hourFull.slice(5,16)} 張嘉郡聲量明細`, `該小時提及張嘉郡的事件`, arts);
          }
        },
      },
    });
  }

  platformChart = upsertChart(platformChart, document.getElementById('platformChart'), {
    type:'doughnut',
    data:{ labels:byPlatform.map(x=>x.platform), datasets:[{data:byPlatform.map(x=>x.count), backgroundColor:['#5a79ff','#1f8a4c','#c08c12','#e83e8c','#fd7e14','#6f42c1','#adb5bd']}] },
    options:{
      plugins:{
        legend:{labels:{color:'#b9c3f2'}},
        tooltip: darkTooltip({
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a,b)=>a+b, 0);
              const pct = total ? (ctx.parsed / total * 100).toFixed(1) : 0;
              return ` ${ctx.label}：${ctx.parsed}（${pct}%）（點擊查看清單）`;
            },
          },
        }),
      },
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        const plat = byPlatform[idx]?.platform;
        if (!plat) return;
        const map = pick(d, 'latest_by_platform_24h', 'latest_by_platform_7d') || {};
        const items = (map[plat] || []).map(x => ({
          title: x.title, url: x.url, time: x.time, publisher: x.publisher,
          severity: x.severity,
        }));
        const modeLabel = mode === '7d' ? '近 7 日' : '近 24h';
        const hoursForRpc = mode === '7d' ? 168 : 24;
        // 真實平台 total (byPlatform[idx].count 是圓餅圖那一塊的實際數字)
        const realTotal = byPlatform[idx]?.count || items.length;
        openArticlesModal(`平台分佈 — ${plat}（${modeLabel}）`,
                          `命中 2 位候選人與雲林關鍵字，平台 = ${plat}`,
                          items, null,
                          {
                            newsFetchFn: (newLimit) =>
                              LxyDB.dashboardLatestByPlatform(plat, hoursForRpc, newLimit)
                                .then(arr => (arr || []).map(x => ({
                                  title: x.title, url: x.url, time: x.time,
                                  publisher: x.publisher, severity: x.severity,
                                }))),
                            newsBatch: 50,
                          },
                          realTotal);
      },
    }
  });

  mentionChart = upsertChart(mentionChart, document.getElementById('mentionChart'), {
    type:'bar',
    data:{
      labels:names,
      datasets:[{
        label:'提及數', data:vals,
        backgroundColor:['#1f8a4c','#5a79ff','#c08c12','#e83e8c','#fd7e14'],
        borderRadius:4,
        hoverBackgroundColor:'#ffffff40',
      }],
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins:{
        legend:{display:false},
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: { label: (ctx) => `提及：${ctx.parsed.y} 則（點擊查看清單）` },
        }),
      },
      scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}, beginAtZero:true}},
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        const name = names[idx];
        if (name) openMentionModal(name);
      },
    }
  });
}

function initCollapsibles(){
  document.querySelectorAll('.panel-toggle').forEach(btn=>{
    if(btn.dataset.bound==='1') return;
    btn.dataset.bound='1';
    btn.addEventListener('click', ()=>{
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      const panel = btn.closest('.collapsible');
      if(panel) panel.classList.toggle('collapsed', expanded);
    });
  });
}

function applyModeLabels(){
  const isWeek = mode === '7d';
  // Active button highlight
  document.getElementById('mode24')?.classList.toggle('is-active', !isWeek);
  document.getElementById('mode7d')?.classList.toggle('is-active', isWeek);
  // 標題裡的 24h/24小時 文字統一替換成 7日
  document.querySelectorAll('[data-window-label]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    if (isWeek){
      el.textContent = el.dataset.origText.replaceAll('24h', '7日').replaceAll('24小時', '7日');
    } else {
      el.textContent = el.dataset.origText;
    }
  });
  // 「前 24h」card 比較期間 — 7d 模式下要說「前 7 日」
  document.querySelectorAll('[data-window-label-prev]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = isWeek ? '前 7 日聲量' : el.dataset.origText;
  });
  // 「今日新聞量」card 標題 — 7d 顯示「7 日新聞量」
  document.querySelectorAll('[data-window-label-news]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = isWeek ? '7 日新聞量' : el.dataset.origText;
  });
}

function initStreamClicks(){
  // 全域 event delegation — 處理「分鐘級 / 小時級 / 日級」按鈕點擊
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button.stream-btn');
    if (!btn) return;
    const kind = btn.dataset.stream;
    const es = state.eventStream || {};
    const arts = es[kind] || [];
    const titles = {
      minute: '🚨 分鐘級事件（紅燈 — 30 分鐘內回應）',
      hour:   '⚠️ 小時級事件（黃燈 — 當小時內擬回應）',
      day:    '📅 日級事件（綠燈 / 中性 — 日結時掃過）',
    };
    const notes = {
      minute: '刑事 / 公共安全 / 重大事件詞觸發 — 候選人或服務處主任應 30 分鐘內回應',
      hour:   '政治批評 / 環境問題詞觸發 — 當小時內擬好回應稿、決定要不要主動發',
      day:    '一般露出，不必個別回應 — 日結時掃過確認沒有遺漏即可',
    };
    openArticlesModal(titles[kind] || kind, notes[kind] || '', arts);
  });
}

function initLightTrendClicks(){
  const lt = document.getElementById('lightTrend');
  if (!lt || lt.dataset.boundClicks === '1') return;
  lt.dataset.boundClicks = '1';
  lt.addEventListener('click', (e) => {
    const btn = e.target.closest('button.light-item');
    if (!btn) return;
    const day = btn.dataset.day;
    const hour = btn.dataset.hour;
    if (day){
      const arts = (state.articles7d || []).filter(a => a.day === day);
      // dayWeekdayLabel 在 run() scope；這裡 inline 算一次
      const t = new Date(day + 'T00:00+08:00');
      const wd = ['日','一','二','三','四','五','六'][t.getDay()];
      openArticlesModal(`${day.slice(5)}（週${wd}） 燈號明細`, `當日所有與張嘉郡有關的事件`, arts);
    } else if (hour){
      const arts = (state.articles24h || []).filter(a => a.hour === hour);
      openArticlesModal(`${hour.slice(5, 16)} 燈號明細`, `該小時內所有與張嘉郡有關的事件`, arts);
    }
  });
}

function initModes(){
  const b24 = document.getElementById('mode24');
  const b7 = document.getElementById('mode7d');
  if(b24) b24.onclick = async ()=>{ mode='24h'; applyModeLabels(); await run(); };
  if(b7) b7.onclick = async ()=>{ mode='7d'; applyModeLabels(); await run(); };
  applyModeLabels();  // initial
}

initCollapsibles();
initLightTrendClicks();
initStreamClicks();
initMentionModal();
initHotspotDetailModal();
initPastEventsToggle();
initModes();
initModal();
initTopicHeat();
// run() interval — 第一次 run() 由下面 _firstRunThenSubscribe() 處理 (確保 Realtime
// subscribe 排在第一次 run() 之後)。
setInterval(() => run().catch(e => console.error('run() interval failed:', e)), 60000);

// --------- Real-time push (跟 TG 同步、不洗版) ---------
// 訂閱 notification_queue 表 — cron push_red_alerts 寫進來的、已 LLM dedup + cluster
// 每筆 = 1 個準備推一次的事件、shape 跟 TG message 對應、不會「同事件多家媒體」洗版
function initRealtimeToasts() {
  if (typeof LxyDB === 'undefined' || !LxyDB.subscribeNotifications) {
    console.log('[realtime] LxyDB.subscribeNotifications 未載入、跳過');
    return;
  }

  // 顯示 toast，最多並排 5 個
  const MAX_TOASTS = 5;
  const DISMISS_MS = 12000;
  function showToast(row) {
    const container = document.getElementById('rtToasts');
    if (!container) return;
    while (container.children.length >= MAX_TOASTS) {
      container.removeChild(container.firstChild);
    }
    const tNow = new Date().toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
    const level = row.severity || 'red';   // 'red' / 'yellow'
    const div = document.createElement('div');
    div.className = 'rt-toast ' + (level === 'yellow' ? 'rt-yellow' : '');
    const icon = level === 'yellow' ? '🟡' : '🔴';
    const cluster = row.cluster_count || 0;
    const bucket = row.bucket_label || (level === 'yellow' ? '新黃燈' : '新紅燈');
    const clusterTxt = cluster > 0 ? `（同議題另 ${cluster} 則）` : '';
    const linkUrl = row.short_url || row.url;
    const linkOk = isSafeExternalUrl(linkUrl);
    const metaText = linkOk
      ? `${row.publisher || row.platform || '—'} ｜ 點擊查看`
      : `${row.publisher || row.platform || '—'} ｜ (無有效連結)`;
    div.innerHTML = `
      <button class="rt-toast-close" aria-label="關閉">✕</button>
      <div class="rt-toast-header">
        <span class="rt-toast-icon">${icon}</span>
        <span>${escapeHtml(bucket)}${clusterTxt}</span>
        <span class="rt-toast-time">${tNow}</span>
      </div>
      <div class="rt-toast-title">${escapeHtml((row.title || '(無標題)').slice(0, 140))}</div>
      <div class="rt-toast-meta">${escapeHtml(metaText)}</div>
    `;
    if (!linkOk) div.classList.add('rt-toast-nolink');
    div.querySelector('.rt-toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
    if (linkOk) {
      div.addEventListener('click', () => window.open(linkUrl, '_blank', 'noopener'));
    }
    container.appendChild(div);
    requestAnimationFrame(() => div.classList.add('show'));
    function dismiss() {
      div.classList.remove('show');
      div.classList.add('dismiss');
      setTimeout(() => div.remove(), 400);
    }
    setTimeout(dismiss, DISMISS_MS);
  }

  LxyDB.subscribeNotifications((row) => {
    try {
      if (!row) return;
      showToast(row);   // queue 已 dedup、直接 toast 就好
    } catch (e) {
      console.warn('[realtime] toast 處理失敗:', e && e.message);
    }
  });
  console.log('%c[realtime] subscribed to notification_queue INSERT', 'color:#1f8a4c');
}
// ===========================================================================
// LLM feedback loop — Auth + correction modal
// ===========================================================================
const _auth = {
  user:    null,
  isAdmin: false,
  /** Map<"target_type|target_id", correction row> 給 UI render 「已修正」 badge 用 */
  corrections: new Map(),
};

function _corrKey(t, id) { return (t || '') + '|' + (id || ''); }

async function refreshCorrectionsCache() {
  try {
    const rows = await LxyDB.listCorrections();
    _auth.corrections.clear();
    // rows 按 created_at DESC 排序
    // 每 target 我們要兩件事：最新那筆 (給 chip 顯示) + 最舊那筆的 original_label (=真 LLM 原判)
    for (const r of rows) {
      const k = _corrKey(r.target_type, r.target_id);
      const cur = _auth.corrections.get(k);
      if (!cur) {
        // 第一次看到 = 最新一筆 (因為 DESC)
        _auth.corrections.set(k, { latest: r, true_original_label: r.original_label });
      } else {
        // 後續 row 越來越舊；持續覆寫 true_original_label、最終會是最舊那筆 (=真 LLM 原判)
        cur.true_original_label = r.original_label;
      }
    }
  } catch (e) {
    console.warn('[auth] corrections cache load failed:', e.message);
  }
}

function attachCorrectionAffordance(li, ctx) {
  // ctx: { target_type, target_id, original_label, context (string) }
  if (!li || !ctx || !ctx.target_id) return;
  // 寫到 dataset 上、之後 updateCorrectionAffordanceFor 才能透過 [data-target-id] 找到這個 li
  li.dataset.targetType    = ctx.target_type || '';
  li.dataset.targetId      = ctx.target_id || '';
  li.dataset.originalLabel = ctx.original_label || '';
  const entry = _auth.corrections.get(_corrKey(ctx.target_type, ctx.target_id));
  // entry shape: { latest: row, true_original_label: 'yellow' }
  const latest = entry?.latest;
  if (entry && latest) {
    const chip = document.createElement('span');
    const label = latest.corrected_label;
    chip.className = 'hd-news-corrected to-' + label;
    const emoji = label === 'red' ? '🔴' : (label === 'yellow' ? '🟡' : '🟢');
    chip.textContent = '已修正 → ' + emoji;
    const origEmoji = entry.true_original_label === 'red' ? '🔴' : (entry.true_original_label === 'yellow' ? '🟡' : '🟢');
    chip.title = `LLM 原判: ${origEmoji} ${entry.true_original_label || '?'}\n`
              + '由 ' + (latest.corrected_by || '?') + ' 在 ' + (latest.created_at || '').slice(0, 16) + ' 修正'
              + (latest.reason ? '\n原因：' + latest.reason : '');
    li.appendChild(chip);
  }
  if (!_auth.isAdmin) return;
  const flagBtn = document.createElement('button');
  flagBtn.type = 'button';
  flagBtn.className = 'hd-news-flag';
  flagBtn.textContent = entry ? '🚩 再修一次' : '🚩 標錯了';
  flagBtn.title = '修正 LLM 判讀的燈號';
  flagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCorrectionModal(ctx);
  });
  li.appendChild(flagBtn);
}

// --- Auth UI ---
function openAuthModal(tab) {
  const m = document.getElementById('authModal');
  if (!m) return;
  m.classList.remove('hidden');
  switchAuthTab(tab || 'login');
  document.getElementById('authError').textContent = '';
  document.getElementById('authNotice').textContent = '';
}
function closeAuthModal() {
  document.getElementById('authModal')?.classList.add('hidden');
}
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.authTab === tab));
  const submit = document.getElementById('authSubmit');
  if (submit) submit.textContent = tab === 'signup' ? '註冊' : '登入';
  const form = document.getElementById('authForm');
  if (form) form.dataset.tab = tab;
  document.getElementById('authPassword')?.setAttribute('autocomplete', tab === 'signup' ? 'new-password' : 'current-password');
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const tab = document.getElementById('authForm')?.dataset.tab || 'login';
  const email = document.getElementById('authEmail').value.trim();
  const pwd = document.getElementById('authPassword').value;
  const err = document.getElementById('authError');
  const note = document.getElementById('authNotice');
  err.textContent = ''; note.textContent = '';
  try {
    if (tab === 'signup') {
      await LxyDB.signUp(email, pwd);
      note.textContent = '註冊成功！請至 ' + email + ' 收信並確認後再登入。';
    } else {
      await LxyDB.signIn(email, pwd);
      closeAuthModal();
      // 登入閘：重載讓 dashboard 用已登入 session 重新打 RPC
      // （沒這行會停在登入前的 401 空畫面）
      location.reload();
    }
  } catch (e2) {
    err.textContent = e2.message || String(e2);
  }
}

async function refreshAuthBar() {
  const status = document.getElementById('authStatus');
  const loginBtn = document.getElementById('authLoginBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');
  if (!status) return;
  const user = _auth.user;
  if (user) {
    _auth.isAdmin = await LxyDB.isAdmin();
    status.classList.remove('auth-status-guest');
    status.classList.toggle('auth-status-admin', _auth.isAdmin);
    status.classList.toggle('auth-status-user', !_auth.isAdmin);
    status.textContent = (_auth.isAdmin ? '✓ admin · ' : '已登入 · ') + user.email;
    loginBtn.style.display = 'none';
    logoutBtn.style.display = '';
  } else {
    _auth.isAdmin = false;
    status.classList.add('auth-status-guest');
    status.classList.remove('auth-status-user', 'auth-status-admin');
    status.textContent = '未登入';
    loginBtn.style.display = '';
    logoutBtn.style.display = 'none';
  }
}

// --- Correction modal ---
let _pendingCorrection = null;
function openCorrectionModal(ctx) {
  if (!_auth.isAdmin) {
    openAuthModal('login');
    return;
  }
  // 若該 target 已被修過、ctx.original_label 是「現況」、不是「真 LLM 原判」
  // 從 cache 拉真 LLM 原判 (= 第一次 correction 的 original_label)
  const entry = _auth.corrections.get(_corrKey(ctx.target_type, ctx.target_id));
  const trueOrig  = entry?.true_original_label || ctx.original_label || 'green';
  const currState = entry?.latest?.corrected_label || ctx.original_label || 'green';
  // 寫進 pending 給 confirm + submit 用
  _pendingCorrection = Object.assign({}, ctx, {
    true_original_label: trueOrig,   // 拿來寫 DB 的 original_label
    current_state_label: currState,  // 拿來算 confirm 「從 X 改為 Y」的 X
  });
  const m = document.getElementById('correctionModal');
  if (!m) return;
  document.getElementById('correctionContext').textContent = ctx.context || '';
  // Modal 顯示「LLM 原判 + 現況」(若已修過、會不同)
  const origEmoji = _labelChip(trueOrig);
  const origEl = document.getElementById('correctionOriginal');
  if (origEl) {
    if (entry && trueOrig !== currState) {
      origEl.innerHTML = `${origEmoji} <span style="opacity:.7;font-size:12px">（現況: ${_labelChip(currState)}、已修過）</span>`;
    } else {
      origEl.textContent = origEmoji;
    }
  }
  // reset form
  document.querySelectorAll('input[name=corr_label]').forEach(r => { r.checked = false; });
  document.getElementById('correctionReason').value = '';
  document.getElementById('correctionError').textContent = '';
  m.classList.remove('hidden');
}
function closeCorrectionModal() {
  document.getElementById('correctionModal')?.classList.add('hidden');
  _pendingCorrection = null;
  // 重置回 form 狀態 (下次開時是新一次修正)
  showCorrectionForm();
}

// 第一步：表單 submit → 跳出確認頁
async function handleCorrectionSubmit(e) {
  e.preventDefault();
  if (!_pendingCorrection) return;
  const radio = document.querySelector('input[name=corr_label]:checked');
  const errEl = document.getElementById('correctionError');
  errEl.textContent = '';
  if (!radio) { errEl.textContent = '請選一個燈號'; return; }
  // 把資料先存起、跳到 confirm 頁；不直接寫 DB
  _pendingCorrection.corrected_label = radio.value;
  _pendingCorrection.reason = document.getElementById('correctionReason').value.trim();
  showCorrectionConfirm();
}

function _labelChip(en) {
  const map = { red: '🔴 紅燈', yellow: '🟡 黃燈', green: '🟢 綠燈' };
  return map[en] || (en || '?');
}

function showCorrectionConfirm() {
  const form = document.getElementById('correctionForm');
  const confirm = document.getElementById('correctionConfirm');
  if (!form || !confirm || !_pendingCorrection) return;
  // confirm 顯示「從 現況 改為 新選的」(不是真 LLM 原判、那只給 audit 用)
  const fromLabel = _pendingCorrection.current_state_label || _pendingCorrection.original_label;
  document.getElementById('correctionFromLabel').textContent = _labelChip(fromLabel);
  document.getElementById('correctionToLabel').textContent   = _labelChip(_pendingCorrection.corrected_label);
  form.style.display = 'none';
  confirm.style.display = '';
}

function showCorrectionForm() {
  document.getElementById('correctionConfirm').style.display = 'none';
  document.getElementById('correctionForm').style.display = '';
}

// 第二步：確認頁點「確定送出」→ 真的寫 DB
async function handleCorrectionConfirm() {
  if (!_pendingCorrection) return;
  const errEl = document.getElementById('correctionError');
  errEl.textContent = '';
  // original_label 永遠寫「真 LLM 原判」(若已修過、現況不是 LLM 原判、要從 cache 拿)
  // 這樣 audit query 不用 ORDER BY ASC、隨便挑該 target 任一筆 row 都能看到 LLM 原判
  const ctx = {
    target_type:    _pendingCorrection.target_type,
    target_id:      _pendingCorrection.target_id,
    original_label: _pendingCorrection.true_original_label || _pendingCorrection.original_label,
    corrected_label: _pendingCorrection.corrected_label,
    reason:         _pendingCorrection.reason || '',
  };
  try {
    const saved = await LxyDB.submitCorrection(ctx);
    // 更新 cache 為新 shape: { latest, true_original_label }
    // saved.original_label 就是真 LLM 原判 (我們上面確保的)、所以 true_original_label 就抄這值
    const k = _corrKey(saved.target_type, saved.target_id);
    const prev = _auth.corrections.get(k);
    _auth.corrections.set(k, {
      latest: saved,
      true_original_label: prev?.true_original_label || saved.original_label,
    });
    closeCorrectionModal();
    updateCorrectionAffordanceFor(ctx.target_type, ctx.target_id);
    refreshCorrectionsFeed().catch(() => {/* best-effort */});
  } catch (e2) {
    // 失敗時把 form 切回來、顯示錯誤
    showCorrectionForm();
    errEl.textContent = e2.message || String(e2);
  }
}

// 找出 DOM 上所有 target_id 命中的 <li>、移掉舊 chip/flag、重 render
function updateCorrectionAffordanceFor(targetType, targetId) {
  if (!targetId) return;
  let matched = 0;
  document.querySelectorAll('#hotspotDetailBody li').forEach(li => {
    if (li.dataset.targetId !== targetId) return;
    li.querySelectorAll('.hd-news-corrected, .hd-news-flag').forEach(n => n.remove());
    attachCorrectionAffordance(li, {
      target_type:    targetType,
      target_id:      targetId,
      original_label: li.dataset.originalLabel || null,
      context:        '',
    });
    matched += 1;
  });
  if (matched === 0) console.warn('[corrections] no <li> matched target_id=' + targetId);
}

// --- Recent corrections panel (Day 3) ---
let _correctionsFeedFilter = 'all';
let _correctionsFeedRows = [];

let _correctionsFeedLoadedCount = 50;   // 累積已 fetch 的最大筆數
async function refreshCorrectionsFeed(limit) {
  const panel = document.getElementById('correctionsFeedPanel');
  if (!panel) return;
  // 只有 admin 才看得到 panel；非 admin 直接 hide
  if (!_auth.isAdmin) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const fetchLimit = limit || _correctionsFeedLoadedCount;
  try {
    const c = LxyDB.client();
    const { data, error } = await c.rpc('recent_label_corrections', { limit_n: fetchLimit, target_type_filter: 'all' });
    if (error) throw error;
    _correctionsFeedRows = data || [];
    _correctionsFeedLoadedCount = fetchLimit;
    renderCorrectionsFeed();
  } catch (e) {
    console.warn('[corrections-feed] load failed:', e.message);
    document.getElementById('correctionsFeedBody').innerHTML = `<p class="hint">載入失敗：${escapeHtml(e.message || String(e))}</p>`;
  }
}

function renderCorrectionsFeed() {
  const body = document.getElementById('correctionsFeedBody');
  const stat = document.getElementById('correctionsFeedStat');
  if (!body) return;
  const rows = _correctionsFeedRows.filter(r =>
    _correctionsFeedFilter === 'all' || r.target_type === _correctionsFeedFilter
  );
  // active button styling
  document.querySelectorAll('[data-corr-filter]').forEach(b => {
    b.classList.toggle('active', b.dataset.corrFilter === _correctionsFeedFilter);
  });
  if (stat) {
    const evCount = _correctionsFeedRows.filter(r => r.target_type === 'event').length;
    const cmtCount = _correctionsFeedRows.filter(r => r.target_type === 'comment').length;
    stat.textContent = `共 ${_correctionsFeedRows.length} 筆（新聞 ${evCount}、留言 ${cmtCount}）`;
  }
  if (!rows.length) {
    body.innerHTML = '<p class="hint">尚無修正紀錄</p>';
    return;
  }
  const labelEmoji = en => en === 'red' ? '🔴' : en === 'yellow' ? '🟡' : en === 'green' ? '🟢' : '?';
  body.innerHTML = rows.map(r => `
    <div class="corr-item">
      <div class="corr-row1">
        <span class="corr-type-${r.target_type}">${r.target_type === 'event' ? '新聞' : '留言'}</span>
        <span>${labelEmoji(r.original_label)} ${r.original_label}</span>
        <span class="corr-arrow">→</span>
        <span>${labelEmoji(r.corrected_label)} ${r.corrected_label}</span>
        <span class="corr-meta">${(r.created_at || '').slice(0, 16)}</span>
      </div>
      <div class="corr-text">${escapeHtml((r.text_content || '').slice(0, 200))}</div>
      ${r.reason ? `<div class="corr-reason">${escapeHtml(r.reason)}</div>` : ''}
    </div>
  `).join('');
  // 載入更多按鈕：如果當前 fetch 滿 limit、就提示可能還有
  // (rows.length 是 filter 過的、_correctionsFeedRows 是 fetch 回來的、用後者判斷)
  if (_correctionsFeedRows.length >= _correctionsFeedLoadedCount) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'platform-more-btn';
    btn.textContent = `載入更多（已顯示 ${_correctionsFeedRows.length} 筆）`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '載入中…';
      const newLimit = _correctionsFeedLoadedCount + 50;
      await refreshCorrectionsFeed(newLimit);
    });
    body.appendChild(btn);
  }
}

// --- bootstrap ---
async function initAuthUI() {
  // wire up buttons
  document.getElementById('authLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('authLogoutBtn')?.addEventListener('click', async () => {
    try { await LxyDB.signOut(); } catch (e) { console.warn(e); }
  });
  document.querySelectorAll('[data-close-auth]').forEach(el => el.addEventListener('click', closeAuthModal));
  document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => switchAuthTab(t.dataset.authTab)));
  document.getElementById('authForm')?.addEventListener('submit', handleAuthSubmit);
  document.querySelectorAll('[data-close-correction]').forEach(el => el.addEventListener('click', closeCorrectionModal));
  document.getElementById('correctionForm')?.addEventListener('submit', handleCorrectionSubmit);
  document.getElementById('correctionCancelBtn')?.addEventListener('click', showCorrectionForm);
  document.getElementById('correctionConfirmBtn')?.addEventListener('click', handleCorrectionConfirm);
  // recent corrections panel filter buttons
  document.querySelectorAll('[data-corr-filter]').forEach(b => {
    b.addEventListener('click', () => {
      _correctionsFeedFilter = b.dataset.corrFilter;
      renderCorrectionsFeed();
    });
  });
  // init session
  _auth.user = await LxyDB.getUser();
  // 登入閘：zjg 是團隊內部 dashboard、沒登入就跳登入框（資料層 RLS 也擋、雙保險）
  if (!_auth.user) {
    openAuthModal('login');
  }
  await refreshCorrectionsCache();
  await refreshAuthBar();
  await refreshCorrectionsFeed();
  // listen for login/logout
  LxyDB.onAuthChange(async (event, session) => {
    _auth.user = session ? session.user : null;
    await refreshCorrectionsCache();
    await refreshAuthBar();
    await refreshCorrectionsFeed();
  });
}
initAuthUI().catch(e => console.error('initAuthUI failed:', e));

// 第一次 run()
run().catch(e => console.error('run() failed:', e));

// === Realtime subscribe — DISABLED (Supabase quirk 未修通) ===
// 試過：unique channel name / 獨立 client / wait load / 5-30 秒 delay /
//      user-interaction trigger / event=* / 訂 notification_queue vs social_events
// 全部一樣：channel state=joined 但 events 不來。同 lib eval 後再訂閱卻能收。
// 需要 deep dive 看 WebSocket phx 訊息找 root cause。詳見 docs/MIGRATION_PLAYBOOK.md。
//
// 已建好但 disabled：
//   - notification_queue table + Realtime publication + RLS
//   - cron push_red_alerts 寫 queue (best-effort dual-write、不影響 TG)
//   - lib/db.js subscribeNotifications API
//   - toast UI / CSS / filter logic
//
// 修通那行 quirk 後、uncomment 下面就立刻運作：
// initRealtimeToasts();
