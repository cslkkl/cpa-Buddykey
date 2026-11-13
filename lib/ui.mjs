/**
 * BuddyKey 管理页 —— Apple 极简风，单文件静态资源（零依赖，纯字符串）。
 *
 * 三个占位符由 `server.mjs` 在响应前替换：
 *   - `__LAN_HINT__`   这台机器的局域网地址（手机要填的那个）
 *   - `__MODELS__`     允许的模型别名列表
 *   - `__UPDATE_TEXT__` 上游版本判定的纯函数源码（从 lib/update-text.mjs 现读现注入）
 *
 * ⚠️ 本文件是 **模板字面量**：页面里的客户端脚本刻意不用模板字符串、
 *    不用反引号、不用反斜杠转义 —— 否则会在这一层被消费掉。
 *    `__MODELS__` 只出现一次（页脚），`__LAN_HINT__` 只出现一次（页脚）。
 *
 * ⚠️ **注释里也不能出现反引号**（包括正文注释，不只是 JSDoc）。写了一个会提前
 *    结束模板字符串；更坏的是两个反引号会恰好配对、`node --check` 照样通过，
 *    页面却被截断且看不出来。所以 tools/check-ui.mjs 直接断言 PAGE 的首尾
 *    与占位符次数 —— 数反引号总数不可靠（JSDoc 里本来就有一堆）。
 */

export const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="light dark"/>
<title>API Keys · workbuddy 积分池</title>
<style>
  :root{
    color-scheme:light dark;
    --bg:#fbfbfd; --card:#fff; --hairline:#e8e8ed; --ink:#1d1d1f; --muted:#86868b;
    --accent:#0071e3; --accent-soft:rgba(0,113,227,.10); --danger:#ff3b30;
    --fill:rgba(0,0,0,.045); --shadow:0 1px 3px rgba(0,0,0,.06), 0 18px 40px rgba(0,0,0,.06);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#000; --card:#1c1c1e; --hairline:#2c2c2e; --ink:#f5f5f7; --muted:#98989d;
      --accent:#0a84ff; --accent-soft:rgba(10,132,255,.16); --danger:#ff3b30;
      --fill:rgba(255,255,255,.08);
      --shadow:0 1px 3px rgba(0,0,0,.6), 0 22px 48px rgba(0,0,0,.55);
    }
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .shell{max-width:1060px;margin:0 auto;padding:44px 24px 72px}

  /* ── 头部 ── */
  .hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:24px}
  .hero h1{margin:0;font-size:30px;font-weight:600;letter-spacing:-.022em}
  .hero .sub-line{margin:6px 0 0}
  .hero-actions{display:flex;gap:10px;flex-wrap:wrap}

  /* ── 按钮：全圆角 ── */
  .btn{
    font:inherit;font-size:13.5px;line-height:1;padding:11px 19px;border-radius:999px;
    border:1px solid var(--hairline);background:var(--card);color:var(--ink);
    cursor:pointer;white-space:nowrap;
    transition:background .18s,border-color .18s,opacity .18s,filter .18s;
  }
  .btn:hover:not(:disabled){border-color:var(--muted)}
  .btn:disabled{opacity:.45;cursor:default}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.primary:hover:not(:disabled){filter:brightness(1.07)}
  .btn.tiny{padding:6px 12px;font-size:12.5px}
  .btn.subtle{background:transparent;border-color:transparent;color:var(--muted)}
  .btn.subtle:hover:not(:disabled){color:var(--ink);background:var(--fill);border-color:transparent}
  .btn.danger{color:var(--danger)}
  .btn.danger:hover:not(:disabled){border-color:var(--danger)}

  /* ── 池子概况 ── */
  .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px}
  .stat{background:var(--card);border:1px solid var(--hairline);border-radius:18px;padding:15px 18px}
  .stat .k{color:var(--muted);font-size:12.5px}
  .stat .v{margin-top:5px;font-size:19px;font-weight:600;letter-spacing:-.01em;word-break:break-word}

  /* ── 分段控件 ── */
  .segmented{display:inline-flex;gap:2px;padding:3px;background:var(--fill);border-radius:999px;margin-bottom:18px}
  .seg{
    font:inherit;font-size:13.5px;padding:8px 20px;border:0;border-radius:999px;
    background:transparent;color:var(--muted);cursor:pointer;
    transition:background .18s,color .18s,box-shadow .18s;
  }
  .seg[aria-selected="true"]{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.12)}

  /* ── 卡片 ── */
  .card{background:var(--card);border:1px solid var(--hairline);border-radius:18px;overflow:hidden;margin-bottom:18px}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:17px 20px 13px}
  .card-head h2{margin:0;font-size:15px;font-weight:600}
  .meta{color:var(--muted);font-size:12.5px}
  .head-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}

  /* ── 表格：无竖线，只有横向 hairline ── */
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  thead th{
    text-align:left;font-weight:500;color:var(--muted);font-size:12.5px;
    padding:9px 20px;border-bottom:1px solid var(--hairline);white-space:nowrap;
  }
  thead th.align-right{text-align:right}
  tbody td{padding:14px 20px;border-bottom:1px solid var(--hairline);vertical-align:middle;word-break:break-word}
  tbody tr:last-child td{border-bottom:0}
  .row:hover{background:var(--fill)}
  td.empty{padding:30px 20px;text-align:center;color:var(--muted)}

  .name-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:500}
  .badge{
    font-size:11px;font-weight:500;padding:2px 9px;border-radius:999px;
    background:var(--accent-soft);color:var(--accent);white-space:nowrap;
  }
  .badge.off{background:var(--fill);color:var(--muted)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}
  .muted{color:var(--muted)}
  .sub-line{color:var(--muted);font-size:12.5px;margin:6px 20px}
  .ops{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}

  /* ── 开关 ── */
  .switch{position:relative;display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none}
  .switch input{position:absolute;opacity:0;width:1px;height:1px}
  .track{position:relative;flex:0 0 auto;width:40px;height:24px;border-radius:999px;background:#d2d2d7;transition:background .18s}
  .track:after{
    content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .18s;
  }
  .switch input:checked + .track{background:var(--accent)}
  .switch input:checked + .track:after{transform:translateX(16px)}
  .switch input:disabled + .track{opacity:.5}
  .switch-text{color:var(--muted);font-size:12px}
  .switch-text:empty{display:none}
  @media (prefers-color-scheme: dark){ .track{background:#3a3a3c} }

  /* ── 提示条：错误一律就地红字 ── */
  .notice{margin:0 0 16px;padding:12px 14px;border-radius:14px;background:var(--fill);color:var(--muted);font-size:13px}
  .notice.error{color:var(--danger);background:rgba(255,59,48,.09)}
  .card > .notice{margin:0 20px 16px}
  .sheet-body > .notice{margin:0}
  .foot-note{color:var(--muted);font-size:12.5px;line-height:1.7;margin:0 2px 18px}

  /* ── 首次上手引导 ── */
  .setup-card{border-color:color-mix(in srgb, var(--accent) 34%, var(--hairline))}
  .setup-list{
    list-style:none;margin:4px 20px 14px;padding:0;
    display:flex;flex-direction:column;gap:10px;
  }
  .setup-list li{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.6}
  .setup-list .step-mark{
    flex:0 0 auto;width:18px;height:18px;margin-top:1px;border-radius:999px;
    display:inline-flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-soft);
  }
  .setup-list li.done .step-mark{color:#fff;background:var(--accent)}
  .setup-list li.done .step-text{color:var(--muted)}
  .setup-list .step-body{min-width:0}
  .setup-list .step-code{
    display:block;margin-top:4px;padding:7px 9px;border-radius:9px;background:var(--fill);
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
    word-break:break-all;color:var(--ink);
  }

  /* ── 完整 key / 登录链接 ── */
  .key-line{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 20px 8px}
  .key-value{
    flex:1 1 240px;min-width:0;padding:11px 13px;border-radius:12px;background:var(--fill);
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;
  }

  /* ── 弹层 ── */
  .overlay{
    position:fixed;inset:0;z-index:40;display:flex;align-items:flex-start;justify-content:center;
    padding:24px;background:rgba(0,0,0,.34);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
    overflow-y:auto;
  }
  .overlay[hidden]{display:none}
  .sheet{width:100%;max-width:520px;margin:auto;background:var(--card);border:1px solid var(--hairline);border-radius:18px;box-shadow:var(--shadow)}
  .sheet-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 6px}
  .sheet-head h2{margin:0;font-size:16px;font-weight:600}
  .sheet-body{display:flex;flex-direction:column;gap:16px;padding:6px 20px 8px}
  .sheet-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px 20px}
  .sheet.narrow{max-width:420px}
  .field{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;border:0;min-width:0}
  .field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .label{color:var(--muted);font-size:12.5px;padding:0}
  input[type="text"],input[type="number"]{
    font:inherit;font-size:14px;width:100%;padding:11px 13px;border-radius:12px;
    border:1px solid var(--hairline);background:var(--bg);color:var(--ink);
    transition:border-color .18s,box-shadow .18s;
  }
  input[type="text"]:focus,input[type="number"]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .scope-modes{display:flex;gap:8px;flex-wrap:wrap}
  .radio{
    display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:999px;
    border:1px solid var(--hairline);cursor:pointer;font-size:13.5px;
  }
  .radio:has(input:checked){border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
  .radio input{accent-color:var(--accent);margin:0}
  .picker{border:1px solid var(--hairline);border-radius:14px;overflow:hidden}
  .picker-head{
    display:flex;align-items:center;gap:8px;padding:9px 12px;
    border-bottom:1px solid var(--hairline);background:var(--fill);font-size:12.5px;color:var(--muted);
  }
  .picker-head .grow{flex:1 1 auto;min-width:0}
  .picker-list{max-height:216px;overflow-y:auto}
  .picker-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--hairline);font-size:13.5px;cursor:pointer}
  .picker-row:last-child{border-bottom:0}
  .picker-row input{accent-color:var(--accent);margin:0;flex:0 0 auto}
  .picker-row .nick{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hint{color:var(--muted);font-size:12px}

  .footer{color:var(--muted);font-size:12.5px;line-height:1.9;padding-top:6px}
  .footer p{margin:0}

  /* ── 连通状态：能不能用，一眼看见 ── */
  .health{
    background:var(--card);border:1px solid var(--hairline);border-radius:18px;
    padding:16px 20px;margin-bottom:22px;
  }
  .health-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .health-head h2{margin:0;font-size:15px;font-weight:600}
  .health-head .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .health-rows{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}
  .health-item{min-width:0}
  .health-item .k{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12.5px}
  .health-item .v{margin-top:6px;font-size:13.5px;line-height:1.55;word-break:break-word}
  .health-item .v.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;background:var(--muted)}
  .dot.ok{background:#30d158}
  .dot.bad{background:var(--danger)}
  .dot.idle{background:#c7c7cc}
  .health-foot{
    margin-top:14px;padding-top:12px;border-top:1px solid var(--hairline);
    color:var(--muted);font-size:12px;line-height:1.7;
  }
  .update-row{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    margin-top:14px;padding-top:12px;border-top:1px solid var(--hairline);
    color:var(--muted);font-size:12.5px;line-height:1.6;
  }
  .update-line{flex:1 1 auto;min-width:0;word-break:break-word}
  @media (max-width:720px){
    .health{padding:14px 16px;border-radius:16px}
    .health-rows{grid-template-columns:1fr;gap:12px}
    .update-row{font-size:12px}
  }

  /* ── 窄屏：表格改卡片堆叠，不出现横向滚动 ── */
  @media (max-width:720px){
    .shell{padding:28px 16px 56px}
    .hero h1{font-size:24px}
    .hero-actions{width:100%}
    .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    .card{border-radius:16px}
    .field-row{grid-template-columns:1fr}
    thead{display:none}
    table,tbody,tr,td{display:block;width:100%}
    tbody tr{padding:16px 18px;border-bottom:1px solid var(--hairline)}
    tbody tr:last-child{border-bottom:0}
    tbody td{
      display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
      padding:5px 0;border:0;font-size:13.5px;text-align:right;
    }
    tbody td:before{content:attr(data-label);flex:0 0 auto;color:var(--muted);font-size:12.5px;text-align:left}
    tbody td.cell-name{display:block;text-align:left;padding-bottom:10px}
    tbody td.cell-name:before{content:""}
    tbody td.cell-ops{display:flex;justify-content:flex-start;padding-top:12px}
    tbody td.cell-ops:before{content:""}
    tbody td.empty{display:block;text-align:center}
    tbody td.empty:before{content:""}
    .ops{justify-content:flex-start}
    .key-line{padding:0 18px 8px}
    .sub-line{margin:6px 18px}
  }
</style>
</head><body>
<div class="shell">
  <header class="hero">
    <div>
      <h1>API Keys</h1>
      <p class="sub-line">workbuddy 积分池 · 单一模型网关</p>
    </div>
    <div class="hero-actions">
      <button class="btn" id="usageBtn" type="button">用量</button>
      <button class="btn primary" id="createBtn" type="button">创建 API key</button>
    </div>
  </header>

  <section class="stats" id="stats" aria-label="池子概况"></section>
  <p class="notice error" id="poolNotice" hidden></p>

  <!-- 连通状态：数据面 / 管理面 / 公网隧道，三条各自独立，红绿一眼可见 -->
  <section class="health" id="health" aria-label="连通状态">
    <div class="health-head">
      <h2>连通状态</h2>
      <div class="actions">
        <span class="meta" id="healthMeta"></span>
        <button class="btn tiny subtle" id="healthRefreshBtn" type="button">重新检测</button>
        <button class="btn tiny" id="tunnelCheckBtn" type="button">测公网</button>
      </div>
    </div>
    <div class="health-rows">
      <div class="health-item">
        <div class="k"><span class="dot idle" id="dotData"></span>模型调用（数据面）</div>
        <div class="v" id="healthData">检测中…</div>
      </div>
      <div class="health-item">
        <div class="k"><span class="dot idle" id="dotAdmin"></span>账号管理（管理面）</div>
        <div class="v" id="healthAdmin">检测中…</div>
      </div>
      <div class="health-item">
        <div class="k"><span class="dot idle" id="dotTunnel"></span>公网隧道</div>
        <div class="v" id="healthTunnel">检测中…</div>
      </div>
    </div>
    <!--
      上游版本：只查、只报，换不换由人点。
      不自动升级 —— 上游随时可能改行为（模型前缀就变过一次），静默替换等于把它的风险直接灌进来。
    -->
    <div class="update-row" id="updateRow">
      <span class="dot idle" id="dotUpdate"></span>
      <span class="update-line" id="updateLine">上游版本检测中…</span>
      <button class="btn tiny subtle" id="updateBtn" type="button" hidden>更新</button>
      <button class="btn tiny subtle" id="updateCheckBtn" type="button">查上游版本</button>
    </div>
    <p class="health-foot" id="healthFoot"></p>
  </section>

  <div class="segmented" role="tablist" aria-label="视图切换">
    <button class="seg" type="button" role="tab" data-view="keys" aria-selected="true">API Keys</button>
    <button class="seg" type="button" role="tab" data-view="accounts" aria-selected="false">账号</button>
  </div>

  <section id="viewKeys">
    <!-- 首次上手引导：只在「一个号都没有 + 密钥没配全」时出现，配好或登录过就自动消失。 -->
    <div class="card setup-card" id="setupCard" hidden>
      <div class="card-head">
        <h2>还差一步就能用</h2>
        <span class="meta" id="setupMeta"></span>
      </div>
      <p class="sub-line" id="setupLead"></p>
      <ul class="setup-list" id="setupList"></ul>
      <p class="sub-line mono" id="setupHint"></p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>API Keys</h2>
        <span class="meta" id="keysMeta"></span>
      </div>
      <p class="notice error" id="keysNotice" hidden></p>
      <table>
        <thead><tr>
          <th>名称</th><th>今日</th><th>每日上限</th><th>账号范围</th><th>最近使用</th>
          <th class="align-right">操作</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <div class="card" id="drawer" hidden>
      <div class="card-head">
        <h2 id="usageTitle">用量</h2>
        <button class="btn tiny subtle" id="usageClose" type="button">收起</button>
      </div>
      <p class="notice error" id="usageNotice" hidden></p>
      <table>
        <thead><tr>
          <th>名称</th><th>请求</th><th>tokens</th><th>积分</th><th>最近使用</th><th>落在哪些号</th>
        </tr></thead>
        <tbody id="usageRows"></tbody>
      </table>
    </div>

    <div class="card" id="revealBox" hidden>
      <div class="card-head">
        <h2>完整 key</h2>
        <button class="btn tiny subtle" id="revealClose" type="button">收起</button>
      </div>
      <div class="key-line">
        <code class="key-value" id="revealValue"></code>
        <button class="btn primary" id="revealCopy" type="button">复制</button>
      </div>
      <p class="sub-line" id="revealNote"></p>
      <p class="sub-line" id="revealCopyState"></p>
    </div>
  </section>

  <section id="viewAccounts" hidden>
    <div class="card">
      <div class="card-head">
        <h2>账号</h2>
        <div class="head-actions">
          <span class="meta" id="accountsMeta"></span>
          <button class="btn" id="loginBtn" type="button">登录 WorkBuddy 账号</button>
        </div>
      </div>
      <p class="notice error" id="accountsNotice" hidden></p>
      <table>
        <thead><tr>
          <th>账号</th><th>剩余</th><th>已用</th><th>额度池</th><th>状态</th><th>参与调度</th>
        </tr></thead>
        <tbody id="accountRows"></tbody>
      </table>
    </div>

    <div class="card" id="loginBox" hidden>
      <div class="card-head">
        <h2>登录新账号</h2>
        <button class="btn tiny subtle" id="loginClose" type="button">收起</button>
      </div>
      <p class="notice error" id="loginNotice" hidden></p>
      <div class="key-line">
        <code class="key-value" id="loginUrl"></code>
        <button class="btn" id="loginOpen" type="button">打开登录页</button>
        <button class="btn subtle" id="loginCopy" type="button">复制链接</button>
        <button class="btn danger" id="loginCancel" type="button">取消授权</button>
      </div>
      <p class="sub-line" id="loginStatus">在新标签页里完成授权（手机也能打开）。</p>
    </div>

    <p class="foot-note">
      这些号共用同一个积分池：只有「参与调度」的号会被挑到，停用的号完全不参与。
      每次调用记一行账，能在「用量」里看到落在哪个号上。
    </p>
  </section>

  <footer class="footer">
    <p>这一层只放行 <span class="mono" id="modelName">—</span>；其余模型一律 404。可用别名：<span class="mono">__MODELS__</span></p>
    <p>本机（电脑上）Base URL：<span class="mono" id="baseUrl">—</span></p>
    <p>手机同一 Wi-Fi 用这个：<span class="mono">__LAN_HINT__</span>（路径 <span class="mono">/v1</span>）</p>
  </footer>
</div>

<!-- 口令闸门：只在服务端设了 adminPassword 时才会出现 -->
<div class="overlay" id="authGate" hidden>
  <div class="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="authGateTitle">
    <div class="sheet-head">
      <h2 id="authGateTitle">需要管理口令</h2>
    </div>
    <div class="sheet-body">
      <p class="hint">
        这台 BuddyKey 设了管理口令，用来挡住别人打开管理页发 key 白嫖额度。
        口令在部署时定，写在服务端的 <span class="mono">config.json</span> 的
        <span class="mono">adminPassword</span>，或环境变量
        <span class="mono">BUDDYKEY_ADMIN_PASSWORD</span>。
      </p>
      <label class="field">
        <span>管理口令</span>
        <input id="authGateInput" type="password" autocomplete="current-password" placeholder="adminPassword" />
      </label>
      <p class="notice error" id="authGateError" hidden></p>
      <p class="hint">只存在这个标签页里，关掉就没了。</p>
    </div>
    <div class="sheet-foot">
      <button class="btn primary" id="authGateSubmit" type="button">进入</button>
    </div>
  </div>
</div>

<div class="overlay" id="overlay" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="sheet-head">
      <h2 id="modalTitle">创建 API key</h2>
      <button class="btn tiny subtle" id="modalClose" type="button">关闭</button>
    </div>
    <div class="sheet-body">
      <label class="field">
        <span class="label">名称</span>
        <input id="fieldName" type="text" maxlength="60" autocomplete="off"
               placeholder="例如：自己的脚本、朋友的笔记本"/>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="label">每日请求上限</span>
          <input id="fieldRequests" type="number" min="1" step="1" inputmode="numeric" placeholder="留空 = 不限"/>
        </label>
        <label class="field">
          <span class="label">每日积分上限</span>
          <input id="fieldCredits" type="number" min="1" step="1" inputmode="numeric" placeholder="留空 = 不限"/>
        </label>
      </div>
      <fieldset class="field">
        <legend class="label">账号范围</legend>
        <div class="scope-modes">
          <label class="radio"><input type="radio" name="scopeMode" value="all" checked/><span>全部账号</span></label>
          <label class="radio"><input type="radio" name="scopeMode" value="selected"/><span>指定账号</span></label>
        </div>
        <div class="picker" id="accountsPicker" hidden>
          <div class="picker-head">
            <span class="grow" id="pickerHint">读取账号…</span>
            <button class="btn tiny subtle" id="pickerAll" type="button">全选</button>
            <button class="btn tiny subtle" id="pickerNone" type="button">清空</button>
          </div>
          <div class="picker-list" id="pickerList"></div>
        </div>
        <span class="hint" id="scopeHint">未选任何账号时按「全部账号」处理。</span>
      </fieldset>
      <p class="hint" id="modalNote">留空表示不限；限额与范围都可以随时改。</p>
      <p class="notice error" id="formError" hidden></p>
    </div>
    <div class="sheet-foot">
      <button class="btn" id="modalCancel" type="button">取消</button>
      <button class="btn primary" id="modalSave" type="button">创建</button>
    </div>
  </div>
</div>

<!-- 上游版本判定的纯函数（从 lib/update-text.mjs 现读现注入，只留一份实现）。 -->
<script>
__UPDATE_TEXT__
</script>

<script>
(function () {
  'use strict'

  var state = {
    view: 'keys',
    keys: [],
    accounts: [],
    accountsAt: 0,
    editing: null,
    session: '',
    copyBuffer: '',
    setup: null,
    health: null,
    model: '',
    /** 这次授权是不是已经在新标签页里打开了（决定「等待授权」那句要不要带上下文）。 */
    loginOpened: false,
  }
  var loginTimer = null
  var deleteTimer = null

  function $(name){ return document.getElementById(name) }

  /* ── 格式化：全部走 textContent，不拼 HTML ── */

  function textOf(value, fallback){
    if (value === null || value === undefined) return fallback === undefined ? '—' : fallback
    var text = String(value)
    if (text === '') return fallback === undefined ? '—' : fallback
    return text
  }

  function numOf(value){
    if (typeof value !== 'number' || isFinite(value) !== true) return '—'
    return value.toLocaleString()
  }

  function drop0(n){ return n < 10 ? '0' + n : String(n) }

  function stampOf(iso){
    if (!iso) return '—'
    var when = new Date(iso)
    if (isNaN(when.getTime())) return '—'
    return when.getFullYear() + '-' + drop0(when.getMonth() + 1) + '-' + drop0(when.getDate()) +
      ' ' + drop0(when.getHours()) + ':' + drop0(when.getMinutes())
  }

  function el(tag, props, kids){
    var node = document.createElement(tag)
    if (props) {
      for (var key in props) {
        if (Object.prototype.hasOwnProperty.call(props, key) !== true) continue
        var value = props[key]
        if (value === null || value === undefined) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = String(value)
        else node.setAttribute(key, String(value))
      }
    }
    if (kids) {
      for (var index = 0; index < kids.length; index++) {
        if (kids[index]) node.appendChild(kids[index])
      }
    }
    return node
  }

  function cell(label, kids, className){
    return el('td', { 'data-label': label, class: className || '' }, kids)
  }

  function opButton(label, handler){
    var button = el('button', { type: 'button', class: 'btn tiny subtle', text: label })
    button.addEventListener('click', handler)
    return button
  }

  /* ── 请求 ── */

  /*
    管理口令。

    存在 sessionStorage：关掉标签页就没，不写 localStorage ——
    公网部署时这台机器可能多人用，别让下一个开浏览器的人直接拿到权限。
    服务器那边对空口令有「非回环即拒绝启动」的闸门，所以这里的口令只在
    真的设了口令时才用得上。
  */
  var TOKEN_KEY = 'buddykey.adminToken'
  var adminToken = ''
  try { adminToken = window.sessionStorage.getItem(TOKEN_KEY) || '' } catch (error) { adminToken = '' }

  function setAdminToken(value){
    adminToken = value || ''
    try {
      if (adminToken === '') window.sessionStorage.removeItem(TOKEN_KEY)
      else window.sessionStorage.setItem(TOKEN_KEY, adminToken)
    } catch (error) { /* 隐私模式下写不了，内存里那份仍然有效 */ }
  }

  function api(path, init){
    var options = init || {}
    var headers = {}
    var given = options.headers || {}
    for (var key in given) if (Object.prototype.hasOwnProperty.call(given, key)) headers[key] = given[key]
    if (adminToken !== '') headers.authorization = 'Bearer ' + adminToken
    options.headers = headers

    return fetch(path, options).then(function (response) {
      /* 401 = 没口令或口令不对。弹出口令框，别把「未授权」渲染成「服务坏了」。 */
      if (response.status === 401) {
        showAuthGate()
        return { ok: false, authRequired: true, error: '需要管理口令' }
      }
      return response.text().then(function (raw) {
        var body = null
        try { body = raw === '' ? {} : JSON.parse(raw) } catch (error) { body = null }
        if (body === null) return { ok: false, error: 'HTTP ' + response.status + '：返回的不是 JSON' }
        if (body.ok === undefined) body.ok = response.ok
        if (body.ok === false && !body.error) body.error = 'HTTP ' + response.status
        return body
      }, function () {
        return { ok: false, error: 'HTTP ' + response.status }
      })
    }, function (error) {
      return { ok: false, error: '网络错误：' + textOf(error && error.message, '连不上服务') }
    })
  }

  /* ── 口令闸门 ── */

  function showAuthGate(){
    var gate = $('authGate')
    if (gate === null) return
    gate.hidden = false
    var input = $('authGateInput')
    if (input !== null) {
      input.value = ''
      input.focus()
    }
    $('authGateError').textContent = ''
  }

  function hideAuthGate(){
    var gate = $('authGate')
    if (gate !== null) gate.hidden = true
  }

  function submitAuthGate(){
    var input = $('authGateInput')
    var value = input === null ? '' : String(input.value || '').trim()
    if (value === '') {
      $('authGateError').textContent = '请填管理口令。'
      return Promise.resolve()
    }
    setAdminToken(value)
    return loadHealth().then(function (result) {
      if (result && result.authRequired === true) {
        /* 口令不被接受：清掉，别让错口令一直挂在头里。 */
        setAdminToken('')
        $('authGateError').textContent = '口令不对。'
        return null
      }
      hideAuthGate()
      return refreshAll()
    })
  }

  /** 提交期间按钮禁用 + 进行中文案，防重复提交。 */
  function busy(button, label, work){
    var oldText = button.textContent
    var oldDisabled = button.disabled
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    if (label) button.textContent = label
    function settle(){
      button.disabled = oldDisabled
      button.textContent = oldText
      button.removeAttribute('aria-busy')
    }
    return Promise.resolve().then(work).then(function (value) {
      settle()
      return value
    }, function (error) {
      settle()
      throw error
    })
  }

  function notice(node, message, isError){
    node.textContent = message || ''
    node.hidden = !message
    node.className = 'notice' + (isError ? ' error' : '')
  }

  function formError(message){
    notice($('formError'), message, true)
  }

  function copyText(value){
    function fallback(){
      try {
        var area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        area.setSelectionRange(0, value.length)
        var done = document.execCommand('copy')
        document.body.removeChild(area)
        return done === true
      } catch (error) {
        return false
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () { return true }, fallback)
    }
    return Promise.resolve(fallback())
  }

  /* ── 池子概况 ── */

  function statCard(label, value){
    return el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: label }),
      el('div', { class: 'v', text: value }),
    ])
  }

  /* ── 连通状态 ── */

  /** 三态圆点：ok / bad / idle（没测过）。 */
  function setDot(node, kind){
    if (node === null) return
    node.className = 'dot ' + (kind === true ? 'ok' : kind === false ? 'bad' : 'idle')
  }

  function msText(value){
    return typeof value === 'number' && isFinite(value) ? ' · ' + Math.round(value) + 'ms' : ''
  }

  function renderHealth(health){
    var info = health && typeof health === 'object' ? health : null
    if (info === null) {
      setDot($('dotData'), null)
      setDot($('dotAdmin'), null)
      setDot($('dotTunnel'), null)
      $('healthData').textContent = '检测中…'
      $('healthAdmin').textContent = '检测中…'
      $('healthTunnel').textContent = '检测中…'
      return
    }

    var upstream = info.upstream || {}
    var data = upstream.data || {}
    var admin = upstream.admin || {}
    var tunnel = info.tunnel || {}
    var process = tunnel.process || {}

    /* 1. 数据面：客户端真正走的那条路 */
    var dataOk = data.ok === true
    setDot($('dotData'), data.reached === false ? false : dataOk)
    var dataNode = $('healthData')
    dataNode.textContent = dataOk
      ? '正常，可调 ' + textOf(state.model, '模型') + msText(data.ms)
      : data.reached === false
        ? '连不上 ' + textOf(upstream.url) + '：' + textOf(data.reason, '上游没起？')
        : '上游回 HTTP ' + textOf(data.status) + '，密钥可能不对'

    /* 2. 管理面：账号列表与登录要它 */
    var adminOk = admin.ok === true
    setDot($('dotAdmin'), admin.reached === false ? false : adminOk)
    var adminNode = $('healthAdmin')
    if (adminOk === true) {
      adminNode.textContent = '正常，账号池可读写' + msText(admin.ms)
    } else if (admin.hint) {
      adminNode.textContent = admin.hint
    } else if (admin.reached === false) {
      adminNode.textContent = '连不上：' + textOf(admin.reason, '未知原因')
    } else {
      adminNode.textContent = '回 HTTP ' + textOf(admin.status)
    }

    /* 3. 隧道：分「进程活着」与「公网可达」两件事 */
    var tunnelRunning = tunnel.running === true
    setDot($('dotTunnel'), tunnel.publicOk === true ? true : tunnel.publicOk === false ? false : tunnelRunning ? null : false)
    var tunnelNode = $('healthTunnel')
    tunnelNode.textContent = ''
    if (tunnelRunning === true) {
      tunnelNode.appendChild(el('span', { text: '运行中' }))
      if (tunnel.publicUrl) {
        tunnelNode.appendChild(el('span', { class: 'mono', text: ' ' + tunnel.publicUrl }))
      }
      if (tunnel.publicOk === true) {
        tunnelNode.appendChild(el('span', { text: ' · 公网已连通' + msText(tunnel.publicMs) }))
      } else if (tunnel.publicOk === false) {
        tunnelNode.appendChild(el('span', { text: ' · 公网不通' }))
      }
    } else {
      tunnelNode.appendChild(el('span', { text: '未运行' }))
      if (tunnel.publicUrl) {
        tunnelNode.appendChild(el('span', { class: 'mono', text: ' · 上次地址 ' + tunnel.publicUrl }))
      }
    }

    $('healthMeta').textContent = '检测于 ' + stampOf(info.checkedAt)

    /* 页脚：把「为什么不能用」该看哪、该做什么说清楚 */
    var foot = []
    if (dataOk !== true) {
      foot.push('模型调用这条断了 —— 客户端现在请求会失败。检查 CPA 是否在 ' + textOf(upstream.url) + ' 上跑着。')
    }
    if (adminOk !== true && admin.hint) foot.push(admin.hint)
    if (tunnelRunning !== true) {
      foot.push('公网隧道没跑：手机在外面用不了。本机与同一 Wi-Fi 不受影响；要外网访问就跑 start-tunnel.cmd。')
    }
    if (foot.length === 0) foot.push('三条都通：本机、局域网、公网都能用。')
    $('healthFoot').textContent = foot.join(' ')
  }

  function loadHealth(){
    return api('/admin/api/health').then(function (out) {
      if (out && out.checkedAt) {
        state.health = out
        renderHealth(out)
      } else {
        renderHealth(null)
      }
      return out
    }).catch(function () {
      renderHealth(null)
    })
  }

  /*
    上游版本这一行。

    判据全在 lib/update-text.mjs（纯函数，Node 侧能直接测）：这里只管把结果画出来。
    「没记录」「查不到」「认不出」三种情况必须显示成不同的话 —— 混成一句「已是最新」
    就是在替后端撒谎。
  */
  function renderUpdate(info){
    var lineNode = $('updateLine')
    var btn = $('updateBtn')
    var view = updateView(info)

    if (view.line === '') {
      /* 认不出 / 还没查：不画，也不给按钮。 */
      setDot($('dotUpdate'), null)
      lineNode.textContent = '上游版本未知（点右边查一次）'
      btn.hidden = true
      return
    }

    setDot($('dotUpdate'), view.tone === 'ok' ? true : view.tone === 'warn' ? null : false)
    lineNode.textContent = 'workbuddy 插件 ' + view.line
    btn.hidden = view.action !== 'update'
    btn.disabled = view.action !== 'update'
  }

  function loadUpdate(){
    return api('/admin/api/updates').then(function (out) {
      state.update = out
      renderUpdate(out)
      return out
    }).catch(function (error) {
      var failed = { ok: false, error: textOf(error && error.message, '请求失败') }
      state.update = failed
      renderUpdate(failed)
    })
  }

  /* 查上游版本：显式动作，不进轮询 —— 每次都要打一次 GitHub，未认证限流 60 次/小时。 */
  function checkUpdateVersion(event){
    var button = event.currentTarget
    button.disabled = true
    var original = button.textContent
    button.textContent = '查询中…'
    return loadUpdate().then(function () {
      button.disabled = false
      button.textContent = original
    })
  }

  /*
    更新：停 CPA → 换文件 → 回报。

    ⚠️ 换完 CPA 是**停着的**（Windows 上被加载的 dll 改不了名，服务端会先确认它没在跑）。
    所以拿到 stopped 必须说出来，否则用户看到「更新成功」却怎么也连不上。
  */
  function applyUpdate(event){
    var button = event.currentTarget
    button.disabled = true
    var original = button.textContent
    button.textContent = '更新中…'
    $('updateLine').textContent = '正在下载并替换…'

    return api('/admin/api/updates', { method: 'POST', body: JSON.stringify({ key: 'plugins' }) })
      .then(function (out) {
        $('updateLine').textContent = updateResultLine(out)
        if (out && out.ok === true) {
          /* 插件可能换了模型前缀，服务端已经重探过，这里同步页面上的模型名。 */
          if (out.model) state.model = out.model
          return Promise.all([loadHealth(), loadUpdate()]).then(function () {
            notice($('keysNotice'), out.stopped === true ? '已更新。CPA 现在是停着的 —— 去那个窗口重新跑 npm run cpa。' : '', out.stopped === true)
          })
        }
        notice($('keysNotice'), textOf(out && out.error, '更新失败'), true)
      })
      .catch(function (error) {
        $('updateLine').textContent = '更新失败'
        notice($('keysNotice'), '更新失败：' + textOf(error && error.message, '未知原因'), true)
      })
      .then(function () {
        button.disabled = false
        button.textContent = original
      })
  }

  /** 点了才测：本机去 fetch 自己的公网地址，验证隧道真的把流量送到这里。 */
  function checkTunnel(event){
    var button = event.currentTarget
    button.disabled = true
    var original = button.textContent
    button.textContent = '检测中…'
    return api('/admin/api/health/tunnel', { method: 'POST' }).then(function (out) {
      if (state.health && state.health.tunnel) {
        state.health.tunnel.publicOk = out.ok === true
        state.health.tunnel.publicMs = out.ms
        if (out.publicUrl) state.health.tunnel.publicUrl = out.publicUrl
      }
      renderHealth(state.health)
      if (out.ok !== true) {
        notice($('keysNotice'), '公网测不通：' + textOf(out.hint, textOf(out.reason, '未知原因')), true)
      } else {
        notice($('keysNotice'), '', false)
      }
      return out
    }).catch(function (error) {
      notice($('keysNotice'), '公网检测失败：' + textOf(error && error.message, '未知原因'), true)
    }).then(function () {
      button.disabled = false
      button.textContent = original
    })
  }

  function renderPool(pool){
    var source = pool && typeof pool === 'object' ? pool : {}
    var grid = $('stats')
    grid.textContent = ''
    if (source.ok === true) {
      grid.appendChild(statCard('池子剩余', numOf(source.remain)))
      grid.appendChild(statCard('已用', numOf(source.used)))
      grid.appendChild(statCard('账号数', numOf(source.accountCount)))
      grid.appendChild(statCard('模型', textOf(source.model)))
      notice($('poolNotice'), '', false)
      return
    }
    grid.appendChild(statCard('池子剩余', '—'))
    grid.appendChild(statCard('已用', '—'))
    grid.appendChild(statCard('账号数', '—'))
    grid.appendChild(statCard('模型', '—'))
    notice($('poolNotice'), '池子读不到：' + textOf(source.error, '未知原因'), true)
  }

  /* ── API Keys 表 ── */

  function quotaText(key){
    var quota = key.quota || {}
    var requests = quota.requestsPerDay ? numOf(quota.requestsPerDay) + ' 次/日' : '请求不限'
    var credits = quota.creditsPerDay ? numOf(quota.creditsPerDay) + ' 积分/日' : '积分不限'
    return requests + ' · ' + credits
  }

  function scopeText(key){
    var scope = key.scope || {}
    var picked = Array.isArray(scope.accounts) ? scope.accounts : []
    if (scope.mode !== 'selected' || picked.length === 0) return '全部账号'
    var names = picked.map(function (item) { return textOf(item.nickname, item.authIndex) })
    if (names.length <= 2) return names.join('、')
    return names.slice(0, 2).join('、') + ' 等 ' + names.length + ' 个号'
  }

  /**
   * 这把 key 现在能不能用。
   *
   * 三层信息按重要性排：被停用 > 被额度拦住 > 上次调用结果。
   * ⚠️ 429 不写账本（设计如此），所以被限流的 key 的 lastCall 会停在成功那次 ——
   *   光看 lastCall 会误判成「一切正常」，必须把 blocked 显式画出来。
   */
  function callLine(key){
    var lastCall = key.lastCall
    var blocked = key.blocked

    if (key.enabled === false) {
      return el('span', { class: 'sub-line', text: '已停用，当前不可用', style: 'color:var(--danger)' })
    }
    if (blocked !== null && blocked !== undefined) {
      return el('span', {
        class: 'sub-line',
        text: '今日额度已满，现在调用会被 429 拦下',
        style: 'color:var(--danger)',
      })
    }
    if (lastCall === null || lastCall === undefined) {
      return el('span', { class: 'sub-line', text: '还没用过' })
    }
    var ok = lastCall.ok === true
    var status = lastCall.status === null || lastCall.status === undefined ? '—' : String(lastCall.status)
    var text = ok ? '上次调用成功 ' + status : '上次调用失败 ' + status
    if (typeof lastCall.ms === 'number') text += ' · ' + Math.round(lastCall.ms) + 'ms'
    if (typeof lastCall.account === 'string' && lastCall.account !== '') {
      text += ' · 落号 ' + lastCall.account.slice(0, 8)
    }
    return el('span', { class: 'sub-line', text: text, style: ok ? null : 'color:var(--danger)' })
  }

  function keyRow(key){
    var row = el('tr', { class: 'row' })

    row.appendChild(cell('名称', [
      el('div', { class: 'name-line' }, [
        el('span', { text: textOf(key.name) }),
        el('span', { class: 'badge' + (key.enabled ? '' : ' off'), text: key.enabled ? '启用中' : '已停用' }),
      ]),
      el('span', { class: 'sub-line mono', text: textOf(key.keyMasked) }),
    ], 'cell-name'))

    var today = key.today || {}
    row.appendChild(cell('今日', [
      el('span', { text: numOf(today.requests) + ' 次 · ' + numOf(today.credits) + ' 积分' }),
    ]))

    row.appendChild(cell('每日上限', [el('span', { class: 'muted', text: quotaText(key) })]))
    row.appendChild(cell('账号范围', [el('span', { class: 'muted', text: scopeText(key) })]))
    row.appendChild(cell('最近使用', [
      el('span', { class: 'muted', text: stampOf(key.lastUsedAt) }),
      callLine(key),
    ]))

    var ops = el('div', { class: 'ops' })
    ops.appendChild(opButton('用量', function (event) { openUsage(key.id, event.currentTarget) }))
    ops.appendChild(opButton('编辑', function (event) { openEditor(key) }))
    ops.appendChild(opButton('显示', function (event) { revealKey(key, event.currentTarget) }))
    var remove = opButton('删除', function (event) { requestDelete(key, event.currentTarget) })
    remove.classList.add('danger')
    ops.appendChild(remove)
    row.appendChild(cell('', [ops], 'cell-ops'))

    return row
  }

  function renderKeys(){
    var body = $('rows')
    body.textContent = ''
    $('keysMeta').textContent = state.keys.length === 0 ? '' : state.keys.length + ' 把'
    if (state.keys.length === 0) {
      var emptyRow = el('tr')
      emptyRow.appendChild(el('td', { class: 'empty', colspan: '6', text: '还没有 key —— 点右上角「创建 API key」' }))
      body.appendChild(emptyRow)
      return
    }
    state.keys.forEach(function (key) { body.appendChild(keyRow(key)) })
  }

  /* ── 账号表 ── */

  function switchCell(account){
    var input = el('input', { type: 'checkbox' })
    input.checked = account.disabled !== true
    var label = el('span', { class: 'switch-text' })
    label.textContent = input.checked ? '' : '已停用'
    input.addEventListener('change', function () {
      var enabled = input.checked
      input.disabled = true
      label.textContent = '提交中…'
      api('/admin/api/accounts/' + encodeURIComponent(account.authIndex) + '/enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: enabled }),
      }).then(function (out) {
        input.disabled = false
        if (out.ok !== true) {
          input.checked = !enabled
          label.textContent = ''
          notice($('accountsNotice'), '改不动这个号：' + textOf(out.error, '未知原因'), true)
          return
        }
        notice($('accountsNotice'), '', false)
        label.textContent = ''
        return refreshAll()
      })
    })
    return el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), label])
  }

  /**
   * 首次上手引导。
   *
   * 只在「密钥没配全」或「池子里一个号都没有」时显示 —— 配好、登录过就自动收起，
   * 不给已经跑起来的人添噪声。文案里的路径与字段名全部来自 /admin/api/state 的
   * setup 段，换机器 / 换路径不用改前端。
   */
  function renderSetup(setup, pool){
    var card = $('setupCard')
    if (card === null) return
    var info = setup || {}
    var upstreamOk = info.upstreamKey === 'ok'
    var adminOk = info.adminKey === 'ok'
    var poolCount = pool && pool.ok === true ? Number(pool.accountCount || 0) : 0
    var hasAccounts = poolCount > 0
    var needsSetup = upstreamOk !== true || adminOk !== true || hasAccounts !== true
    card.hidden = needsSetup !== true
    if (needsSetup !== true) return

    var missing = []
    if (upstreamOk !== true) missing.push('上游 API key')
    if (adminOk !== true) missing.push('管理密钥')
    $('setupMeta').textContent = missing.length > 0 ? '缺 ' + missing.join('、') : '池子里还没有账号'

    $('setupLead').textContent = missing.length > 0
      ? 'BuddyKey 要拿两个 CPA 密钥才能读写账号池。有三种填法，先到先得：'
      : '两个密钥都就位了，只差登录一个 WorkBuddy 账号。'

    var list = $('setupList')
    list.textContent = ''

    var sourceLabel = function (from){
      if (from === 'config') return 'config.json'
      if (from === 'env') return '环境变量'
      if (from === 'refs') return '.credentials.yaml'
      return '未配置'
    }

    var step = function (done, title, detail, codeText){
      var item = el('li', { class: done === true ? 'done' : null })
      item.appendChild(el('span', { class: 'step-mark', text: done === true ? '✓' : '·' }))
      var body = el('div', { class: 'step-body' })
      body.appendChild(el('span', { class: 'step-text', text: title }))
      if (detail) body.appendChild(el('span', { class: 'sub-line', text: detail }))
      if (codeText) body.appendChild(el('code', { class: 'step-code', text: codeText }))
      item.appendChild(body)
      list.appendChild(item)
    }

    step(
      upstreamOk === true,
      '上游 API key：' + (upstreamOk === true ? '已就位' : '还缺') + '（来源 ' + sourceLabel(info.upstreamKeyFrom) + '）',
      'CPA config.yaml 里 access.api-keys 的那一条，BuddyKey 拿它去调 CPA。',
      upstreamOk === true ? null : 'config.json →  "upstreamKey": "<access.api-keys 那条>"',
    )
    step(
      adminOk === true,
      '管理密钥：' + (adminOk === true ? '已就位' : '还缺') + '（来源 ' + sourceLabel(info.adminKeyFrom) + '）',
      'CPA 里 management.secret-key 的明文。注意那个字段可能是 bcrypt（$2a$…），哈希还原不出来，要你当初设的原值。',
      adminOk === true ? null : 'config.json →  "adminKey": "<management.secret-key 的明文>"',
    )
    step(
      hasAccounts === true,
      hasAccounts === true ? '账号池：已有 ' + poolCount + ' 个号' : '账号池：还没有号',
      hasAccounts === true ? null : '切到「账号」视图点「登录 WorkBuddy 账号」，扫码授权完这个号就进池子。',
      null,
    )

    var envNames = Array.isArray(info.envNames) ? info.envNames : []
    var hint = ''
    if (info.configFile) hint += '配置文件：' + info.configFile
    if (envNames.length > 0) hint += (hint ? '　|　' : '') + '或设环境变量：' + envNames.join(' / ')
    if (missing.length > 0) hint += (hint ? '　|　' : '') + '也可以直接跑 npm run setup 一问一答填完'
    $('setupHint').textContent = hint
  }

  function renderAccounts(out){    var body = $('accountRows')
    body.textContent = ''
    if (out.ok !== true) {
      $('accountsMeta').textContent = ''
      var failed = el('tr')
      failed.appendChild(el('td', { class: 'empty', colspan: '6', text: '读不到账号：' + textOf(out.error, '未知原因') }))
      body.appendChild(failed)
      return
    }
    var list = Array.isArray(out.accounts) ? out.accounts : []
    var summary = out.summary || {}
    $('accountsMeta').textContent = list.length === 0
      ? ''
      : list.length + ' 个号 · 参与调度 ' + numOf(summary.enabled)
    if (list.length === 0) {
      var emptyRow = el('tr')
      emptyRow.appendChild(el('td', { class: 'empty', colspan: '6', text: '还没有账号 —— 点右侧「登录 WorkBuddy 账号」' }))
      body.appendChild(emptyRow)
      return
    }
    list.forEach(function (account) {
      var row = el('tr', { class: 'row' })
      row.appendChild(cell('账号', [
        el('div', { class: 'name-line' }, [
          el('span', { text: textOf(account.nickname, account.authIndex) }),
          account.region ? el('span', { class: 'badge', text: String(account.region) }) : null,
        ]),
        el('span', { class: 'sub-line mono', text: textOf(account.authIndex) }),
      ], 'cell-name'))
      var credits = account.credits || {}
      row.appendChild(cell('剩余', [el('span', { text: numOf(credits.remain) })]))
      row.appendChild(cell('已用', [el('span', { class: 'muted', text: numOf(credits.used) })]))
      row.appendChild(cell('额度池', [el('span', { class: 'muted', text: numOf(credits.size) })]))
      row.appendChild(cell('状态', [
        el('span', { class: 'muted', text: account.exhausted === true ? '已耗尽' : textOf(account.status) }),
      ]))
      row.appendChild(cell('参与调度', [switchCell(account)]))
      body.appendChild(row)
    })
  }

  function loadAccounts(force){
    var now = Date.now()
    if (force !== true && state.accounts.length > 0 && now - state.accountsAt < 15000) {
      return Promise.resolve({ ok: true, accounts: state.accounts })
    }
    return api('/admin/api/accounts').then(function (out) {
      if (out.ok === true) {
        state.accounts = Array.isArray(out.accounts) ? out.accounts : []
        state.accountsAt = now
      }
      return out
    })
  }

  function renderAccountsView(){
    return loadAccounts(true).then(function (out) {
      renderAccounts(out)
      return out
    })
  }

  /* ── 用量抽屉 ── */

  function openUsage(keyId, button){
    var drawer = $('drawer')
    drawer.hidden = false
    $('usageTitle').textContent = keyId === 'all' ? '全部 API Key 的用量' : '单把 key 的用量'
    function run(){
      return api('/admin/api/usage?keyId=' + encodeURIComponent(keyId)).then(function (out) {
        if (out.ok !== true) {
          notice($('usageNotice'), '读不到用量：' + textOf(out.error, '未知原因'), true)
          return
        }
        notice($('usageNotice'), '', false)
        renderUsage(Array.isArray(out.rows) ? out.rows : [])
      })
    }
    if (button) return busy(button, '读取中…', run)
    return run()
  }

  function renderUsage(rows){
    var body = $('usageRows')
    body.textContent = ''
    if (rows.length === 0) {
      var emptyRow = el('tr')
      emptyRow.appendChild(el('td', { class: 'empty', colspan: '6', text: '还没有调用记录' }))
      body.appendChild(emptyRow)
      return
    }
    rows.forEach(function (item) {
      var row = el('tr', { class: 'row' })
      row.appendChild(cell('名称', [el('span', { text: textOf(item.keyName) })], 'cell-name'))
      var errors = Number(item.errors || 0)
      row.appendChild(cell('请求', [
        el('span', { text: numOf(item.requests) + (errors > 0 ? '（失败 ' + numOf(errors) + '）' : '') }),
      ]))
      row.appendChild(cell('tokens', [
        el('span', { class: 'muted', text: numOf(item.promptTokens) + ' 入 / ' + numOf(item.completionTokens) + ' 出' }),
      ]))
      row.appendChild(cell('积分', [el('span', { text: numOf(item.credit) })]))
      row.appendChild(cell('最近使用', [el('span', { class: 'muted', text: stampOf(item.lastAt) })]))
      var landed = Array.isArray(item.accounts)
        ? item.accounts.map(function (a) { return textOf(a.nickname, a.authIndex) + '×' + numOf(a.count) }).join('、')
        : ''
      row.appendChild(cell('落在哪些号', [el('span', { class: 'mono muted', text: landed === '' ? '—' : landed })]))
      body.appendChild(row)
    })
  }

  /* ── 完整 key：只展示一次 ── */

  function showReveal(value, note){
    state.copyBuffer = value
    $('revealBox').hidden = false
    $('revealNote').textContent = note
    $('revealValue').textContent = value
    var copyState = $('revealCopyState')
    copyState.textContent = '仅显示这一次，请立刻复制保存。'
    copyState.className = 'sub-line'
    if ($('revealBox').scrollIntoView) $('revealBox').scrollIntoView({ block: 'nearest' })
  }

  function hideReveal(){
    state.copyBuffer = ''
    $('revealValue').textContent = ''
    $('revealBox').hidden = true
  }

  function revealKey(key, button){
    return busy(button, '读取中…', function () {
      return api('/admin/api/keys/' + encodeURIComponent(key.id) + '/reveal', { method: 'POST' }).then(function (out) {
        if (out.ok !== true) {
          notice($('keysNotice'), '读不到 key：' + textOf(out.error, '未知原因'), true)
          return
        }
        showReveal(String(out.key), '「' + textOf(key.name) + '」的完整 key')
      })
    })
  }

  function requestDelete(key, button){
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1'
      button.textContent = '确认删除'
      if (deleteTimer !== null) clearTimeout(deleteTimer)
      deleteTimer = setTimeout(function () {
        button.dataset.armed = ''
        button.textContent = '删除'
      }, 4000)
      return
    }
    button.dataset.armed = ''
    if (deleteTimer !== null) clearTimeout(deleteTimer)
    return busy(button, '删除中…', function () {
      return api('/admin/api/keys/' + encodeURIComponent(key.id), { method: 'DELETE' }).then(function (out) {
        if (out.ok !== true) {
          button.textContent = '删除'
          notice($('keysNotice'), '删除失败：' + textOf(out.error, '未知原因'), true)
          return
        }
        notice($('keysNotice'), '', false)
        return refreshAll()
      })
    })
  }

  /* ── 创建 / 编辑弹层 ── */

  function scopeMode(){
    var picked = document.querySelector('input[name="scopeMode"]:checked')
    return picked ? picked.value : 'all'
  }

  function setScopeMode(mode){
    var boxes = document.querySelectorAll('input[name="scopeMode"]')
    for (var index = 0; index < boxes.length; index++) {
      boxes[index].checked = boxes[index].value === (mode === 'selected' ? 'selected' : 'all')
    }
    $('accountsPicker').hidden = mode !== 'selected'
  }

  function renderPicker(selected){
    var list = $('pickerList')
    list.textContent = ''
    if (state.accounts.length === 0) {
      $('pickerHint').textContent = '没有可选账号'
      list.appendChild(el('div', { class: 'picker-row' }, [
        el('span', { class: 'hint', text: '还没有账号 —— 先到「账号」里登录一个' }),
      ]))
      return
    }
    $('pickerHint').textContent = '共 ' + state.accounts.length + ' 个号'
    state.accounts.forEach(function (account) {
      var box = el('input', { type: 'checkbox', value: account.authIndex })
      box.checked = selected.indexOf(account.authIndex) >= 0
      list.appendChild(el('label', { class: 'picker-row' }, [
        box,
        el('span', { class: 'nick', text: textOf(account.nickname, account.authIndex) }),
        el('span', { class: 'mono muted', text: textOf(account.authIndex) }),
      ]))
    })
  }

  function preparePicker(selected){
    $('pickerHint').textContent = '读取账号…'
    return loadAccounts(true).then(function (out) {
      if (out.ok !== true) {
        $('pickerHint').textContent = '账号读不到：' + textOf(out.error, '未知原因')
        return
      }
      renderPicker(selected)
    })
  }

  function pickedScope(){
    if (scopeMode() !== 'selected') return { mode: 'all', accounts: [] }
    var boxes = document.querySelectorAll('#pickerList input[type="checkbox"]')
    var picked = []
    for (var index = 0; index < boxes.length; index++) {
      if (boxes[index].checked) picked.push(boxes[index].value)
    }
    return picked.length === 0 ? { mode: 'all', accounts: [] } : { mode: 'selected', accounts: picked }
  }

  function showModal(){
    notice($('formError'), '', true)
    $('overlay').hidden = false
    $('fieldName').focus()
  }

  function closeModal(){
    $('overlay').hidden = true
    state.editing = null
  }

  function fillQuotaField(fieldId, value){
    $(fieldId).value = value === null || value === undefined ? '' : String(value)
  }

  function openCreate(){
    state.editing = null
    $('modalTitle').textContent = '创建 API key'
    $('modalSave').textContent = '创建'
    $('modalNote').textContent = '留空表示不限；限额与范围都可以随时改。'
    $('fieldName').value = ''
    fillQuotaField('fieldRequests', null)
    fillQuotaField('fieldCredits', null)
    setScopeMode('all')
    preparePicker([])
    showModal()
  }

  function openEditor(key){
    state.editing = key
    $('modalTitle').textContent = '编辑「' + textOf(key.name) + '」'
    $('modalSave').textContent = '保存'
    $('modalNote').textContent = '留空表示不限；改这里不会动到已有用量。'
    $('fieldName').value = key.name || ''
    var quota = key.quota || {}
    fillQuotaField('fieldRequests', quota.requestsPerDay)
    fillQuotaField('fieldCredits', quota.creditsPerDay)
    var scope = key.scope || {}
    var selected = Array.isArray(scope.accounts)
      ? scope.accounts.map(function (item) { return item.authIndex })
      : []
    var mode = scope.mode === 'selected' && selected.length > 0 ? 'selected' : 'all'
    setScopeMode(mode)
    preparePicker(selected)
    showModal()
  }

  function readQuota(fieldId, label){
    var raw = $(fieldId).value.trim()
    if (raw === '') return { ok: true, value: null }
    var parsed = Number(raw)
    if (isFinite(parsed) !== true || parsed <= 0) {
      return { ok: false, error: label + '要填大于 0 的整数，或者留空表示不限' }
    }
    return { ok: true, value: Math.floor(parsed) }
  }

  function submitModal(button){
    var name = $('fieldName').value.trim()
    if (name === '') return formError('请先给这把 key 起个名字')
    var requests = readQuota('fieldRequests', '每日请求上限')
    if (requests.ok !== true) return formError(requests.error)
    var credits = readQuota('fieldCredits', '每日积分上限')
    if (credits.ok !== true) return formError(credits.error)
    notice($('formError'), '', true)

    var payload = {
      name: name,
      quota: { requestsPerDay: requests.value, creditsPerDay: credits.value },
      scope: pickedScope(),
    }
    var editing = state.editing
    var path = editing === null ? '/admin/api/keys' : '/admin/api/keys/' + encodeURIComponent(editing.id)
    var init = {
      method: editing === null ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }
    return busy(button, editing === null ? '创建中…' : '保存中…', function () {
      return api(path, init).then(function (out) {
        if (out.ok !== true) {
          formError('提交失败：' + textOf(out.error, '未知原因'))
          return
        }
        closeModal()
        if (editing === null && out.key && out.key.key) {
          showReveal(String(out.key.key), '新创建的 key「' + textOf(out.key.name) + '」')
        }
        return refreshAll()
      })
    })
  }

  /* ── 登录 WorkBuddy 账号 ── */

  function stopLoginPolling(){
    if (loginTimer !== null) clearInterval(loginTimer)
    loginTimer = null
  }

  function startLoginPolling(session){
    stopLoginPolling()
    loginTimer = setInterval(function () {
      api('/admin/api/login/status?state=' + encodeURIComponent(session)).then(function (out) {
        if (out.ok !== true) {
          $('loginStatus').textContent = '查不到进度：' + textOf(out.error, '未知原因')
          stopLoginPolling()
          return
        }
        if (out.status === 'wait') {
          /* 保留「在新标签页里操作」这句上下文，别把它覆盖成干巴巴的「等待授权…」——
             用户刚被弹到一个新标签页，回来时最需要知道的正是「在那边操作就行」。 */
          $('loginStatus').textContent = state.loginOpened === true
            ? '等待授权…（在刚打开的那个标签页里扫码或手机号登录）'
            : '等待授权…'
          return
        }
        $('loginStatus').textContent = '授权结束（' + textOf(out.status) + '）'
        stopLoginPolling()
        loadAccounts(true).then(function () { return refreshAll() })
      })
    }, 2000)
  }

  function startLogin(button){
    /*
      先把窗口占住，再发请求。

      ⚠️ window.open 必须在**点击的同步栈**里调用。放到 fetch 的 then 里就不再是
         「用户手势触发的打开」，Chrome/Safari 会当弹窗广告拦掉 —— 表现是「点了没反应」，
         而网络请求其实是成功的，很难往这里想。
      所以先开一个 about:blank，拿到授权 URL 后再把它的地址换掉。
    */
    var opened = null
    try {
      opened = window.open('about:blank', '_blank')
    } catch (error) {
      opened = null
    }

    return busy(button, '起授权…', function () {
      return api('/admin/api/login', { method: 'POST' }).then(function (out) {
        $('loginBox').hidden = false
        if (out.ok !== true) {
          /* 失败的话别把白页留在那儿。 */
          if (opened !== null) { try { opened.close() } catch (error) { /* 关不掉就算了 */ } }
          notice($('loginNotice'), '起不来登录：' + textOf(out.error, '未知原因'), true)
          return
        }
        notice($('loginNotice'), '', false)
        state.session = textOf(out.state, '')
        var url = textOf(out.url, '')
        $('loginUrl').textContent = url

        if (opened !== null && opened.closed !== true) {
          opened.location.href = url
          state.loginOpened = true
          $('loginStatus').textContent = '已在新标签页打开 —— 扫码或手机号登录，完成后这里会自动出现账号。'
        } else {
          /* 被拦了：还有「打开登录页」和「复制链接」两条路，别只说失败。 */
          state.loginOpened = false
          $('loginStatus').textContent = '浏览器拦住了自动打开。点上面「打开登录页」，或复制链接到手机上打开。'
        }
        startLoginPolling(state.session)
      })
    })
  }

  /* 手动打开：有些浏览器/扩展就是会拦，留一个显式按钮。 */
  function openLoginPage(){
    var url = $('loginUrl').textContent
    if (!url) {
      $('loginStatus').textContent = '还没有登录链接 —— 先点「登录 WorkBuddy 账号」。'
      return
    }
    window.open(url, '_blank', 'noopener')
    state.loginOpened = true
    $('loginStatus').textContent = '已在新标签页打开 —— 扫码或手机号登录，完成后这里会自动出现账号。'
  }

  function cancelLogin(button){
    if (state.session === '') return Promise.resolve()
    return busy(button, '取消中…', function () {
      return api('/admin/api/login/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: state.session }),
      }).then(function (out) {
        stopLoginPolling()
        state.session = ''
        if (out.ok !== true) {
          notice($('loginNotice'), '取消失败：' + textOf(out.error, '未知原因'), true)
          return
        }
        $('loginStatus').textContent = '已取消这次授权。'
      })
    })
  }

  /* ── 刷新与视图切换 ── */

  function refreshState(){
    return api('/admin/api/state').then(function (out) {
      if (out.ok !== true) {
        notice($('keysNotice'), '状态读不到：' + textOf(out.error, '未知原因'), true)
        return out
      }
      notice($('keysNotice'), '', false)
      state.keys = Array.isArray(out.keys) ? out.keys : []
      state.setup = out.setup || null
      renderPool(out.pool)
      renderSetup(out.setup, out.pool)
      renderKeys()
      var models = Array.isArray(out.models) ? out.models : []
      state.model = textOf(models[0], '')
      $('modelName').textContent = textOf(models[0], textOf(out.channel))
      $('baseUrl').textContent = location.origin + '/v1'
      return out
    })
  }

  function refreshAll(){
    return refreshState().then(function () {
      var tasks = [loadHealth()]
      if (state.view === 'accounts') tasks.push(renderAccountsView())
      return Promise.all(tasks).then(function () { return null })
    })
  }

  var segButtons = document.querySelectorAll('.seg')

  function switchView(view){
    state.view = view === 'accounts' ? 'accounts' : 'keys'
    for (var index = 0; index < segButtons.length; index++) {
      segButtons[index].setAttribute(
        'aria-selected',
        segButtons[index].getAttribute('data-view') === state.view ? 'true' : 'false',
      )
    }
    $('viewKeys').hidden = state.view !== 'keys'
    $('viewAccounts').hidden = state.view !== 'accounts'
    $('createBtn').hidden = state.view !== 'keys'
    $('usageBtn').hidden = state.view !== 'keys'
    if (state.view === 'accounts') renderAccountsView()
  }

  /* ── 事件绑定 ── */

  for (var segIndex = 0; segIndex < segButtons.length; segIndex++) {
    segButtons[segIndex].addEventListener('click', function (event) {
      switchView(event.currentTarget.getAttribute('data-view'))
    })
  }

  $('createBtn').addEventListener('click', openCreate)
  $('healthRefreshBtn').addEventListener('click', function (event) {
    var button = event.currentTarget
    button.disabled = true
    var original = button.textContent
    button.textContent = '检测中…'
    loadHealth().then(function () {
      button.disabled = false
      button.textContent = original
    })
  })
  $('tunnelCheckBtn').addEventListener('click', checkTunnel)
  $('updateCheckBtn').addEventListener('click', checkUpdateVersion)
  $('updateBtn').addEventListener('click', applyUpdate)
  $('authGateSubmit').addEventListener('click', submitAuthGate)
  $('authGateInput').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitAuthGate()
    }
  })
  $('modalCancel').addEventListener('click', closeModal)
  $('modalClose').addEventListener('click', closeModal)
  $('modalSave').addEventListener('click', function (event) { submitModal(event.currentTarget) })
  $('overlay').addEventListener('click', function (event) {
    if (event.target === event.currentTarget) closeModal()
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && $('overlay').hidden !== true) closeModal()
  })

  $('fieldName').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') submitModal($('modalSave'))
  })

  var scopeRadios = document.querySelectorAll('input[name="scopeMode"]')
  for (var radioIndex = 0; radioIndex < scopeRadios.length; radioIndex++) {
    scopeRadios[radioIndex].addEventListener('change', function () {
      var mode = scopeMode()
      $('accountsPicker').hidden = mode !== 'selected'
      if (mode === 'selected' && $('pickerList').childElementCount === 0) preparePicker([])
    })
  }

  $('pickerAll').addEventListener('click', function () {
    var boxes = document.querySelectorAll('#pickerList input[type="checkbox"]')
    for (var index = 0; index < boxes.length; index++) boxes[index].checked = true
  })
  $('pickerNone').addEventListener('click', function () {
    var boxes = document.querySelectorAll('#pickerList input[type="checkbox"]')
    for (var index = 0; index < boxes.length; index++) boxes[index].checked = false
  })

  $('usageBtn').addEventListener('click', function (event) {
    var drawer = $('drawer')
    if (drawer.hidden !== true) {
      drawer.hidden = true
      return
    }
    openUsage('all', event.currentTarget)
  })
  $('usageClose').addEventListener('click', function () { $('drawer').hidden = true })

  $('revealClose').addEventListener('click', hideReveal)
  $('revealCopy').addEventListener('click', function (event) {
    var value = state.copyBuffer
    if (value === '') return
    return busy(event.currentTarget, '复制中…', function () {
      return copyText(value).then(function (done) {
        var node = $('revealCopyState')
        node.textContent = done ? '已复制到剪贴板。' : '复制失败，请手动选中上面的 key 再复制。'
        node.className = done ? 'sub-line' : 'sub-line'
        if (done !== true) node.style.color = '#ff3b30'
        else node.style.color = ''
      })
    })
  })

  $('loginBtn').addEventListener('click', function (event) { startLogin(event.currentTarget) })
  $('loginOpen').addEventListener('click', openLoginPage)
  $('loginCancel').addEventListener('click', function (event) { cancelLogin(event.currentTarget) })
  $('loginClose').addEventListener('click', function () {
    stopLoginPolling()
    $('loginBox').hidden = true
  })
  $('loginCopy').addEventListener('click', function (event) {
    var value = $('loginUrl').textContent
    if (!value) return
    return busy(event.currentTarget, '复制中…', function () {
      return copyText(value).then(function (done) {
        $('loginStatus').textContent = done ? '链接已复制。' : '复制失败，请手动选中链接复制。'
        if (done !== true) $('loginStatus').style.color = '#ff3b30'
        else $('loginStatus').style.color = ''
      })
    })
  })

  /*
    首次进页面**不自动查上游版本**：那要打一次 GitHub API（未认证限流 60 次/小时），
    而打开页面这个动作太轻、不该带这个代价。先渲染「未知」，用户点「查上游版本」才真去查。
    —— 与 dsh-cpa-switch 把这条从 setup 接口拆出来、且面板挂载时只读一次同一个理由。
  */
  renderUpdate(state.update)

  refreshAll()
})()
</script>
</body></html>`
