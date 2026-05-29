// dashboard/lib/config.js
// Supabase 公開連線參數（前端用 anon key，RLS 擋掉寫入；可以安全放在 client）
//
// 別放 service_role key 到這裡！
// service_role key 只能放 .env、給 cron 用、走後端。
//
// 怎麼確認自己拿的是 anon 不是 service：
//   - anon key 開頭通常是 'sb_publishable_...' 或 'eyJ...' 但 role 欄位是 "anon"
//   - service_role 開頭也是 'eyJ...' 但 role 欄位是 "service_role"
//   - 想驗：到 https://jwt.io 貼進去看 payload.role
(function (root) {
  root.LxyConfig = {
    // === 後端連線（zjg 專用 Supabase project）===
    SUPABASE_URL:      'https://ygcdqicgmvmyzhodfihn.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_Xrjp9JPPbtXLPdCyDoo1ug_kTnJXpzW',

    // === 客戶身分（張嘉郡 / 雲林）===
    CUSTOMER: {
      // 政治人物名 — 顯示在 dashboard 標題 + filter 用
      NAME:        '張嘉郡',
      // 別名 (substring) — 用來偵測「文章是否提及該人」
      ALIASES:     ['張嘉郡', '嘉郡', '嘉郡張'],
      // Dashboard title — 顯示在 <title> 跟 <h1>
      DASHBOARD_TITLE: '雲林政治戰情儀表板（張嘉郡）',
      // 比對的競品政治人物 — mention_compare / voice_breakdown 用
      COMPARE_TARGETS: ['劉建國'],
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
