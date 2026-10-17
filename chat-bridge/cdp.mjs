#!/usr/bin/env node
/**
 * chat.deepseek.com 的 CDP 驱动模块（桌宠用）。
 *
 * 为什么必须是"专用 Edge 实例"：跨进程没法给用户已有 Edge 里的页面注入 JS。
 * 所以这里自己起一个带 --remote-debugging-port 的 Edge，用独立的 user-data-dir
 * （首次要在那个实例里登录 chat.deepseek.com）。
 *
 * 踩过的坑（照抄参考插件的结论，省得再踩）：
 *   1. 必须走「浏览器级端点 + Target.createTarget + attachToTarget(flatten) + sessionId」。
 *      直接用 /json/list 里那个页面级 WebSocket，Runtime.evaluate 会永远超时。
 *   2. Node 24 自带全局 WebSocket，不需要 ws 依赖。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

export const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：浏览器级连接 + 扁平会话。 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch (e) {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.listeners.get(msg.method);
        if (list) for (const fn of list.slice()) fn(msg.params, msg.sessionId);
      }
    });
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 8000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP WebSocket 连接失败")); });
    });
    return new Cdp(ws);
  }

  /**
   * 发一条 CDP 命令。
   *
   * **必须带超时**：浏览器进程消失（用户手动关掉专用 Edge）时，WebSocket 可能
   * 不会触发 'close'，原实现返回的 Promise 就**永远挂着** —— 于是 daemon 卡死、
   * 宿主每条命令都石沉大海（实测：status 等 25 秒都没回应，之后按说话/DS 全无反应）。
   * 加了超时后这里会 reject，上层就能按"CDP 连接失效"去重启浏览器。
   */
  send(method, params = {}, sessionId, timeoutMs = 6000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`CDP 命令超时（${method} ${timeoutMs}ms）`);
        // 显式打标：让上层能可靠区分"只是超时"和"连接真的断了"，
        // 而不是去匹配消息里的"超时"字样（那样改一下文案就失效了）。
        err.code = "CDP_TIMEOUT";
        reject(err);
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        done(reject)(e);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  off(method, fn) {
    const list = this.listeners.get(method);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

/**
 * 起一个专用 Edge 实例（独立的 user-data-dir）并连上它的 CDP。
 */
export async function launchEdge({
  port = 9333,
  profileDir,
  url = "about:blank",
  headless = false,
  extraArgs = [],
  /** 启动时就最小化窗口。桌宠用 true：它是后台跑页面的，不该抢用户的前台。 */
  startMinimized = false,
  /**
   * 启动时就把窗口摆到指定位置 [x, y, w, h]。
   * 桌宠的"挪到旁边"用它：不加这个的话，Edge 会先以正常大小出现在屏幕中间，
   * 等 CDP 就绪后才被挪走 —— 用户会看到闪一下（实测就是这样）。
   */
  windowRect = null,
  log = () => {},
} = {}) {
  const edge = findEdge();
  if (!edge) throw new Error("找不到 msedge.exe");

  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.push("--headless=new");
  // 让窗口一出生就是最小化的（比起来之后再 ShowWindow 更干净，不会闪一下）
  if (startMinimized) args.push("--start-minimized");
  if (windowRect && windowRect.length === 4) {
    args.push(`--window-position=${Math.round(windowRect[0])},${Math.round(windowRect[1])}`);
    args.push(`--window-size=${Math.round(windowRect[2])},${Math.round(windowRect[3])}`);
  }
  args.push(...extraArgs, url);

  // **关键防重复**：如果这个端口已经有 Edge 在跑（同一个 user-data-dir），
  // 再 spawn 一个会怎样？Chromium 检测到已有实例，会把 URL **转发给那个实例**
  // 然后新进程自己退出 —— 表现就是"一下子打开两个网页"，而且因为调试端口仍然
  // 活着，调用方还会以为启动成功了。所以这里先探一次，活着就复用。
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      log(`已有 Edge 在监听 ${port}，直接复用（不再新起一个）：${v.Browser}`);
      const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
      return { proc: null, cdp, version: v, port, profile: profileDir, reused: true };
    } catch (e) {
      /* 端口还没开，继续等一小会儿 */
    }
    await sleep(300);
  }

  log(`启动 Edge: ${edge}`);
  // detached + unref：Edge 的生死不该绑在调用方进程上。
  // 否则脚本/job 一结束，Edge 跟着被杀，用户刚登录好的会话就没了。
  const proc = spawn(edge, args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
  proc.unref();

  let version = null;
  // 等调试端口起来。实测 1~2 秒就绪，原来最多等 12 秒（80×150ms）没必要，
  // 收到约 7 秒；真起不来会走下面的失败分支。
  for (let i = 0; i < 45 && !version; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      version = await r.json();
    } catch (e) {
      await sleep(150);
    }
  }
  if (!version) {
    try { proc.kill(); } catch (e) {}
    throw new Error(`Edge 调试端口 ${port} 没起来`);
  }
  log(`CDP 就绪：${version.Browser}`);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  return { proc, cdp, version, port, profile: profileDir };
}

/** 在浏览器里打开一个页面并 attach（扁平会话），返回 sessionId。 */
export async function openTarget(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}

/** 在页面里求值，返回 JSON 化的结果。 */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = false } = {}) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("页面求值异常: " + (d.exception && d.exception.description ? d.exception.description : d.text));
  }
  return res.result ? res.result.value : undefined;
}

/** 等页面 document.readyState 变成 complete（或超时）。 */
export async function waitForLoad(cdp, sessionId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(cdp, sessionId, "document.readyState");
      if (ready === "complete") return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

export { sleep };
