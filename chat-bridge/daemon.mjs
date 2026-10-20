#!/usr/bin/env node
/**
 * chat.deepseek.com 桥接守护进程（桌宠用）。
 *
 * 走 stdio 行协议：每行一个 JSON。
 *   Python -> 这里（stdin）：
 *     {"id":1,"cmd":"status"}
 *     {"id":2,"cmd":"send","text":"你好"}
 *     {"id":3,"cmd":"stop"}
 *     {"id":4,"cmd":"focus"}         把聊天窗口切到前台
 *     {"id":5,"cmd":"quit"}
 *   这里 -> Python（stdout，每行一个 JSON）：
 *     {"type":"ready","edge":true,"page":true,"loggedIn":true}
 *     {"type":"ack","id":2,"ok":true}
 *     {"type":"delta","id":2,"text":"累计文本","done":false}
 *     {"type":"done","id":2,"text":"最终文本"}
 *     {"type":"error","id":2,"message":"..."}
 *     {"type":"state","streaming":true}
 *
 * 为什么用 CDP 而不是给用户已有 Edge 注入：跨进程做不到，所以自己起一个
 * 带 --remote-debugging-port 的专用 Edge（独立 user-data-dir，首次要登录）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { Cdp, launchEdge, sleep, evaluate, waitForLoad } from "./cdp.mjs";

const HERE = path.dirname(process.argv[1]);
const PORT = Number(process.env.CHAT_CDP_PORT || 9333);
const PROFILE = process.env.CHAT_PROFILE || path.join(HERE, "edge-profile");
const CHAT_URL = "https://chat.deepseek.com/";
const DEBUG_LOG = path.join(HERE, "bridge.log");

// ---- 日志（stdout 只走协议，日志一律走文件/stderr）----
const MAX_LOG = 256 * 1024;
function logLine(s) {
  try {
    if (fs.existsSync(DEBUG_LOG) && fs.statSync(DEBUG_LOG).size > MAX_LOG) {
      const keep = fs.readFileSync(DEBUG_LOG, "utf8").split("\n").slice(-200).join("\n");
      fs.writeFileSync(DEBUG_LOG, keep + "\n");
    }
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString().slice(11, 19)}  ${s}\n`);
  } catch (e) {}
}
logLine(`=== 桥接启动 port=${PORT} profile=${PROFILE} ===`);

// 桌宠进程退出后，我们往 stdout 写就会 EPIPE。
// 注意：**try/catch 抓不到它** —— 流错误是异步的 'error' 事件，
// 之前因此刷了 167 条 UNCAUGHT 崩溃栈（bridge.log 里能看到）。
// 正确做法：挂上 error 监听，并且写之前先确认流还活着。
let stdoutAlive = true;
try {
  process.stdout.on("error", (e) => {
    if (e && (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED")) {
      // 宿主没了，协议也就没意义了：安静退出，别再刷栈
      stdoutAlive = false;
      process.exit(0);
    }
    stdoutAlive = false;
  });
} catch (e) {}

function out(obj) {
  if (!stdoutAlive) return;
  try {
    if (!process.stdout.writable) {
      stdoutAlive = false;
      return;
    }
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (e) {
    stdoutAlive = false;
  }
}

/**
 * 把「聊天页」所在的那个 Edge 窗口最小化。
 *
 * 先前是按进程名找"标题含 deepseek 的 msedge 窗口"，会把 DSH 页的窗口也一起
 * 最小化，而且没法区分是哪一条。现在改成：
 *   1. 用 CDP 找到**聊天页 target**，读它的 windowId（= 窗口 id，同窗口的标签页相同）
 *   2. 用 Browser.getWindowBounds 验证这个 id 有效
 *   3. PowerShell 里按窗口标题（含 deepseek、不含 DeepSeek Harness）定位并最小化
 * 找不到就返回 false（不报错）—— 比如页面还没渲染出标题。
 */
/** 屏幕尺寸缓存（只查一次）。 */
let screenSizeCache = null;
async function screenSize() {
  if (screenSizeCache) return screenSizeCache;
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
         "Add-Type -AssemblyName System.Windows.Forms; " +
         "'{0},{1}' -f [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, " +
         "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height"],
        { timeout: 8000 },
        (err, stdout) => {
          const m = /(\d+)\s*,\s*(\d+)/.exec(String(stdout || ""));
          const r = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1920, h: 1080 };
          screenSizeCache = r;
          resolve(r);
        });
    } catch (e) {
      screenSizeCache = { w: 1920, h: 1080 };
      resolve(screenSizeCache);
    }
  });
}

/**
 * "挪到屏幕最旁边"的窗口矩形：贴在右下角、只露出一块（够看见、也够点进去登录）。
 * 给 Edge 的 --window-position/--window-size 用，让它出生就在角落。
 */
async function asideWindowRect() {
  const s = await screenSize();
  return [Math.max(0, s.w - 420), Math.max(0, s.h - 320), 900, 700];
}

/**
 * 对「聊天页那个 Edge 窗口」做一次窗口操作。
 *
 * 按**窗口标题**匹配（"含 deepseek、不含 DeepSeek Harness"），并且**只在 Edge 进程里找**。
 * 为什么这样是安全的：
 *   · 聊天输入框窗口属于 python 进程 —— 枚举 msedge 时自然不会选中它（踩过这个坑：
 *     输入框标题"和 DeepSeek 说话"也含 deepseek，按标题找会认错窗口）；
 *   · DSH 页标题带 "DeepSeek Harness"，被排除掉。
 * 注：CDP 的 Browser.getVersion 与 /json/version 都**不提供浏览器进程号**，
 * 所以没法用 pid 来锁定窗口，只能按标题 + 进程名双重约束。
 *
 * action: "minimize"（最小化）| "aside"（挪到屏幕最旁边、露出一角）| "restore"（恢复显示）
 */
async function chatWindowAction(cdp, action) {
  const body = {
    minimize: "    $t::ShowWindow($h,6) | Out-Null; $found=$true",
    restore: "    $t::ShowWindow($h,9) | Out-Null; $found=$true",
    aside:
      // 先把窗口恢复出来（最小化状态下 SetWindowPos 只改"还原位置"），再挪到右下角
      "    $t::ShowWindow($h,4) | Out-Null;" +
      "    $t::SetWindowPos($h,[IntPtr]::Zero,$x,$y,900,700,0x0010) | Out-Null; $found=$true",
  }[action] || "    $found=$false";

  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$sig='[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int n);" +
      "[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);" +
      "[DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);'",
    "$t=Add-Type -MemberDefinition $sig -Name W -Namespace Q -PassThru",
    "$sw=$t::GetSystemMetrics(0); $sh=$t::GetSystemMetrics(1)",
    "$x=[Math]::Max(0, $sw-420); $y=[Math]::Max(0, $sh-320)",
    "$found=$false",
    "Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object {" +
      "  $h=$_.MainWindowHandle; $ti=$_.MainWindowTitle;" +
      "  if ($h -ne 0 -and $ti -match 'deepseek' -and $ti -notmatch 'DeepSeek Harness') {" +
      body + " } }",
    "if ($found) { 'DONE' } else { 'NOTFOUND' }",
  ].join("; ");

  const label = { minimize: "最小化聊天窗口", restore: "恢复聊天窗口", aside: "把聊天窗口挪到屏幕最旁边" }[action] || action;
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 8000 },
        (err, stdout) => {
          const ok = String(stdout || "").includes("DONE");
          logLine(`${label}：${ok ? "成功" : "没找到窗口"}`);
          resolve(ok);
        });
    } catch (e) {
      logLine(`${label}异常：${e.message}`);
      resolve(false);
    }
  });
}

/**
 * 关掉专用 Edge 的所有进程。
 *
 * 按它**独有的 user-data-dir**（…chat-bridge\edge-profile）精确匹配，
 * 不会碰到用户自己的 Edge。用于处理"进程还在但没有窗口"的空壳状态。
 */
async function killDedicatedEdge() {
  const ps =
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${PROFILE}*' } | ` +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  await new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 12000 },
        () => resolve(true));
    } catch (e) {
      resolve(false);
    }
  });
  // **等端口真正消失再返回**。不等的话，紧接着的启动会撞上还没退干净的旧实例：
  // Chromium 会把 URL 转发给旧实例（于是多开一个网页）然后自己退出。
  for (let i = 0; i < 20; i++) {
    if (!(await debugPortAlive(500))) return true;
    await sleep(200);
  }
  logLine("旧 Edge 端口一直没释放（继续尝试启动）");
  return true;
}

/**
 * 带超时的 HTTP 探测。
 *
 * 为什么必须限时：浏览器进程可能还在、端口也还能连上，但**不回应**任何 CDP 请求
 * （实测就是这种"空壳"状态）。不加超时的话这里会一直等下去，用户按按钮毫无反应。
 */
async function fetchJson(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 快速探测专用 Edge 的调试端口（不到 1 秒就返回）。
 * 用于"浏览器还在不在"的快速判定，避免走会等满 CDP 超时的慢路径。
 */
async function debugPortAlive(timeoutMs = 600) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: ctrl.signal });
    return r.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 把聊天页窗口挪到屏幕最旁边（右下角露出一角）。登录完会被收尾任务最小化。 */
async function moveChatWindowAside(cdp) {
  return chatWindowAction(cdp, "aside");
}

/**
 * 带重试的窗口操作。
 *
 * 为什么必须重试：这个操作是按**窗口标题**匹配的（"含 deepseek"），
 * 而 Edge 刚起来的窗口标题要等页面加载完才带上 deepseek ——
 * 于是"导航后立刻挪到旁边"经常匹配不到。之前不重试，结果窗口就一直停在
 * 屏幕右下角露一角的样子，用户看着像"没打开"（实测复现过：
 * 日志里 `把聊天窗口挪到屏幕最旁边：没找到窗口` 之后就没动静了）。
 */
async function chatWindowActionRetry(cdp, action, tries = 20, delayMs = 350) {
  for (let i = 0; i < Math.max(1, tries); i++) {
    const ok = await chatWindowAction(cdp, action);
    if (ok) return true;
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * 把聊天页窗口恢复正常显示（自愈用）。
 *
 * 如果页面是在最小化状态下初始化的，DeepSeek 前端不会建消息列表 ——
 * 表现为"发送没反应、回复抓不到"。把窗口显示出来，页面会重新渲染，就能恢复。
 */
function restoreChatWindow() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$sig='[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int n);'",
    "$t=Add-Type -MemberDefinition $sig -Name R -Namespace Q -PassThru",
    "$found=$false",
    "Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $h=$_.MainWindowHandle; $ti=$_.MainWindowTitle",
    "  if ($h -ne 0 -and $ti -match 'deepseek' -and $ti -notmatch 'DeepSeek Harness') {",
    "    $t::ShowWindow($h,9) | Out-Null; $found=$true",   // SW_RESTORE
    "  }",
    "}",
    "if ($found) { 'RESTORED' } else { 'NOTFOUND' }",
  ].join("; ");
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 8000 },
        (err, stdout) => {
          const ok = String(stdout || "").includes("RESTORED");
          logLine(`恢复聊天窗口：${ok ? "成功" : "没找到窗口"}`);
          resolve(ok);
        });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 把聊天页窗口挪到**屏幕最旁边**（右下角，只露出一小部分）。
 *
 * 用户要的顺序是：按下说话按钮 → 先挪到最旁边 → 登录成功后再最小化。
 * 所以这里不能完全挪出屏幕（那样用户点不到、没法登录），
 * 而是贴着右下角露出一块，登录完由观察器自动最小化。
 * 同时窗口保持"可见"状态（不最小化），页面渲染和发送都正常。
 */
function moveChatWindowOffscreen() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$sig='[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int n);" +
    "[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);" +
    "[DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);'",
    "$t=Add-Type -MemberDefinition $sig -Name O -Namespace Q -PassThru",
    "$sw=$t::GetSystemMetrics(0); $sh=$t::GetSystemMetrics(1)",
    // 露出左下角一块：够看见登录页、也能点进去操作
    "$x=[Math]::Max(0, $sw-420); $y=[Math]::Max(0, $sh-320)",
    "$found=$false",
    "Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object {",
    "  $h=$_.MainWindowHandle; $ti=$_.MainWindowTitle",
    "  if ($h -ne 0 -and $ti -match 'deepseek' -and $ti -notmatch 'DeepSeek Harness') {",
    // 注意：这里必须先把最小化的窗口恢复出来，否则 SetWindowPos 只改"还原位置"，
    // 窗口看起来还是最小化的。SW_SHOWNOACTIVATE = 4（不是 9：9 不是标准恢复值，
    // 实测没效果，窗口依旧 IsIconic）。
    "    $t::ShowWindow($h,4) | Out-Null",
    "    $t::SetWindowPos($h,[IntPtr]::Zero,$x,$y,900,700,0x0040) | Out-Null",
    "    $found=$true",
    "  }",
    "}",
    "if ($found) { \"MOVED $x,$y\" } else { 'NOTFOUND' }",
  ].join("; ");
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 8000 },
        (err, stdout) => {
          const ok = String(stdout || "").includes("MOVED");
          logLine(`把聊天窗口挪到屏幕最旁边：${ok ? "成功" : "没找到窗口"}`);
          resolve(ok);
        });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 从 completion 接口的 SSE 响应体里抽出助手回复。
 *
 * 为什么走网络而不是读 DOM：实测页面有时会把消息列表渲染坏（DOM 里连用户消息都没有），
 * 但接口一直是正常的 —— 网络层才是可靠数据源。
 *
 * 响应体里**同一个回复会以三种格式出现**，缺一不可（踩过坑：只认第一种会只拿到开头几个字）：
 *   1. 首块：data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"队列"}]}}}
 *   2. 追加：data: {"p":"response/fragments/-1/content","o":"APPEND","v":"是一种"}
 *   3. 再追加：data: {"v":"遵循"}                ← 裸 v，没有 p
 * 结尾：data: {"p":"response/status","o":"SET","v":"FINISHED"} + event: close
 */
function parseCompletionSse(raw) {
  const frags = [];
  let thinking = "";
  let finalText = "";
  let closed = false;
  let finished = false;
  let messageId = null;
  let fragCount = 0;
  // 协议里所有追加都打到"最后一个片段"（response/fragments/-1/content）。
  // 思考阶段最后那个片段是 THINKING，正文阶段才变成 RESPONSE ——
  // 所以必须记住"当前片段类型"，否则思考内容会被当成正文追加进去
  //（用户反馈"气泡里全是深度思考"就是这个）。
  let currentType = "RESPONSE";
  // 实测 DeepSeek 接口里思考片段的 type 是 **"THINK"**（不是 "THINKING"），
  // 另外见过 "THINKING"/"REASONING" 的写法，一并认。
  const isThinkType = (t) => {
    const u = String(t || "").toUpperCase();
    return u === "THINK" || u === "THINKING" || u === "REASONING";
  };
  for (const block of String(raw || "").split("\n\n")) {
    let event = "";
    const datas = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) datas.push(line.slice(6));
    }
    if (event === "close") closed = true;
    for (const d of datas) {
      if (!d || d === "[DONE]") continue;
      let j;
      try { j = JSON.parse(d); } catch (e) { continue; }

      const resp = j && j.v && j.v.response;
      if (resp && resp.message_id != null) messageId = resp.message_id;
      const list = resp && resp.fragments;
      if (Array.isArray(list)) {
        fragCount += list.length;
        for (const f of list) {
          if (!f || typeof f.content !== "string") continue;
          const ty = String(f.type || "RESPONSE").toUpperCase();
          currentType = ty;
          if (isThinkType(ty)) thinking += f.content;
          else frags.push(f.content);
        }
      }
      if (resp && typeof resp.content === "string") finalText = resp.content;

      // 格式 2：{"p":"response/fragments/-1/content","o":"APPEND","v":"..."}
      // 片段数组整体追加：{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"递归"}]}
      // **正文片段就是靠这个进来的**，原代码只处理 v 是字符串的情况，于是整个正文被丢掉、
      // currentType 也一直停在 THINK，后续逐字追加全被算成思考内容。
      if (typeof j.p === "string" && Array.isArray(j.v)) {
        if (/response\/fragments/.test(j.p)) {
          for (const f of j.v) {
            if (!f || typeof f.content !== "string") continue;
            const ty = String(f.type || "RESPONSE").toUpperCase();
            currentType = ty;
            if (isThinkType(ty)) thinking += f.content;
            else frags.push(f.content);
          }
        }
        continue;
      }
      // 批量补丁：{"p":"response","o":"BATCH","v":[{"p":"...","v":"..."}]}
      if (j.o === "BATCH" && Array.isArray(j.v)) {
        for (const inner of j.v) {
          if (!inner || typeof inner.p !== "string") continue;
          if (/think|reason/i.test(inner.p)) { thinking += String(inner.v == null ? "" : inner.v); continue; }
          if (/response\/fragments.*content/.test(inner.p) && typeof inner.v === "string") {
            if (isThinkType(currentType)) thinking += inner.v;
            else frags.push(inner.v);
          }
        }
        continue;
      }
      if (typeof j.p === "string" && typeof j.v === "string") {
        if (/think|reason/i.test(j.p)) { thinking += j.v; continue; }
        if (/response\/fragments.*content/.test(j.p)) {
          // 追加到"最后一个片段"：按当前片段类型分流，别把思考内容混进正文
          if (isThinkType(currentType)) thinking += j.v;
          else frags.push(j.v);
          continue;
        }
        if (/response\/status/.test(j.p)) { finished = j.v === "FINISHED"; continue; }
        continue;
      }
      // 格式 3：裸 {"v":"..."}（追加到当前片段，同样按类型分流）
      if (typeof j.v === "string") {
        if (isThinkType(currentType)) thinking += j.v;
        else frags.push(j.v);
        continue;
      }
      // 别处见过的数组形式
      if (Array.isArray(j.fragments)) {
        for (const f of j.fragments) {
          if (!f || typeof f.content !== "string") continue;
          const ty = String(f.type || "RESPONSE").toUpperCase();
          currentType = ty;
          if (isThinkType(ty)) thinking += f.content;
          else frags.push(f.content);
        }
      }
    }
  }
  // finalText（整段 content）优先；否则把各种追加拼起来。
  // 正文优先取"逐片拼接"的结果：响应级的 content 有时装的是**思考内容**
  //（实测 resp.content 就是 THINK 那一段），直接用它会把正文弄丢。
  const joined = frags.join("");
  let text = joined;
  if (!text && finalText) text = finalText;
  // 若整段 content 把思考也拼在前面，剥掉它（剥完为空就退回逐片拼接）
  if (thinking && text.startsWith(thinking)) {
    const rest = text.slice(thinking.length);
    text = rest.length ? rest : joined;
  }
  return {
    text: text.trim(),
    thinking,
    closed,
    finished,
    frags: fragCount,
    messageId,
  };
}

// ---- 找聊天页 ----
async function findPageTarget(cdp) {  const { targetInfos } = await cdp.send("Target.getTargets");
  return (
    targetInfos.find((t) => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ||
    targetInfos.find((t) => t.type === "page" && /deepseek\.com/.test(t.url))
  );
}

async function attach(cdp, target) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return sessionId;
}

/** 页面侧的小工具集（注入一次，之后复用）。
 *  版本号很重要：页面会一直留着上一版注入的 __dshPetChat，改代码后必须靠它强制重装。 */
const HELPER_VERSION = 5;
const HELPERS = `(() => {
  if (window.__dshPetChat && window.__dshPetChatVersion === ${HELPER_VERSION}) return 'already';
  const q = (sel) => document.querySelector(sel);
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // 去掉"深度思考"块，只留正式回复正文。
  // 思考内容渲染在回复容器内部（collapsible），直接 innerText 会把推理过程一起带出来。
  const stripThinking = (el) => {
    if (!el) return '';
    let clone;
    try { clone = el.cloneNode(true); } catch (e) { return el.innerText || ''; }
    // 1) 常见的类名标记（ds-think / thinking / reasoning / details 折叠块）
    try {
      clone.querySelectorAll('[class*="think" i],[class*="reason" i],details').forEach((n) => n.remove());
    } catch (e) { /* 老内核不支持 i 标志就跳过 */ }
    // 2) 兜底：按文案剔掉"已深度思考（用时 X 秒）…"那一段
    try {
      clone.querySelectorAll('div,section,li,p,span').forEach((n) => {
        const t = (n.textContent || '').trim();
        if (!t) return;
        if (t.startsWith('已深度思考') || t.startsWith('深度思考') || /^Thinking\b/i.test(t)) n.remove();
      });
    } catch (e) { /* 忽略 */ }
    return (clone.innerText || clone.textContent || '').trim();
  };
  const api = {
    input: () => [...document.querySelectorAll('textarea[placeholder]')].find(vis) || null,
    blocks: () => [...document.querySelectorAll('[class*="ds-markdown"]')],
    sendBtn: () => {
      const cands = [...document.querySelectorAll('div[class*="ds-button"], button')];
      let best = null, bestScore = 0;
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.width > 120 || r.height > 120) continue;
        const c = String(el.className || '');
        if (c.includes('disabled')) continue;
        let s = 0;
        if (c.includes('ds-button--primary')) s += 6;
        if (c.includes('circle')) s += 6;
        if (c.includes('filled')) s += 3;
        if (s > bestScore) { bestScore = s; best = el; }
      }
      return bestScore > 0 ? best : null;
    },
    /** 流式回复期间的「停止生成」按钮：没有 primary 特征，通常是方形/实心的小按钮 */
    stopBtn: () => {
      const cands = [...document.querySelectorAll('div[class*="ds-button"], button')];
      for (const el of cands) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.width > 120 || r.height > 120) continue;
        const c = String(el.className || '');
        const aria = (el.getAttribute('aria-label') || el.title || '');
        if (/stop|cancel|停止|中止/i.test(c + ' ' + aria)) return el;
        // 圆形实心按钮里，发送键之外的那个（方形的）通常是停止
        if (c.includes('circle') && !c.includes('ds-button--primary') && c.includes('filled')) return el;
      }
      return null;
    },
    lastText: () => {
      const bs = api.blocks();
      return bs.length ? stripThinking(bs[bs.length - 1]) : '';
    },
    /**
     * 助手回复块。注意：一条回复在 DOM 里是**两层嵌套**的 ds-markdown
     *（内层 ds-assistant-message-main-content，外层也是 ds-markdown），
     * 所以不能用 [class*="ds-markdown"] 取最后一个 —— 会拿到同一条的两份。
     * 这里只取带 ds-assistant-message-main-content 的那层，一条回复对应一个。
     */
    replies: () => [...document.querySelectorAll('[class*="ds-assistant-message-main-content"]')],
    replyCount: () => api.replies().length,
    replyTextAt: (i) => {
      const rs = api.replies();
      if (i < 0 || i >= rs.length) return null;
      return stripThinking(rs[i]);
    },
    /**
     * 助手回复的快照：按"纵向位置"去重后返回文本数组。
     * 同一个回复在 DOM 里可能有多个嵌套元素（纵向位置相同），页面重载后
     * 元素个数也会变，所以条数不可靠 —— 用"位置 + 文本"来认。
     */
    snapReplies: () => {
      const seen = new Map();
      for (const el of api.replies()) {
        const r = el.getBoundingClientRect();
        const key = Math.round(r.top);
        const text = stripThinking(el);
        const prev = seen.get(key);
        if (prev === undefined || text.length > prev.length) seen.set(key, text);
      }
      return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    },
    setText: (t) => {
      const ta = api.input();
      if (!ta) return { ok: false, error: 'no input' };
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, t);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },
  };
  window.__dshPetChat = api;
  window.__dshPetChatVersion = ${HELPER_VERSION};
  return 'installed';
})()`;

class Bridge {
  constructor() {
    this.cdp = null;
    this.sessionId = null;
    this.edgeProc = null;
    this.streaming = false;
    this.currentId = null;
    this.lastText = "";
    this.pollTimer = null;
    this.pageReady = false;
    // 网络层抓到的 completion 响应（比读 DOM 可靠：页面有时渲染坏但接口正常）
    this.netBodies = [];
    this.netPending = new Set();
    this.netHooked = false;
    this.netHookedOn = null;   // 监听挂在哪个 cdp 连接对象上（换连接要重挂）
    this.forceFreshLaunch = false;   // CDP 刚失效时置位：下面不要复用旧浏览器
    this._ensureChain = Promise.resolve();   // ensurePage 串行链（防止并发起两个 Edge）
  }

  /** 打开 Network 域并挂上 completion 响应监听（幂等，可反复调）。 */
  async hookNetwork() {
    if (!this.cdp || !this.sessionId) return;
    try {
      await this.cdp.send("Network.enable", {}, this.sessionId);
    } catch (e) {
      logLine(`Network.enable 失败：${e.message}`);
      return;
    }
    // **关键**：事件监听是挂在 cdp 这个**具体连接对象**上的，重启浏览器后
    // this.cdp 是全新对象。原来这里用布尔 netHooked 判断，一旦为 true 就直接
    // return —— 于是新连接上永远没有监听，表现为"消息能发出去、但抓不到回复"
    // （实测：关掉专用 Edge 再打开后必现）。所以必须按**连接对象**来判重。
    if (this.netHookedOn === this.cdp) return;
    this.netHookedOn = this.cdp;
    this.netHooked = true;
    this.netPending = new Set();     // 旧请求 id 对新连接没意义
    this.cdp.on("Network.responseReceived", (p, sid) => {
      if (sid !== this.sessionId) return;
      try {
        if (/\/api\/v0\/chat\/completion/.test(p.response.url)) {
          this.netPending.add(p.requestId);
          logLine(`发现 completion 请求（${p.response.status}）`);
        }
      } catch (e) {}
    });
    this.cdp.on("Network.loadingFinished", async (p, sid) => {
      if (sid !== this.sessionId || !this.netPending.has(p.requestId)) return;
      this.netPending.delete(p.requestId);
      try {
        const r = await this.cdp.send("Network.getResponseBody", { requestId: p.requestId }, this.sessionId);
        const body = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
        const parsed = parseCompletionSse(body);
        if (parsed.text) {
          this.netBodies.push(parsed);
          // 只留最近一批：抓取逻辑是按索引基线取新增的，老数据没有用了
          if (this.netBodies.length > 50) this.netBodies = this.netBodies.slice(-50);
          logLine(
            `completion 响应体 #${this.netBodies.length}：${body.length} 字节 / 文本 ${parsed.text.length} 字 / 思考 ${(parsed.thinking||'').length} 字 / fragments=${parsed.frags} / closed=${parsed.closed} / msgId=${parsed.messageId}`
          );
        } else {
          logLine(`completion 响应里没解析出文本（${body.length} 字节）`);
        }
      } catch (e) {
        logLine(`取 completion 响应体失败：${e.message}`);
      }
    });
    logLine("已在新连接上挂好 completion 抓取监听");
  }

  emit(o) { out(o); }

  /**
   * 确保 Edge + 页面 + attach + helper 都就绪；返回 true 表示可用。
   *
   * **必须串行化**：status 和 open-chat 这类命令可能几乎同时到达，两个
   * ensurePage 并发跑就会**各自启动一个 Edge** —— Chromium 检测到已有实例后
   * 会把 URL 转发过去，于是用户看到"一下子打开两个网页"（实测冷启动必现）。
   */
  async ensurePage(opts = {}) {
    const prev = this._ensureChain || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._ensurePageInner(opts));
    // 链上只保留"完成"信号，避免未处理的拒绝
    this._ensureChain = run.then(() => {}, () => {});
    return run;
  }

  async _ensurePageInner({ launchIfNeeded = true } = {}) {
    if (this.cdp && this.sessionId && !this.pageReady) {
      // 有连接但 helper 没装（或装的是旧版）
      try {
        await evaluate(this.cdp, this.sessionId, HELPERS);
        this.pageReady = true;
      } catch (e) {
        logLine(`补装 helper 失败：${e.message}`);
      }
    }

    if (this.cdp && this.sessionId) {
      // 已有连接：确认会话还活在那个 target 上，并保证 helper 是当前版本
      try {
        const t = await findPageTarget(this.cdp);
        if (t && t.targetId === this.targetId) {
          await evaluate(this.cdp, this.sessionId, HELPERS);   // 版本不符会自动重装
          await this.hookNetwork();                            // 顺带保证网络监听在
          this.pageReady = true;
          return true;
        }
        if (t) {
          // 同一个页面换了 target（新对话导航 / 页面重载）：旧 sessionId 已经作废
          logLine(`页面 target 变了（${String(this.targetId).slice(0, 8)} → ${String(t.targetId).slice(0, 8)}），重新 attach`);
          this.sessionId = await attach(this.cdp, t);
          this.targetId = t.targetId;
          await sleep(600);
          await evaluate(this.cdp, this.sessionId, HELPERS);
          this.pageReady = true;
          return true;
        }
        logLine("目标页面不在了，重新 attach");
        this.sessionId = null;
      } catch (e) {
        const msg = String((e && e.message) || e);
        // **超时 ≠ 连接失效**（这是最关键的一条）。
        // 页面正在导航/渲染时渲染进程很忙，evaluate 可能好几秒不回应；此时若判定
        // "连接失效"并杀掉旧浏览器，就会把**正在启动的浏览器**干掉 ——
        // 实测表现就是"第一次打开几乎必失败、第二次才成功"。
        // 所以：只要是超时（用错误码判断，不靠匹配文案），就**多轮重试**；
        // 只有端口真的不通了，才算连接失效、才去重启浏览器。
        if (e && e.code === "CDP_TIMEOUT") {
          let lastErr = msg;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (!(await debugPortAlive(800))) {
              logLine("调试端口已消失（浏览器真的没了）");
              break;
            }
            logLine(`命令超时，第 ${attempt} 次重试（浏览器仍在）：${lastErr}`);
            try {
              const t2 = await findPageTarget(this.cdp);
              if (t2) {
                if (t2.targetId !== this.targetId) {
                  this.sessionId = await attach(this.cdp, t2);
                  this.targetId = t2.targetId;
                  await sleep(400);
                }
                await this.hookNetwork();
                this.pageReady = true;
                logLine(`重试第 ${attempt} 次成功`);
                return true;
              }
              lastErr = "没有找到聊天页 target";
            } catch (e2) {
              lastErr = e2 && e2.message ? e2.message : String(e2);
              if (e2 && e2.code !== "CDP_TIMEOUT" && !(await debugPortAlive(600))) break;
            }
            await sleep(600);
          }
          logLine(`重试都没成功：${lastErr}`);
        }
        logLine(`CDP 连接失效：${msg}`);
        this.cdp = null;
        this.sessionId = null;
        this.pageReady = false;
        // 刚失效的那个浏览器已经不可信了：标记为"别复用"，
        // 否则下面会连回同一个空壳，再卡一次（实测会导致"要按两次才生效"）。
        this.forceFreshLaunch = true;
      }
    }
    if (!this.cdp) {
      // 先试连已有的调试端口（Edge 可能已经在跑）
      let reuse = false;
      if (this.forceFreshLaunch) {
        this.forceFreshLaunch = false;
        // 端口还活着才需要"杀掉空壳/僵尸进程"（那一步要枚举进程，比较慢）。
        // 端口已拒绝连接就说明浏览器本来就没了，直接启动，省掉这几秒。
        if (await debugPortAlive(600)) {
          logLine("上次连接已失效，且端口仍占着：先关掉旧浏览器再重启");
          await killDedicatedEdge();
          await sleep(400);
        } else {
          logLine("上次连接已失效（浏览器已退出）：直接重新启动专用 Edge");
        }
      } else {
      try {
        const ver = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
        // 关键：光能连上不算"可用"。用户手动关掉专用 Edge 的窗口后，**进程可能还活着**
        // （Chromium 在窗口全关后未必退出）——这时端口能连、但没有任何标签页，
        // 复用它会一直失败（实测：daemon 就此卡死，按按钮毫无反应）。
        // 所以只有确实存在页面 target 才复用，否则把这个空壳进程关掉、重新启动一个。
        let hasTarget = false;
        try {
          const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
          hasTarget = Array.isArray(list) && list.some((t) => t.type === "page");
        } catch (e) {
          hasTarget = false;
        }
        if (hasTarget) {
          this.cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
          reuse = true;
          logLine(`复用已在运行的 Edge：${ver.Browser}`);
        } else {
          logLine("调试端口在，但没有任何标签页（窗口被关掉了）：关掉这个空壳 Edge 并重新启动");
          await killDedicatedEdge();
          await sleep(800);
        }
      } catch (e) {
        /* 端口连不上，正常走下面的启动流程 */
      }
      }
      if (!reuse && !this.cdp) {
        if (!launchIfNeeded) return false;
        logLine("没有可用的调试端口，启动专用 Edge");
        const launched = await launchEdge({
          port: PORT,
          profileDir: PROFILE,
          url: CHAT_URL,
          // 注意：这里**不能**用 startMinimized。
          // 页面如果在"出生就最小化"的窗口里初始化，DeepSeek 前端不会把消息列表
          // 建起来（实测 DOM 里 0 个消息块、点发送也毫无反应），于是永远抓不到回复。
          // 正确做法是：让页面正常加载可见，等它就绪后再最小化（见 openChat）。
          // 但"可见"不等于"摆屏幕中间"：直接用 --window-position 出生就放到右下角，
          // 这样既满足可见、又不会在用户面前闪一下（实测就是这个闪现）。
          windowRect: await asideWindowRect(),
          log: logLine,
        });
        this.cdp = launched.cdp;
        this.edgeProc = launched.proc;
      }
    }
    let target = await findPageTarget(this.cdp);
    if (!target) {
      logLine("没有聊天页，新建一个");
      const { targetId } = await this.cdp.send("Target.createTarget", { url: CHAT_URL });
      await sleep(1200);
      const infos = await this.cdp.send("Target.getTargets");
      target = infos.targetInfos.find((t) => t.targetId === targetId);
    }
    if (!target) return false;
    this.sessionId = await attach(this.cdp, target);
    this.targetId = target.targetId;
    await sleep(400);
    try { await evaluate(this.cdp, this.sessionId, HELPERS); } catch (e) { logLine(`注入 helper 失败：${e.message}`); }
    // **必须挂上网络抓取监听**：发消息走 DOM 不需要它，但"抓回复"完全依赖它。
    // 原来这条全新启动的路径漏了这一步，于是"关掉专用 Edge 再打开后消息能发、
    // 气泡却永远抓不到回复"（实测就是这个问题）。
    // 注意必须在 send 之前挂好：Network.enable 之后发生的请求才能被监听。
    await this.hookNetwork();
    this.pageReady = true;
    return true;
  }

  async status() {
    // 快速路径：先花不到 1 秒探一下调试端口。
    //
    // **这里不能加 `if (!this.cdp)` 之类的条件** —— 浏览器被关掉后 this.cdp
    // 往往还残留着（WebSocket 没触发 close），一旦被它挡住就会走 ensurePage
    // 那条老路：连着重试、每条命令等满超时（实测白白多花约 14 秒，
    // 用户感觉"按了卡住不动"）。所以无条件先探端口：不通就直接判定需要打开。
    if (!(await debugPortAlive())) {
      this.cdp = null;
      this.sessionId = null;
      this.pageReady = false;
      return { edge: false, page: false, loggedIn: false, needsOpen: true };
    }
    try {
      const ok = await this.ensurePage({ launchIfNeeded: false });
      if (!ok) {
        // 连不上 CDP 或没有聊天页：告诉上层"需要打开"
        return { edge: false, page: false, loggedIn: false, needsOpen: true };
      }
      const st = await evaluate(this.cdp, this.sessionId, `(() => {
        const ta = window.__dshPetChat ? window.__dshPetChat.input() : null;
        const hasLogin = [...document.querySelectorAll('button,div[role="button"]')]
          .some(b => /^(登录|注册|Log in|Sign in)$/i.test((b.innerText||'').trim()));
        const url = location.href;
        // 登录判定**只看有没有登录按钮**，不要额外要求"输入框已渲染"。
        // 原来写的是 (!hasLogin && !!ta)，而页面刚打开/刚导航完的那一两秒输入框
        // 往往还没渲染出来（ta 为 null）—— 于是已登录的账号被误报成
        // "还没登录 chat.deepseek.com，请去登录一次"，把用户往错误方向引。
        // 没有登录按钮就说明已登录（登录页必然有登录/注册按钮）；输入框在不在
        // 只影响"能不能立刻发消息"，由 hasInput 单独表达。
        return { page: /chat\.deepseek\.com/.test(url), hasInput: !!ta,
                 loggedIn: !hasLogin, url,
                 replies: window.__dshPetChat ? window.__dshPetChat.snapReplies().length : 0 };
      })()`);
      return { edge: true, ...st, needsOpen: !st.page };
    } catch (e) {
      logLine(`status 失败：${e.message}`);
      return { edge: false, page: false, loggedIn: false, needsOpen: true };
    }
  }

  /** 确保聊天页开着（没有就导航过去），**等页面真正加载并渲染出输入框**后再最小化窗口。 */
  async openChat() {
    const ok = await this.ensurePage({ launchIfNeeded: true });
    if (!ok) throw new Error("起不了专用 Edge");
    let moved = false;
    let url = "";
    try {
      url = String(await evaluate(this.cdp, this.sessionId, `location.href`));
    } catch (e) {}
    if (!/chat\.deepseek\.com/.test(url)) {
      logLine(`聊天页不在（当前 ${url.slice(0, 60)}），导航过去`);
      // 导航单独给更长的超时：默认 6 秒对 Edge 冷启动 + chat.deepseek.com 首包太紧，
                // 实测经常超时（日志里一堆 "Page.navigate 6000ms"），随后又多跑一轮重试。
                // 导航本身不需要等页面完全加载完，CDP 回一个 frameId 就够了，所以放宽即可。
                await this.cdp.send("Page.navigate", { url: CHAT_URL }, this.sessionId, 20000);
      // 用户要的顺序：**一打开就先挪到屏幕最旁边**，别让它以正常大小弹在前台。
      // 所以这里不等页面就绪，导航一发出就把窗口挪走（Edge 进程此时已经在了）。
      moved = await moveChatWindowAside(this.cdp);
      // 等 document.readyState=complete，别用固定 sleep —— 页面还没加载完就最小化，
      // DeepSeek 前端会在不可见状态下初始化，之后的发送/抓取全是坏的（实测复现过）
      await waitForLoad(this.cdp, this.sessionId, 12000);
      await sleep(400);
    } else {
      // 页面本来就在：也先挪到一边，避免它正好停在前台挡住桌宠
      moved = await moveChatWindowAside(this.cdp);
    }

    // 关键：必须等页面**可见地**把输入框渲染出来，再最小化。
    // 页面如果在最小化状态下初始化，DeepSeek 前端不会建消息列表 ->
    // 发送没反应、回复也抓不到（实测复现过）。
    // 注意"挪到旁边"是安全状态（窗口仍可见），所以上面可以先挪再等。
    let ready = false;
    for (let i = 0; i < 14; i++) {
      try {
        const r = await evaluate(this.cdp, this.sessionId, `(() => {
          if (!window.__dshPetChat) return { inject: true };
          return { hasInput: !!window.__dshPetChat.input() };
        })()`);
        if (r && r.inject) {
          await evaluate(this.cdp, this.sessionId, HELPERS);
          await sleep(300);
          continue;
        }
        if (r && r.hasInput) { ready = true; break; }
      } catch (e) {
        logLine(`等输入框重试：${e.message}`);
      }
      await sleep(500);
    }

    let minimized = false;
    if (ready) {
      // 已登录：页面能正常用，直接最小化（用户实测最小化不影响抓取）
      logLine("聊天页已就绪（已登录），最小化窗口");
      // 带重试：Edge 新窗口的标题要等页面加载才带上 deepseek，
      // 立刻操作会匹配不到（这正是"关了窗口再按就没反应"的原因之一）。
      minimized = await chatWindowActionRetry(this.cdp, "minimize", 10, 300);
    } else {
      // 还没登录：保持在屏幕旁边，等登录成功再最小化
      logLine("还没登录：登录成功后会自动最小化");
      this.watchForLoginThenMinimize(180);
      // 未登录时也要确保窗口真的挪到了旁边（导航后那次可能因标题没就绪而失败）
      moved = (await chatWindowActionRetry(this.cdp, "aside", 10, 300)) || moved;
    }
    if (!minimized && ready) {
      // 最小化一直没成功：至少挪到旁边，别让窗口挡着用户
      logLine("最小化始终没成功，改为挪到屏幕最旁边");
      moved = (await chatWindowActionRetry(this.cdp, "aside", 8, 300)) || moved;
    }
    return { ok: true, minimized, ready, moved };
  }

  /**
   * 观察登录完成：输入框一出现就自动最小化窗口（最多看 attempts 次，约 2 秒一轮）。
   * 用户点「说话」时如果专用 Edge 还停在登录页，登录成功后会自动收起窗口。
   */
  watchForLoginThenMinimize(attempts) {
    if (this.loginWatcher) return;
    let left = attempts;
    this.loginWatcher = setInterval(async () => {
      left--;
      if (left <= 0 || !this.cdp || !this.sessionId) {
        clearInterval(this.loginWatcher);
        this.loginWatcher = null;
        return;
      }
      try {
        const r = await evaluate(this.cdp, this.sessionId, `(() => {
          if (!window.__dshPetChat) return { inject: true };
          const ta = window.__dshPetChat.input();
          return { hasInput: !!ta, url: location.href };
        })()`);
        if (r && r.inject) {
          await evaluate(this.cdp, this.sessionId, HELPERS);
          return;
        }
        if (r && r.hasInput) {
          clearInterval(this.loginWatcher);
          this.loginWatcher = null;
          logLine("检测到登录完成（输入框已出现），自动最小化窗口");
          await chatWindowAction(this.cdp, "minimize");
        }
      } catch (e) {
        // 页面正在导航（登录跳转）时会求值失败，忽略，下一轮再看
      }
    }, 2000);
  }

  /** 发送消息并开始轮询回复。 */
  async send(id, text) {
    const ok = await this.ensurePage({ launchIfNeeded: true });
    if (!ok) throw new Error("聊天页面不可用");
    await evaluate(this.cdp, this.sessionId, HELPERS);

    // 自愈：页面如果是被"最小化着初始化"的，输入框可能根本不存在
    // （DeepSeek 前端在不可见状态下不建消息列表）。这时把窗口恢复出来，
    // 等页面重新渲染，再继续 —— 否则就会表现成"发送没反应、抓不到回复"。
    let st = await evaluate(this.cdp, this.sessionId, `(() => {
      const ta = window.__dshPetChat.input();
      return { ok: !!ta, hasReplies: window.__dshPetChat.replies().length };
    })()`);
    if (!st || !st.ok) {
      logLine("页面里找不到输入框，怀疑是「最小化着初始化」坏掉了：恢复窗口自愈一次");
      await chatWindowAction(this.cdp, "restore");
      await sleep(2500);
      await this.ensurePage({ launchIfNeeded: false });
      await evaluate(this.cdp, this.sessionId, HELPERS);
      st = await evaluate(this.cdp, this.sessionId, `(() => {
        const ta = window.__dshPetChat.input();
        return { ok: !!ta };
      })()`);
    }
    if (!st || !st.ok) throw new Error("找不到输入框（可能需要登录，或页面没渲染完）");

    // 基线必须在**点发送之前**取（DOM 兜底用）
    await this.captureBaseline();
    await this.hookNetwork();
    const bodiesBefore = this.netBodies.length;

    const filled = await evaluate(this.cdp, this.sessionId, `window.__dshPetChat.setText(${JSON.stringify(text)})`);
    if (!filled || !filled.ok) throw new Error("填入输入框失败");

    // 输入框为空时 DeepSeek 会把发送键加上 disabled 类（分数变负、找不到），
    // 所以必须**填完文字之后**再轮询等它变成可用，不能提前抓引用。
    let clicked = null;
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      clicked = await evaluate(this.cdp, this.sessionId, `(() => {
        const b = window.__dshPetChat.sendBtn();
        if (!b) return { ok: false, error: '还没变成可用' };
        b.click();
        return { ok: true };
      })()`);
      if (clicked && clicked.ok) break;
    }
    if (!clicked || !clicked.ok) {
      throw new Error("输入框里有字，但发送按钮一直不可用（是不是有别的回复正在生成？）");
    }

    this.lastText = "";
    logLine(`已发送（基线：DOM 回复 ${this.baseReplies.length} 条 / 网络响应 ${bodiesBefore} 条）`);

    this.streaming = true;
    this.currentId = id;
    this.emit({ type: "state", streaming: true });

    // 首选：等 completion 的响应体。DOM 有时渲染坏（连用户消息都不出现），
    // 但接口一直是好的 —— 实测页面 DOM 里 0 个消息块、completion 却 200 返回了完整回复。
    // 注意要挑 **closed=true**（SSE 里有 event: close）的那份，否则可能只拿到
    // 流式过程中的一小段（实测抓到过只有 5 个字的片段）。
    // 注意：一轮里会有**两份** completion 响应 —— 一份只有 THINK（深度思考），
    // 一份才是正文。必须跳过 text 为空的，否则会把思考内容当成回复。
    const closedBody = this.netBodies
      .slice(bodiesBefore)
      .filter((b) => b.closed && b.text && b.text.length > 0)
      .pop();
    if (closedBody) {
      logLine(`本轮回复直接来自接口（完整，${closedBody.text.length} 字）`);
      this.finishReply(closedBody.text, false);
      return;
    }
    this.waitForNetReply(id, this.currentId, 90000, bodiesBefore);
  }

  /** 等一个**完整**（closed）的 completion 响应体；超时回退 DOM 轮询。 */
  waitForNetReply(id, rid, timeoutMs, before) {
    const started = Date.now();
    let sawPartial = false;
    const tick = setInterval(() => {
      if (!this.streaming || this.currentId !== rid) {
        clearInterval(tick);
        return;
      }
      const fresh = this.netBodies.slice(before);
      const closed = fresh.filter((b) => b.closed && b.text && b.text.length > 0).pop();
      if (closed) {
        clearInterval(tick);
        logLine(`等到了完整接口回复（${closed.text.length} 字）`);
        this.finishReply(closed.text, false);
        return;
      }
      if (fresh.length && !sawPartial) {
        sawPartial = true;
        logLine(`收到 ${fresh.length} 段流式片段，等它 close…`);
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        // 兜底：超时还没 close，就拿最长的那段
        const longest = fresh.slice().sort((a, b) => b.text.length - a.text.length)[0];
        if (longest && longest.text) {
          logLine(`等 close 超时，用目前最长的一份（${longest.text.length} 字）`);
          this.finishReply(longest.text, false);
        } else {
          logLine("等接口回复超时，改用 DOM 轮询兜底");
          this.startPolling();
        }
      }
    }, 300);
  }

  /** 收尾一条回复：推 delta + done，复位状态。 */
  finishReply(text, interrupted) {
    this.stopPolling();
    if (text) this.emit({ type: "delta", id: this.currentId, text, done: false });
    this.streaming = false;
    this.emit({ type: "done", id: this.currentId, text: text || "", interrupted: !!interrupted, empty: !text });
    this.emit({ type: "state", streaming: false });
    this.currentId = null;
  }

  /** 记下当前页面里所有助手回复的文本（发送前调用）。 */
  async captureBaseline() {
    this.baseReplies = [];
    for (let i = 0; i < 10; i++) {
      try {
        const r = await evaluate(this.cdp, this.sessionId, `(() => {
          if (!window.__dshPetChat) return { inject: true };
          return { list: window.__dshPetChat.snapReplies() };
        })()`);
        if (r && r.inject) {
          await evaluate(this.cdp, this.sessionId, HELPERS);
          await sleep(300);
          continue;
        }
        if (r && Array.isArray(r.list)) {
          this.baseReplies = r.list;
          return;
        }
      } catch (e) {
        logLine(`取基线重试：${e.message}`);
      }
      await sleep(300);
    }
  }

  startPolling() {
    this.stopPolling();
    let idleTicks = 0;
    this.pollTimer = setInterval(async () => {
      if (!this.streaming || !this.cdp) return;
      try {
        // 每拍先确认还挂在同一个 target 上：发消息可能触发"新对话"（换 URL / 重载页面），
        // 那时旧 sessionId 已经作废，继续用它读到的永远是过期数据 ——
        // 表现就是"回复明明出来了，却一直判不出有新内容"。
        if (!(await this.ensurePage({ launchIfNeeded: false }))) return;
        if (!this.sessionId) return;

        const snap = await evaluate(this.cdp, this.sessionId, `(() => {
          if (!window.__dshPetChat) return { reinject: true };
          const ta = window.__dshPetChat.input();
          return {
            list: window.__dshPetChat.snapReplies(),
            inputEmpty: ta ? ta.value === '' : null,
            stopVisible: !!window.__dshPetChat.stopBtn(),
          };
        })()`);
        if (!snap) return;
        if (snap.reinject) {
          // 新对话切了 URL、页面重载：重新注入 helper 继续观察
          try { await evaluate(this.cdp, this.sessionId, HELPERS); } catch (e) {}
          return;
        }

        // 找出基线里没有的回复 = 这一轮的新回复
        const base = this.baseReplies || [];
        const list = Array.isArray(snap.list) ? snap.list : [];
        const fresh = list.filter((t) => t && !base.includes(t));
        const text = fresh.length ? fresh[fresh.length - 1] : "";

        if (text && text !== this.lastText) {
          this.lastText = text;
          idleTicks = 0;
          this.emit({ type: "delta", id: this.currentId, text, done: false });
          return;
        }

        // 还没长出内容（或内容没变）都算"安静"
        idleTicks++;

        // 结束判定：
        //  a) 已经长出过内容，停止按钮消失、连续 3 拍没变化
        //  b) 一直没内容，停止按钮消失且已安静 20 拍（约 8 秒，可能是失败/空回复）
        const hasText = !!this.lastText;
        const finished = hasText && !snap.stopVisible && idleTicks >= 3;
        const failed = !hasText && !snap.stopVisible && idleTicks >= 20;
        if (finished || failed) {
          this.streaming = false;
          this.stopPolling();
          this.emit({ type: "done", id: this.currentId, text: this.lastText, empty: !this.lastText });
          this.emit({ type: "state", streaming: false });
          this.currentId = null;
        }
      } catch (e) {
        logLine(`轮询出错：${e.message}`);
      }
    }, 400);
  }

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  /** 打断当前生成。 */
  async stop() {
    const ok = await this.ensurePage({ launchIfNeeded: false });
    if (!ok) return { ok: false, error: "聊天页面不可用" };
    const r = await evaluate(this.cdp, this.sessionId, `(() => {
      const b = window.__dshPetChat ? window.__dshPetChat.stopBtn() : null;
      if (!b) return { ok: false, error: '没有正在生成的回复（找不到停止按钮）' };
      b.click();
      return { ok: true };
    })()`);
    this.streaming = false;
    this.stopPolling();
    if (this.currentId !== null) {
      this.emit({ type: "done", id: this.currentId, text: this.lastText, interrupted: true });
      this.currentId = null;
    }
    this.emit({ type: "state", streaming: false });
    return r;
  }

  /** 把聊天窗口切到前台。 */
  async focus() {
    const ok = await this.ensurePage({ launchIfNeeded: false });
    if (!ok) return { ok: false, error: "聊天页面不可用" };
    try {
      await this.cdp.send("Page.bringToFront", {}, this.sessionId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

const bridge = new Bridge();

// ---- stdin 行协议 ----
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { this; logLine(`收到坏 JSON：${line.slice(0, 120)}`); continue; }
    handle(msg).catch((e) => {
      logLine(`处理 ${msg && msg.cmd} 出错：${e.message}`);
      out({ type: "error", id: msg && msg.id, message: e.message });
    });
  }
});

async function handle(msg) {
  const id = msg.id;
  switch (msg.cmd) {
    case "ping":
      out({ type: "ack", id, ok: true, pong: true });
      break;
    case "status": {
      const st = await bridge.status();
      out({ type: "ack", id, ok: true, status: st, streaming: bridge.streaming });
      break;
    }
    case "send":
      await bridge.send(id, String(msg.text || ""));
      out({ type: "ack", id, ok: true });
      break;
    case "stop": {
      const r = await bridge.stop();
      out({ type: "ack", id, ok: !!r.ok, error: r.error });
      break;
    }
    case "focus": {
      const r = await bridge.focus();
      out({ type: "ack", id, ok: !!r.ok, error: r.error });
      break;
    }
    case "open-chat": {
      try {
        const r = await bridge.openChat();
        out({ type: "ack", id, ok: true, minimized: !!r.minimized });
      } catch (e) {
        out({ type: "ack", id, ok: false, error: e.message });
      }
      break;
    }
    case "minimize": {
      const ok = await chatWindowAction(bridge.cdp, "minimize");
      out({ type: "ack", id, ok });
      break;
    }
    case "move-aside": {
      // 挪到屏幕最旁边（右下角露出一角）：登录页能点、又基本不占地方
      const ok = await moveChatWindowAside(bridge.cdp);
      out({ type: "ack", id, ok });
      break;
    }
    case "quit":
      out({ type: "ack", id, ok: true });
      bridge.stopPolling();
      setTimeout(() => process.exit(0), 60);
      break;
    default:
      out({ type: "error", id, message: `未知命令 ${msg.cmd}` });
  }
}

// ---- 启动时自检一次，把状态报给 Python ----
(async () => {
  try {
    const ok = await bridge.ensurePage({ launchIfNeeded: true });
    let st = { edge: !!bridge.cdp, page: false, loggedIn: false };
    if (ok) {
      try { st = await bridge.status(); } catch (e) { logLine(`status 失败：${e.message}`); }
    }
    out({ type: "ready", ...st, port: PORT });
    logLine(`ready: ${JSON.stringify(st)}`);
  } catch (e) {
    logLine(`启动失败：${e.message}`);
    out({ type: "ready", edge: false, page: false, loggedIn: false, error: e.message });
  }
})();

process.on("SIGTERM", () => { bridge.stopPolling(); process.exit(0); });
process.on("uncaughtException", (e) => {
  logLine(`UNCAUGHT: ${e && e.stack ? e.stack : e}`);
  // stdout 断了就别再回写（那会再抛一次 EPIPE，正是之前刷屏 167 次的原因）
  if (stdoutAlive) out({ type: "error", message: String((e && e.message) || e) });
});
process.on("unhandledRejection", (e) => {
  logLine(`UNHANDLED REJECTION: ${e && e.stack ? e.stack : e}`);
});
