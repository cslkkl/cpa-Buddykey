/**
 * BuddyKey 管理页 —— Apple 极简风，单文件静态资源（零依赖，纯字符串）。
 *
 * 两个占位符由 `server.mjs` 在响应前替换：
 *   - `__LAN_HINT__`  这台机器的局域网地址（手机要填的那个）
 *   - `__MODELS__`    允许的模型别名列表
 *
 * ⚠️ 本文件是 **模板字面量**：页面里的客户端脚本刻意不用模板字符串、
 *    不用反引号、不用反斜杠转义 —— 否则会在这一层被消费掉。
 *    `__MODELS__` 只出现一次（页脚），`__LAN_HINT__` 只出现一次（页脚）。
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

  <div class="segmented" role="tablist" aria-label="视图切换">
    <button class="seg" type="button" role="tab" data-view="keys" aria-selected="true">API Keys</button>
    <button class="seg" type="button" role="tab" data-view="accounts" aria-selected="false">账号</button>
  </div>

  <section id="viewKeys">
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
        <button class="btn" id="loginCopy" type="button">复制链接</button>
        <button class="btn danger" id="loginCancel" type="button">取消授权</button>
      </div>
      <p class="sub-line" id="loginStatus">在浏览器里打开上面这个地址完成授权（手机也能打开）。</p>
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

  function api(path, init){
    return fetch(path, init).then(function (response) {
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
    row.appendChild(cell('最近使用', [el('span', { class: 'muted', text: stampOf(key.lastUsedAt) })]))

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

  function renderAccounts(out){
    var body = $('accountRows')
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
          $('loginStatus').textContent = '等待授权…'
          return
        }
        $('loginStatus').textContent = '授权结束（' + textOf(out.status) + '）'
        stopLoginPolling()
        loadAccounts(true).then(function () { return refreshAll() })
      })
    }, 2000)
  }

  function startLogin(button){
    return busy(button, '起授权…', function () {
      return api('/admin/api/login', { method: 'POST' }).then(function (out) {
        $('loginBox').hidden = false
        if (out.ok !== true) {
          notice($('loginNotice'), '起不来登录：' + textOf(out.error, '未知原因'), true)
          return
        }
        notice($('loginNotice'), '', false)
        state.session = textOf(out.state, '')
        $('loginUrl').textContent = textOf(out.url)
        $('loginStatus').textContent = '等待授权…（在浏览器里打开上面这个地址）'
        startLoginPolling(state.session)
      })
    })
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
      renderPool(out.pool)
      renderKeys()
      var models = Array.isArray(out.models) ? out.models : []
      $('modelName').textContent = textOf(models[0], textOf(out.channel))
      $('baseUrl').textContent = location.origin + '/v1'
      return out
    })
  }

  function refreshAll(){
    return refreshState().then(function () {
      if (state.view === 'accounts') return renderAccountsView()
      return null
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

  refreshAll()
})()
</script>
</body></html>`
