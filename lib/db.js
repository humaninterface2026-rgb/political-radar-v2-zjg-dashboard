// dashboard/lib/db.js
// 前端讀 Supabase 的 wrapper，掛到 window.LxyDB 全域。
//
// 設計：
//   - 跟現有 fetchJSON('./xxx.json') 並存、不替換。先讓兩邊資料形狀對得起來。
//   - 每個方法回傳的形狀盡量跟對應的 JSON 檔一致，未來 app.js 切換時不用改太多
//     consumer 程式碼。
//   - 失敗（網路、RLS 擋住、table 不存在）都會 throw，呼叫端可以 try/catch
//     fallback 回 flat JSON。
//
// 依賴（要先載入）：
//   1. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD，提供 window.supabase)
//   2. ./lib/config.js    (定義 window.LxyConfig)
//
// 用法（瀏覽器）：
//   const db = LxyDB.client();
//   const comments = await LxyDB.recentComments('facebook', 50);
//   const signals  = await LxyDB.signalsByPlatform();

(function (root) {
  'use strict';

  const PLATFORM_KEYS = ['facebook', 'instagram', 'threads'];

  // -----------------------------------------------------------------------
  // Client 初始化（lazy + cached）
  // -----------------------------------------------------------------------
  let _client = null;
  function client() {
    if (_client) return _client;
    if (typeof root.supabase === 'undefined' || !root.supabase.createClient) {
      throw new Error(
        'supabase-js UMD 沒載入。請在 db.js 前面加：\n' +
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
      );
    }
    const cfg = root.LxyConfig;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error('window.LxyConfig 沒設好（lib/config.js 應該先載入）');
    }
    _client = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,        // LLM feedback loop 要持續登入 state
        autoRefreshToken: true,
        storage: window.localStorage,
        storageKey: 'lxy-auth',
      },
      realtime: { params: { eventsPerSecond: 5 } },
    });
    return _client;
  }

  // -----------------------------------------------------------------------
  // 1. 留言：對應 comments_facebook.json / comments_instagram.json / comments_threads.json
  //    回傳 list of {author, text, signal, signal_zh, signal_score, time_text, url, kind}
  // -----------------------------------------------------------------------
  async function recentComments(platform, limit, hoursBack) {
    if (typeof limit !== 'number') limit = 100;
    const PAGE = 1000;  // PostgREST default max_rows on Supabase hosted — request more is silently capped
    const c = client();
    const cutoff = (typeof hoursBack === 'number' && hoursBack > 0)
      ? new Date(Date.now() - hoursBack * 3600 * 1000).toISOString()
      : null;
    const out = [];
    let from = 0;
    while (out.length < limit) {
      const want = Math.min(PAGE, limit - out.length);
      let q = c
        .from('social_comments')
        // comment_id needed so dashboard 標錯了 modal can target the row
        // (matches signals_by_platform's first_seen_at-based window — keeps
        //  card total ≡ modal count when hoursBack matches).
        .select('comment_id, author, text, signal, signal_zh, signal_score, time_text, url, kind, first_seen_at')
        .eq('platform', platform);
      if (cutoff) q = q.gte('first_seen_at', cutoff);
      const { data, error } = await q
        .order('first_seen_at', { ascending: false })
        .range(from, from + want - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) out.push(r);
      from += data.length;
      if (data.length < want) break;  // tail of result set — no more rows to fetch
    }
    return out.map(function (r) {
      const { first_seen_at, ...rest } = r;
      return rest;
    });
  }

  // -----------------------------------------------------------------------
  // 2. 燈號統計：對應 social_signals.json
  //    aggregation 在 client 端做（1.4K rows、輕量）
  //    回傳 { facebook: {red, yellow, green, total, *_pct, updated_at}, ig: {...}, threads: {...} }
  // -----------------------------------------------------------------------
  async function signalsByPlatform(windowHours) {
    // 走 Postgres RPC（migration 004 建的 signals_by_platform(hours_back)），server-side
    // 聚合、跳過 PostgREST 預設 1000 row limit。
    //
    // 參數 windowHours:
    //   undefined / 不傳   → 預設 24h，對齊現有「最近一批 scrape」UI 語意
    //   數字               → 算最近 N 小時
    //   null               → 不限時，全表累積
    //
    // 回傳 shape：{ facebook: {total, red, yellow, green, *_pct, updated_at, window_hours}, ... }
    const c = client();
    const params = (windowHours === undefined) ? {} : { hours_back: windowHours };
    const { data, error } = await c.rpc('signals_by_platform', params);
    if (error) throw error;
    // 補齊三個平台 key（即使 DB 那邊某平台沒資料也回空 bucket，避免下游讀到 undefined）
    const out = {};
    PLATFORM_KEYS.forEach(function (p) {
      out[p] = (data && data[p]) || {
        total: 0, red: 0, yellow: 0, green: 0,
        red_pct: 0, yellow_pct: 0, green_pct: 0,
        updated_at: null, window_hours: windowHours,
      };
    });
    return out;
  }

  // -----------------------------------------------------------------------
  // 3. 事件 (文章/貼文)：對應 social_events 部分查詢
  //    options: { platform, status='active', sinceHours, limit=200 }
  // -----------------------------------------------------------------------
  async function recentEvents(options) {
    options = options || {};
    const limit  = options.limit  || 200;
    const status = options.status || 'active';
    let q = client()
      .from('social_events')
      .select('event_id, platform, source_id, author_name, title, text, published_at, url, risk_level, severity_llm, matched_keywords')
      .eq('status', status)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (options.platform) q = q.eq('platform', options.platform);
    if (options.sinceHours) {
      const cutoff = new Date(Date.now() - options.sinceHours * 3600 * 1000).toISOString();
      q = q.gte('published_at', cutoff);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 4. 留言歷史 archive：對應 comments_archive 部分查詢
  // -----------------------------------------------------------------------
  async function archiveByDate(platform, dateStr) {
    const c = client();
    const { data, error } = await c
      .from('comments_archive')
      .select('author, text, signal, signal_zh, signal_score, url, kind, time_text, published_at, scrape_at')
      .eq('platform', platform)
      .eq('published_date', dateStr)
      .order('scrape_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 5. Sources：對應 sources list
  // -----------------------------------------------------------------------
  async function listSources(enabledOnly) {
    const c = client();
    let q = c.from('sources').select('source_id, platform, name, category, priority, enabled, dedup_group');
    if (enabledOnly) q = q.eq('enabled', true);
    // sources 目前 37 rows、不太可能超過 PostgREST 預設 1000 上限，但顯式設防範未來成長
    const { data, error } = await q
      .order('platform')
      .order('priority')
      .range(0, 4999);
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 6. Hotspots：對應 hotspots table（每日議題熱點）
  // -----------------------------------------------------------------------
  async function listHotspots(daysBack) {
    if (typeof daysBack !== 'number') daysBack = 14;
    const cutoff = new Date(Date.now() - daysBack * 86400000)
      .toISOString().slice(0, 10);
    const c = client();
    const { data, error } = await c
      .from('hotspots')
      .select('hotspot_id, date, topic, keywords, event_count, comment_count, red_count, intensity, metadata, generated_at')
      .gte('date', cutoff)
      .order('date', { ascending: false })
      .order('intensity', { ascending: false, nullsFirst: false })
      .range(0, 4999);   // 14d * ~10 hotspots/day << 5K，安全
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 7. Health probe — 簡單戳一下表確認連得到
  // -----------------------------------------------------------------------
  async function ping() {
    const c = client();
    const t0 = performance.now();
    const { error, count } = await c
      .from('sources')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return {
      ok: true,
      sources_count: count,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }

  // -----------------------------------------------------------------------
  // 8. Realtime subscribe (給未來推播用、Phase B 才接)
  //    傳 onInsert(callback) 訂閱 social_events 新進；回傳 unsubscribe fn。
  // -----------------------------------------------------------------------
  // Realtime 用獨立的 client instance — 避免跟 RPC 的 client 共用 WebSocket
  // 觀察到的怪 bug：主 client 在 page init 大量 RPC 期間訂閱 Realtime、
  // server-side dedup 似乎會把 binding "蓋掉"、即使 state=joined 也收不到 events
  let _realtimeClient = null;
  function subscribeNewEvents(onInsert) {
    if (!_realtimeClient) {
      if (typeof root.supabase === 'undefined' || !root.supabase.createClient) {
        throw new Error('supabase-js UMD 沒載入');
      }
      const cfg = root.LxyConfig;
      _realtimeClient = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });
    }
    const channelName = 'events-stream-' + Date.now();
    const channel = _realtimeClient
      .channel(channelName)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'social_events' },   // '*' instead of INSERT
          function (payload) {
            if (payload.eventType === 'INSERT' || payload.event === 'INSERT') {
              onInsert(payload.new);
            }
          })
      .subscribe(function (status) {
        if (typeof console !== 'undefined' && console.log) {
          console.log('[LxyDB realtime] ' + channelName + ' → ' + status);
        }
      });
    return function () { _realtimeClient.removeChannel(channel); };
  }

  // 訂閱 notification_queue (cron push_red_alerts 寫進來的、已 dedup/cluster)
  // 跟 TG 通知同步、不洗版。Toast 用這個、不用 subscribeNewEvents。
  function subscribeNotifications(onInsert) {
    if (!_realtimeClient) {
      if (typeof root.supabase === 'undefined' || !root.supabase.createClient) {
        throw new Error('supabase-js UMD 沒載入');
      }
      const cfg = root.LxyConfig;
      _realtimeClient = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });
    }
    const channelName = 'notification-queue-' + Date.now();
    const channel = _realtimeClient
      .channel(channelName)
      .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notification_queue' },
          function (payload) { onInsert(payload.new); })
      .subscribe(function (status) {
        if (typeof console !== 'undefined' && console.log) {
          console.log('[LxyDB notif] ' + channelName + ' → ' + status);
        }
      });
    return function () { _realtimeClient.removeChannel(channel); };
  }

  // -----------------------------------------------------------------------
  // 9. Dashboard RPCs — 取代 data.json 的 server-side aggregation
  //    每個 wrapper 配 5 分鐘 client cache (per-query)。
  //    Cache key 包含參數、所以 mode24h / mode7d 切換不會互蓋。
  // -----------------------------------------------------------------------
  const _rpcCache = new Map();
  const RPC_CACHE_TTL_MS = 5 * 60 * 1000;
  function _cachedRpc(name, params) {
    const key = name + '|' + JSON.stringify(params || {});
    const hit = _rpcCache.get(key);
    if (hit && (Date.now() - hit.t) < RPC_CACHE_TTL_MS) return Promise.resolve(hit.data);
    return client().rpc(name, params || {}).then(function (r) {
      if (r.error) throw r.error;
      _rpcCache.set(key, { t: Date.now(), data: r.data });
      return r.data;
    });
  }
  function clearRpcCache() { _rpcCache.clear(); }

  async function dashboardMetrics(hoursBack) {
    return _cachedRpc('dashboard_metrics', { hours_back: hoursBack || 24 });
  }
  async function dashboardByHour(hoursBack) {
    return _cachedRpc('dashboard_by_hour', { hours_back: hoursBack || 24 });
  }
  async function dashboardTopNews(hoursBack, limit) {
    return _cachedRpc('dashboard_top_news',
      { hours_back: hoursBack || 24, limit_n: limit || 20 });
  }
  async function dashboardLatestByPlatform(platform, hoursBack, limit) {
    return _cachedRpc('dashboard_latest_by_platform', {
      platform_name: platform,
      hours_back: (hoursBack === undefined) ? null : hoursBack,
      limit_n: limit || 20,
    });
  }
  async function dashboardHotspots(daysBack, limit) {
    return _cachedRpc('dashboard_hotspots',
      { days_back: daysBack || 14, limit_n: limit || 50 });
  }

  // Tier 2a — articles + by_platform
  async function dashboardArticles(hoursBack, prevWindow) {
    return _cachedRpc('dashboard_articles', {
      hours_back: hoursBack || 24,
      prev_window: !!prevWindow,
    });
  }
  async function dashboardByPlatform(hoursBack, mentionOnly) {
    return _cachedRpc('dashboard_by_platform', {
      hours_back: hoursBack || 24,
      mention_only: !!mentionOnly,
    });
  }

  // Tier 2b — 一個 RPC 拿 3 個資料形狀:
  //   - mention_articles  (per-person article lists)
  //   - voice_breakdown   (per-person red/yellow/green counts)
  //   - mention_compare   (per-person totals)
  async function dashboardPersonsSummary(hoursBack) {
    return _cachedRpc('dashboard_persons_summary', {
      hours_back: hoursBack || 24,
    });
  }

  // Tier 3 — comments_by_date / topic_narrative_arc / media_framing
  async function dashboardCommentsByDate(daysBack) {
    return _cachedRpc('dashboard_comments_by_date', { days_back: daysBack || 7 });
  }
  async function dashboardTopicNarrativeArc(daysBack) {
    return _cachedRpc('dashboard_topic_narrative_arc', { days_back: daysBack || 7 });
  }
  async function dashboardMediaFraming(hoursBack) {
    return _cachedRpc('dashboard_media_framing', { hours_back: hoursBack || 168 });
  }

  // Tier 3b — favorability + person sections
  async function dashboardSelfFavorabilityHistory(daysBack) {
    return _cachedRpc('dashboard_self_favorability_history', { days_back: daysBack || 7 });
  }
  async function dashboardPersonSections(newsN, fbN) {
    return _cachedRpc('dashboard_person_sections', {
      news_n: newsN || 20,
      fb_n:   fbN || 20,
    });
  }

  // -----------------------------------------------------------------------
  // Auth + LLM feedback loop helpers (migration 013)
  // -----------------------------------------------------------------------

  // 取得目前 session (null = 沒登入)
  async function getSession() {
    const c = client();
    const { data, error } = await c.auth.getSession();
    if (error) { console.warn('[auth] getSession err:', error.message); return null; }
    return data.session;
  }

  async function getUser() {
    const s = await getSession();
    return s ? s.user : null;
  }

  // Email + password 登入
  async function signIn(email, password) {
    const c = client();
    const { data, error } = await c.auth.signInWithPassword({ email: email, password: password });
    if (error) throw error;
    return data.user;
  }

  // Email + password 註冊 (註冊後 Supabase 預設會寄確認信、確認完才能登入)
  async function signUp(email, password) {
    const c = client();
    const { data, error } = await c.auth.signUp({ email: email, password: password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    const c = client();
    const { error } = await c.auth.signOut();
    if (error) throw error;
  }

  // 確認目前登入 email 是否在 admin_emails table
  let _adminEmailCache = null;
  async function isAdmin() {
    const user = await getUser();
    if (!user || !user.email) return false;
    if (_adminEmailCache === null) {
      try {
        const c = client();
        const { data, error } = await c.from('admin_emails').select('email');
        if (error) throw error;
        _adminEmailCache = new Set((data || []).map(r => (r.email || '').toLowerCase()));
      } catch (e) {
        console.warn('[auth] isAdmin lookup failed:', e.message);
        return false;
      }
    }
    return _adminEmailCache.has(user.email.toLowerCase());
  }

  // 訂閱 auth 變化 (login / logout) — 給 UI 重 render
  function onAuthChange(cb) {
    const c = client();
    return c.auth.onAuthStateChange((event, session) => {
      _adminEmailCache = null;   // 換人就 invalidate cache
      cb(event, session);
    });
  }

  // 寫一筆 LLM label 修正
  async function submitCorrection(row) {
    // row: { target_type, target_id, original_label, corrected_label, reason?, llm_model?, llm_prompt_version? }
    const user = await getUser();
    if (!user || !user.email) throw new Error('需要登入');
    const c = client();
    const insert = {
      target_type:        row.target_type,
      target_id:          row.target_id,
      original_label:     row.original_label || null,
      corrected_label:    row.corrected_label,
      reason:             row.reason || null,
      corrected_by:       user.email,
      llm_model:          row.llm_model || null,
      llm_prompt_version: row.llm_prompt_version || null,
    };
    const { data, error } = await c.from('llm_label_corrections').insert(insert).select().single();
    if (error) throw error;
    return data;
  }

  // 拉所有現有 corrections (給 UI 渲染 「已修正」 badge — 比對 target_type+target_id)
  async function listCorrections(targetType) {
    const c = client();
    let q = c.from('llm_label_corrections').select('*');
    if (targetType) q = q.eq('target_type', targetType);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------
  root.LxyDB = {
    client:                   client,
    recentComments:           recentComments,
    signalsByPlatform:        signalsByPlatform,
    recentEvents:             recentEvents,
    archiveByDate:            archiveByDate,
    listSources:              listSources,
    listHotspots:             listHotspots,
    ping:                     ping,
    subscribeNewEvents:       subscribeNewEvents,
    subscribeNotifications:   subscribeNotifications,
    // Auth + LLM feedback loop (migration 013)
    getSession:               getSession,
    getUser:                  getUser,
    signIn:                   signIn,
    signUp:                   signUp,
    signOut:                  signOut,
    isAdmin:                  isAdmin,
    onAuthChange:             onAuthChange,
    submitCorrection:         submitCorrection,
    listCorrections:          listCorrections,
    // Migration 005 — dashboard RPCs (Tier 1)
    dashboardMetrics:         dashboardMetrics,
    dashboardByHour:          dashboardByHour,
    dashboardTopNews:         dashboardTopNews,
    dashboardLatestByPlatform: dashboardLatestByPlatform,
    dashboardHotspots:        dashboardHotspots,
    // Migration 006 — Tier 2a
    dashboardArticles:        dashboardArticles,
    dashboardByPlatform:      dashboardByPlatform,
    // Migration 007 — Tier 2b (4-person compare)
    dashboardPersonsSummary:  dashboardPersonsSummary,
    // Migration 008 — Tier 3 (comments-by-date / topic-arc / media-framing)
    dashboardCommentsByDate:  dashboardCommentsByDate,
    dashboardTopicNarrativeArc: dashboardTopicNarrativeArc,
    dashboardMediaFraming:    dashboardMediaFraming,
    // Migration 009 — Tier 3b (favorability + person sections)
    dashboardSelfFavorabilityHistory: dashboardSelfFavorabilityHistory,
    dashboardPersonSections:  dashboardPersonSections,
    clearRpcCache:            clearRpcCache,
  };
})(typeof window !== 'undefined' ? window : globalThis);
