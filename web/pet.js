/* Agent 桌宠前端：Live2D 形象 + 状态表情 + 进度卡片 */

const STATE_STYLE = {
  idle: { label: "空闲", color: "#7f8c9b", expr: null, motion: "Idle" },
  thinking: { label: "思考中", color: "#7aa2ff", expr: "呆呆眼", motion: "Idle" },
  working: { label: "执行中", color: "#39c07a", expr: "开心兴奋", motion: "Idle" },
  waiting: { label: "等待你", color: "#ffb340", expr: "感叹号", motion: null },
  review: { label: "审阅中", color: "#b58cff", expr: "方眼镜", motion: null },
  syncing: { label: "同步中", color: "#4fc3d9", expr: "流汗", motion: null },
  blocked: { label: "被挡住", color: "#ff6b6b", expr: "生气", motion: null },
  error: { label: "出错了", color: "#ff4d4d", expr: "哭", motion: null },
  done: { label: "完成了", color: "#ffd166", expr: null, motion: "Show" },   // 不再做爱心眼庆祝
  interrupted: { label: "被打断", color: "#9b9b9b", expr: "悲伤", motion: null },
};

/* 每个状态有一"池"表情：主体跟着状态走，但会时不时换一个，不让它显得死板 */
/* 表情池只放"脸部表情"，不放道具/贴纸类。
   `晕晕`（被砸晕那张脸）已经彻底从所有池子里移除 —— 拖动放下时不再出现。 */
const MOOD_POOLS = {
  idle: ["呆呆眼", "脸红", "星星眼", "调皮", "吐舌"],
  thinking: ["呆呆眼", "流汗", "心跳"],
  working: ["开心兴奋", "星星眼", "调皮"],
  waiting: ["脸红", "心跳", "开心兴奋"],
  review: ["方眼镜", "圆眼镜"],
  syncing: ["流汗", "心跳"],
  blocked: ["生气", "阴暗"],
  error: ["哭", "悲伤", "流汗"],
  done: ["呆呆眼", "脸红", "调皮", "吐舌"],   // 完成不再庆祝，用平常脸
  interrupted: ["悲伤", "流汗"],
};

const SHY_MOODS = ["脸红", "心跳", "爱心眼"];

const MOOD_CHECK_MS = 2500;      // 多久检查一次"该不该换表情"
const DEFAULT_MOOD_SECONDS = 11; // 用户可调
const DEFAULT_FPS_LIMIT = 60;    // 渲染帧率上限（帧/秒，0 = 不限制；设置里可改）
const DEFAULT_GAZE_RANGE = 320;  // 超出这个距离就不跟了（像素，0 = 完全不跟随）
const GAZE_DEAD_ZONE = 0.12;     // 比例死区：中心这一小圈里眼珠不动，防止盯着看时抖
const GAZE_EYE_TAU = 0.28;       // 眼珠跟随的时间常数（秒）：越大越慢、越柔和
const GAZE_HEAD_TAU = 0.70;      // 头部比眼睛慢半拍：先瞟一眼再转头，不像整颗头被拽着走
const GAZE_BODY_TAU = 1.10;      // 身体再慢一点，转身的层次感就出来了
const GAZE_RETURN_DELAY = 0.16;  // 鼠标离开跟随范围后先顿一下，再开始回正（秒）
const GAZE_RETURN_SECONDS = 0.55;// 回正动画的基准时长（秒），偏得越多越慢一点点
const GAZE_MAX_STEP = 0.05;      // 掉帧时最多按 50ms 计算，避免一步跳过去
const GAZE_SCALE_EYE = 1.0;      // 眼珠参数幅度
const GAZE_SCALE_HEAD = 30.0;    // 头部转动幅度（度）

const bridge = (() => {
  const wv = window.chrome && window.chrome.webview;
  if (wv) {
    return {
      send: (msg) => wv.postMessage(msg),
      onMessage: (fn) => wv.addEventListener("message", (e) => fn(e.data)),
      live: true,
    };
  }
  return {
    send: (msg) => {
      // 只在"没有 WebView2 的浏览器预览"里走到这里，给个上限免得挂久了内存一直涨
      const buf = window.__petSent = window.__petSent || [];
      buf.push(msg);
      if (buf.length > 200) buf.splice(0, buf.length - 200);
      if (window.__petLog) console.log("to-host", msg);
    },
    onMessage: (fn) => {
      window.__petReceive = fn;
    },
    live: false,
  };
})();

const el = (id) => document.getElementById(id);

window.addEventListener("error", (ev) =>
  bridge.send({ t: "error", message: `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}` })
);
window.addEventListener("unhandledrejection", (ev) =>
  bridge.send({ t: "error", message: "unhandled rejection: " + String(ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason) })
);
for (const level of ["error", "warn"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    bridge.send({ t: "error", message: `${level}: ` + args.map(String).join(" ") });
    original(...args);
  };
}

const ui = {
  chip: el("chip"),
  chipText: el("chip-text"),
  chipDot: el("chip-dot"),
  toast: el("toast"),
  cardClose: el("card-close"),
  cardBtn: el("card-btn"),
  notice: el("notice"),
  noticeTitle: el("notice-title"),
  noticeBody: el("notice-body"),
  noticeClose: el("notice-close"),
  approval: el("approval"),
  approvalTitle: el("approval-title"),
  approvalTool: el("approval-tool"),
  approvalDetail: el("approval-detail"),
  approvalAllow: el("approval-allow"),
  approvalDeny: el("approval-deny"),
  approvalClose: el("approval-close"),
  card: el("card"),
  cardDot: el("card-dot"),
  cardState: el("card-state"),
  cardTitle: el("card-title"),
  cardElapsed: el("card-elapsed"),
  cardTools: el("card-tools"),
  cardTokens: el("card-tokens"),
  cardSource: el("card-source"),
  cardActivity: el("card-activity"),
  cardActivityText: el("card-activity-text"),
  cardSay: el("card-say"),
  cardUsage: el("card-usage"),
  cardBalance: el("card-balance"),
  chatBubble: el("chat-bubble"),
  chatBubbleBody: el("chat-bubble-body"),
  chatBubbleFoot: el("chat-bubble-foot"),
  chatBubbleDot: el("chat-bubble-dot"),
  chatBubbleName: el("chat-bubble-name"),
  chatBtn: el("chat-btn"),
  chatScrollUp: el("chat-scroll-up"),
  chatScrollDown: el("chat-scroll-down"),
  chatClose: el("chat-bubble-close"),
  dshBtn: el("dsh-btn"),
  deepseekBtn: el("deepseek-btn"),
};

const state = {
  key: "idle",
  payload: null,
  cardOpen: false,
  expression: null,
  elapsed: 0,
  settings: null,
  tempExpr: null,
  tempUntil: 0,
  moodAt: 0,
  hoverSince: 0,
  lastShy: 0,
  dragged: false,
  cursor: null,
  overChar: null,
  gaze: {
    x: 0, y: 0, targetX: 0, targetY: 0, ratioX: 0, ratioY: 0,
    headX: 0, headY: 0, bodyX: 0,
    phase: "rest",               // rest（不动）/ follow（跟着鼠标）/ return（回正动画中）
    returnAt: 0, returnDur: 0,
    fromEyeX: 0, fromEyeY: 0, fromHeadX: 0, fromHeadY: 0, fromBodyX: 0,
    clamped: false, distance: 0,
  },
  gazeAt: 0,
  fpsLimit: 60,         // 当前生效的渲染帧率上限（0 = 不限制），由设置决定
  fpsValue: 0,          // 最近一秒统计到的真实帧数
  fpsTicks: 0,
  fpsWindowStart: 0,
  // 帧间隔诊断：这一秒里最长的一帧间隔 / 超过 50ms 的帧数（掉帧证据）
  frameLastAt: 0,
  frameMaxGap: 0,
  frameSlowCount: 0,
  expressionHistory: [],
  muteBackup: null,
  muteTimer: 0,
  renderPaused: false,   // 宿主隐藏桌宠（切到 DSH）时置位：暂停 ticker，别在后台空转
};

let app = null;
let model = null;
let idleTimer = 0;
let moodTimer = 0;
let expressionCursor = 0;

function exprFor(key) {
  const custom = state.settings && state.settings.expressions;
  if (custom && custom[key] && expressionAllowed(custom[key])) return custom[key];
  const style = STATE_STYLE[key];
  const fallback = style ? style.expr : null;
  return fallback && expressionAllowed(fallback) ? fallback : null;
}

/* 表情白名单：被用户关掉的表情一律不出现（状态映射、随机心情、点击反应都走这里） */
function expressionAllowed(name) {
  if (!name) return false;
  const list = state.settings && Array.isArray(state.settings.expressionAllowed) ? state.settings.expressionAllowed : ["*"];
  return list.includes("*") || list.includes(name);
}

function allowedPool(key) {
  const pool = MOOD_POOLS[key] || MOOD_POOLS.idle;
  return pool.filter(expressionAllowed);
}

/** 从一组表情里随机挑一个 —— 只会挑"白名单里允许"的；全被关掉就返回 null（保持当前表情） */
function pickAllowed(list) {
  const source = (list || []).filter(expressionAllowed);
  if (!source.length) return null;
  return source[Math.floor(Math.random() * source.length)];
}

/** 暂停 / 恢复渲染。
 *
 *  为什么需要：宿主把桌宠窗口 Hide() 掉之后，**WebView2 里的渲染循环照样在跑** ——
 *  实测隐藏期间日志一直报 "渲染 FPS：59"，也就是切到 DSH 之后桌宠还在后台满帧
 *  空转，白白烧 CPU/GPU。长时间这样跑就会积热、掉帧、看起来"卡顿"。
 *  （WinForms 窗口 Hide 不等于浏览器文档 hidden，Chromium 不会自动节流。）
 *
 *  暂停时把共享 ticker 停掉：模型更新、视线、打字机、渲染全都挂在这个 ticker 上，
 *  停它一处即可（比逐个 stop 干净，恢复时也不会漏）。 */
function setRenderPaused(paused) {
  const on = Boolean(paused);
  state.renderPaused = on;
  const shared = PIXI.Ticker.shared;
  try {
    if (on) {
      shared.stop();
    } else {
      applyFpsLimit();          // 恢复时按设置重新套一遍上限
      shared.start();
    }
  } catch (e) {}
  return on;
}

/** 渲染帧率上限：设置里可调到 30–240，或"不限制"。

    注意必须设在**共享 ticker** 上 —— 模型更新、视线写入、渲染都排在 PIXI.Ticker.shared，
    以前只设了 app.ticker.maxFPS，而页面用的是共享 ticker（sharedTicker: true），
    所以那个上限根本没起作用（日志里能跑到 300+ 帧）。这里两边都设，谁在跑都拦得住。
    0 = 不限制（跑满屏幕刷新率）。 */
function applyFpsLimit() {
  const cfg = state.settings || {};
  const hasValue = cfg.fpsLimit !== undefined && cfg.fpsLimit !== null && cfg.fpsLimit !== "";
  const raw = hasValue ? Number(cfg.fpsLimit) : NaN;   // 设置还没送到时别把 null 当成"不限"
  let limit = DEFAULT_FPS_LIMIT;
  if (Number.isFinite(raw)) limit = raw <= 0 ? 0 : Math.min(360, Math.round(raw));
  const shared = PIXI.Ticker.shared;
  shared.maxFPS = limit;
  if (app && app.ticker && app.ticker !== shared) app.ticker.maxFPS = limit;
  state.fpsLimit = limit;
  return limit;
}

/** 数帧：每秒统计一次真实渲染帧数（比 ticker 自带的平滑 FPS 准，
    设置页显示的"当前 fps"和上报给宿主的都是这个值）。 */
function countFrame() {
  const now = performance.now();
  // 诊断用：记录这一帧距上一帧的间隔（掉帧会明显变大），每秒汇总一次最长值。
  // 卡顿是主观感受，有了这个数字才能判断"到底掉没掉帧、掉到多少"。
  if (state.frameLastAt) {
    const gap = now - state.frameLastAt;
    if (gap > state.frameMaxGap) state.frameMaxGap = gap;
    // 只统计"渲染循环里的间隔"：超过 250ms 一般是窗口被隐藏/系统挂起，不算掉帧
    if (gap > 50 && gap <= 250) state.frameSlowCount += 1;
  }
  state.frameLastAt = now;
  if (!state.fpsWindowStart) {
    state.fpsWindowStart = now;
    state.fpsTicks = 0;
    return;
  }
  state.fpsTicks += 1;
  const span = now - state.fpsWindowStart;
  if (span >= 1000) {
    state.fpsValue = Math.round((state.fpsTicks * 1000) / span);
    state.fpsTicks = 0;
    state.fpsWindowStart = now;
    state.frameMaxGap = 0;
    state.frameSlowCount = 0;
  }
}

function applySettings(cfg) {
  state.settings = cfg || {};
  applyFpsLimit();
  refreshPlaybackPolicy();
  const style = (cfg && cfg.cardStyle) === "solid" ? "style-solid" : "style-glass";
  if (ui.card) {
    ui.card.classList.remove("style-glass", "style-solid");
    ui.card.classList.add(style);
    applyCardScale();
    layout();
  }
  if (cfg && typeof cfg.showChip === "boolean") {
    if (!cfg.showChip) ui.chip.classList.add("hidden");
    else if (state.payload) ui.chip.classList.toggle("hidden", !(state.payload.title && state.key !== "idle"));
  }
  if (state.key) {
    state.expression = null;
    const expression = exprFor(state.key);
    if (expression) setExpression(expression);
    else resetExpression();
  }
}

function resetExpression() {
  try {
    const mgr = model && model.internalModel && model.internalModel.motionManager;
    if (mgr && mgr.expressionManager && typeof mgr.expressionManager.resetExpression === "function") {
      mgr.expressionManager.resetExpression();
    }
  } catch (err) {
    /* older builds do not expose resetExpression */
  }
}

/** 设置变化时立即收敛播放状态：关闭自动动作时要停掉正在循环的旧动作。 */
function refreshPlaybackPolicy() {
  const cfg = motionConfig();
  if (!cfg.autoMotion || !allowedIndices("Idle").length) stopAllMotions();
  else scheduleIdle();
}

function stopAllMotions(reason = "settings") {
  if (!model) return;
  const mgr = model.internalModel && model.internalModel.motionManager;
  if (!mgr) return;
  const queued = Array.isArray(mgr._motions) ? mgr._motions.length : null;
  try {
    if (typeof mgr.stopAllMotions === "function") mgr.stopAllMotions();
    else if (typeof mgr.stopAllMotion === "function") mgr.stopAllMotion();
    if (Array.isArray(mgr._motions)) mgr._motions.length = 0;
    state.lastMotionAt = Date.now();
    if (queued) {
      bridge.send({ t: "playback-debug", data: { reason, queued, autoMotion: motionConfig().autoMotion } });
    }
  } catch (err) {
    console.warn("stop motions failed", err);
  }
}

/** 硬闸门：渲染库自己触发的动作也会被拦住，不只拦我们的 playMotion()。 */
function installPlaybackGuards() {
  if (!model || state.playbackGuardInstalled) return;
  const mgr = model.internalModel && model.internalModel.motionManager;
  if (!mgr) return;
  const originalModelMotion = model.motion.bind(model);
  model.motion = (...args) => (motionConfig().autoMotion ? originalModelMotion(...args) : false);
  for (const name of ["startMotion", "startMotionPriority"]) {
    const original = mgr[name];
    if (typeof original !== "function") continue;
    mgr[name] = (...args) => (motionConfig().autoMotion ? original.apply(mgr, args) : false);
  }
  if (typeof mgr.updateMotion === "function") {
    const originalUpdate = mgr.updateMotion.bind(mgr);
    mgr.updateMotion = (dt, seconds) => {
      if (!motionConfig().autoMotion) {
        if (Array.isArray(mgr._motions) && mgr._motions.length) mgr.stopAllMotions();
        return false;
      }
      return originalUpdate(dt, seconds);
    };
  }
  state.playbackGuardInstalled = true;
}

/* ------------------------------------------------------------------ model */

async function boot() {
  app = new PIXI.Application({
    backgroundAlpha: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    sharedTicker: true, // 模型更新、视线写入、渲染排在同一个 ticker 上，顺序才可控
  });
  app.view.id = "pet-canvas";
  document.body.insertBefore(app.view, document.body.firstChild);
  applyFpsLimit();          // 帧率上限由设置决定（默认 60 帧；见下面的 applyFpsLimit）

  model = await PIXI.live2d.Live2DModel.from("model/settings.json", { autoInteract: false });
  app.stage.addChild(model);
  installPlaybackGuards();
  installParamBlockPatch();
  layout();
  window.addEventListener("resize", () => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
    updateCardDensity();
    applyCardScale();
    if (state.cardOpen && (window.innerHeight < 180 || window.innerWidth < 160)) setCardOpen(false);
    layout();
  });

  // 设置稍后才送达；配置生效前不要启动动作，避免旧的循环动作先播起来。
  setInterval(reportHitbox, 220);
  setInterval(scheduleIdle, 2000);
  setInterval(moodTick, MOOD_CHECK_MS);
  // 临时表情（抚摸/拖拽）到期自动复原
  setInterval(tempExprTick, MOOD_CHECK_MS);
  setInterval(reportFps, 3000);
  // 优先级：模型自身更新是 0，渲染是 LOW(25)。
  // 视线/道具屏蔽写在 10、11 —— 都在"模型更新之后、渲染之前"，这样才不会被动作覆盖。
  // 注意：Live2D 模型是挂在**共享 ticker**上更新的，所以这两件事也必须挂到共享 ticker 上，
  // 否则顺序不确定（表现就是"明明屏蔽了，动画还是把它写回来了"）。
  const shared = PIXI.Ticker.shared;
  shared.add(updateGaze, null, 10);
  shared.add(applyBlockedParams, null, 11);
  shared.add(countFrame, null, 99);        // 数帧：给设置页显示"当前 fps"
  if (app.ticker && app.ticker !== shared) {
    app.ticker.add(updateGaze, null, 10);
    app.ticker.add(applyBlockedParams, null, 11);
    app.ticker.add(countFrame, null, 99);
  }
  wireInteractions();
  reportHitbox();
  bridge.send({ t: "ready", expressions: expressionNames() });
}

/** 被屏蔽的道具参数每帧强制归零。

    像"锤子出现 / 锤子旋转 / 锤子 X"这些是藏在动画曲线里的道具，
    改表情白名单、关动作都拦不住（它们就在 idle 动画里），只有直接把参数按住才行。 */
function applyBlockedParams() {
  const blocked = blockedParamIds();
  if (!blocked.length) return;
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core || typeof core.setParameterValueById !== "function") return;
  for (const id of blocked) {
    try {
      core.setParameterValueById(id, 0);
    } catch (err) {
      /* 没这个参数就跳过 */
    }
  }
}

/** 把设置里的 blockedParams 解析成具体参数 id 列表。

    ["*"] 表示"屏蔽全部道具"—— 用宿主下发的道具清单展开。
    注：这条清单包含猫手(maoshou)、锤子、星星、包包、手机、键盘等**所有**
    被动作驱动的道具参数，因为这些东西全都藏 idle/其他动作的曲线里。 */
let blockedIdsCache = null;
let blockedIdsSource = null;

function blockedParamIds() {
  const settings = state.settings || {};
  const list = Array.isArray(settings.blockedParams) ? settings.blockedParams : [];
  const props = Array.isArray(settings.propParams) ? settings.propParams : [];
  const key = JSON.stringify([list, props.length]);
  if (blockedIdsCache && blockedIdsSource === key) return blockedIdsCache;
  let ids;
  if (list.includes("*")) {
    ids = props.map((p) => p.id).filter(Boolean);
  } else {
    ids = list.slice();
  }
  blockedIdsCache = ids;
  blockedIdsSource = key;
  return ids;
}

/** 更稳的一层保险：挂在模型自己的 update 后面。

    模型的参数是在 internalModel.update() 里算出来的（动作/物理都在里面），
    所以在这之后立刻按住被屏蔽的参数，就能保证"算完就是 0、画出来也是 0"，
    不依赖 ticker 优先级顺序。 */
function installParamBlockPatch() {
  const im = model && model.internalModel;
  if (!im || im.__petBlockPatched) return;
  const original = im.update.bind(im);
  im.update = (dt, now) => {
    original(dt, now);
    applyBlockedParams();
  };
  im.__petBlockPatched = true;
}

function expressionNames() {
  const mgr = model && model.internalModel && model.internalModel.motionManager;
  const defs = mgr && mgr.expressionManager && mgr.expressionManager.definitions;
  const fromModel = defs ? defs.map((d) => d.name || d.Name).filter(Boolean) : [];
  if (fromModel.length) return fromModel;
  return (state.settings && state.settings.availableExpressions) || [];
}

// 上一次布局的输入签名。ResizeObserver、状态推送、设置变更都会调 layout()，
// 而它们的输入往往没变（例如卡片内容微调但高度分桶后相同）—— 这时重排纯属浪费，
// 每次重排都要读一堆 getBoundingClientRect 并重设模型变换，正是"卡一下"的来源。
let layoutSignature = "";
// 上一次上报的命中矩形签名：没变化就不再发消息（每 220ms 一次，省下大量无意义的
// WebView2 消息与宿主侧更新）
let lastHitboxSignature = "";

/**
 * 模型还没加载完时的按钮兜底位置。
 *
 * 这些按钮是 `position:absolute`，在没有 left/top 的情况下会停在"静态位置"——
 * 也就是窗口左上角那一小块。表现就是用户看到的"刚打开时按钮飞到左上角"。
 * 这里先按"底部居中"摆好，等模型就绪后 layout() 会再按模型位置精确摆一次。
 */
function placeButtonsFallback() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const nodes = [ui.chatBtn, ui.dshBtn, ui.deepseekBtn, ui.cardBtn].filter(
    (n) => n && !n.classList.contains("hidden")
  );
  if (!nodes.length) return;
  const bw = 34.0;
  const bgap = 10.0;
  const totalW = nodes.length * bw + (nodes.length - 1) * bgap;
  let x = (w - totalW) / 2.0;
  const y = Math.max(4, h - 34 - 24);
  for (const n of nodes) {
    n.style.left = `${Math.round(x)}px`;
    n.style.top = `${Math.round(y)}px`;
    x += bw + bgap;
  }
}

function layout() {
  if (!model) {
    placeButtonsFallback();     // 模型没就绪：别让按钮停在左上角
    return;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const maxW = w * 0.96;
  const gap = cardGap();                       // 卡片与角色头顶的间距（CSS 像素，固定值）
  // 卡片"算不算占位"要两道都看：state.cardOpen 是数据源，CSS class 是实际显示状态。
  // 两个曾经不一致过（宿主直接发 {"t":"card"} 时只改了 class），只信一个就会
  // 漏留位置 —— 表现就是卡片和气泡叠在一起（实测踩过）。
  const cardVisible = Boolean(
    (state.cardOpen || (ui.card && !ui.card.classList.contains("hidden"))) &&
      ui.card &&
      !ui.card.classList.contains("hidden")
  );
  const cardOpen = cardVisible;
  const bubbleOpen = chat.shown && ui.chatBubble && !ui.chatBubble.classList.contains("hidden");

  // —— 关键：这里只用**固定高度的预算**，不能用元素实测高度 ——
  // 之前用 ui.chatBubble.getBoundingClientRect().height 算模型位置，而气泡高度又
  // 取决于内容、内容又跟着模型位置排版，成了循环依赖：模型会一会儿 y=8 一会儿
  // y=279 地跳，气泡也照样压在模型头上（实测过）。
  // 气泡正文有 max-height，所以总高可以按常量预估，稳定又简单。
  const bubbleBodyMax = 120;                   // 与 pet.css 的 .chat-bubble-body 一致
  const bubbleChrome = 46;                     // 标题行 + 内边距 + 脚注 + 尖角
  const BUBBLE_FIXED_H = bubbleBodyMax + bubbleChrome;
  const CARD_EST_H = 118;                      // 进度卡片高度（含内边距）的保守估计
  const btnH = 34;                             // 底部那排按钮高度
  // 模型底边到按钮行的距离。用户要求"按钮和反应文字一起上移"，
  // 所以这里回到 8px（按钮贴回模型脚下、模型恢复原来大小）；
  // 反应文字改成挂在**按钮上方**，允许压住模型下沿一点（用户明确说没关系）。
  const btnGap = 8;
  // 桌宠窗口的下沿可能被任务栏/屏幕边缘挡住，这里按比例预留一块底部安全区。
  // 另外模型 bounds 不一定包含全部可见画面（还有装饰/特效层），所以再补一段固定余量，
  // 让按钮确实落在画面下方而不是压在身上。
  // 底部安全区：原来 11% + 64px（在 682 高的窗口里就是 139px）远超实际需要 ——
  // 那排按钮只有 34px 高，过大的预留会直接把模型压小。现在按 4% + 34px。
  const bottomSafe = Math.max(16, Math.round(h * 0.04)) + 34;

  // —— 坐标约定（重要，踩过坑）——
  // window.innerWidth/innerHeight 与元素 getBoundingClientRect() **本来就是同一套
  // 坐标系**（视口像素），PIXI 的 model.x/y/width/height 也是照 innerWidth/innerHeight
  // 缩放出来的，同样属于这套坐标系。所以**不要**再乘/除 devicePixelRatio ——
  // 曾经把 innerHeight 当"物理像素"而 rect 当"CSS 像素"，来回换算 dpr 一次，
  // 结果按钮被推到模型正中间、还压在身上（实测踩过）。dpr 只用来做像素命中判断，
  // 跟这里的排版无关。
  // 卡片"能占多少位置"要封顶：卡片内容一多（长标题/长的一句话）就会长很高，
  // 把模型压到只剩一百多像素。超过 130px 的部分让它压在模型上方（视觉上仍完整
  // 显示，只是不再继续压缩模型）。
  // —— 卡片绝不盖住模型 ——
  // 卡片是固定 CSS 尺寸、不跟窗口缩放；桌宠缩小后"模型上方那条带子"变窄，
  // 卡片会压到模型身上。这里按可用高度把卡片字号系数(state.cardFit)往下调。
  //
  // **注意：这里绝对不能递归调用 layout()**（上一版就是那样写的，结果外层这次
  // 调用直接 return、永远走不到下面的模型缩放，缩放功能整个坏掉）。
  // 改成"原地调系数 + 重新量几次"，最多 4 轮，然后继续往下走。
  if (cardOpen) {
    const avail = Math.max(72, Math.round(model.y - 10));
    for (let i = 0; i < 4; i += 1) {
      const h = ui.card.getBoundingClientRect().height;
      if (h <= avail) break;                       // 装得下了
      const cur = state.cardFit || 1;
      const want = Math.max(0.62, cur * (avail / h) * 0.98);
      if (Math.abs(want - cur) <= 0.02) break;     // 收敛了，别再动
      state.cardFit = want;
      applyCardScale();                            // 改字号 → 下次循环重新量高度
    }
    // 空间又够了就慢慢恢复回 1（每次最多 +0.06，避免来回跳）
    if ((state.cardFit || 1) < 0.995) {
      const h = ui.card.getBoundingClientRect().height;
      if (h < avail * 0.92) {
        state.cardFit = Math.min(1, (state.cardFit || 1) + 0.06);
        applyCardScale();
      }
    }
  }

  const cardH = cardOpen
    ? Math.min(130, Math.max(0, Math.round(ui.card.getBoundingClientRect().height)))
    : 0;

  // 先把"还没有任何位置"的可见按钮摆到兜底位置。
  // 这一步必须在下面的"提前返回"**之前**：宿主是后把 说话/DSH/DS 按钮切显示出来的，
  // 如果签名没变就直接返回，这些新出现的按钮会停在窗口左上角（绝对定位的静态位置）。
  const allBtns = [ui.chatBtn, ui.dshBtn, ui.deepseekBtn, ui.cardBtn];
  if (allBtns.some((n) => n && !n.classList.contains("hidden") && !n.style.left)) {
    placeButtonsFallback();
  }

  // 输入没变就跳过整趟重排。签名要覆盖**影响布局结果的一切**，包括按钮显隐 ——
  // 漏掉它就会出现"按钮刚显示出来却没有被摆位"。
  const btnSig = allBtns
    .map((n) => (n && !n.classList.contains("hidden") ? 1 : 0))
    .join("");
  // 气泡的实际高度也要进签名：它随内容增长，高度一变就必须重新对齐
  // （否则气泡会用自己的旧高度算位置，长出来以后压住模型）。
  const bubbleH = bubbleOpen ? Math.round(ui.chatBubble.getBoundingClientRect().height) : 0;
  const signature = [
    w, h, cardOpen ? 1 : 0, cardH, bubbleOpen ? 1 : 0, bubbleH, gap, btnSig,
  ].join("|");
  if (signature === layoutSignature) return;
  layoutSignature = signature;

  // —— 模型缩放怎么定 ——
  // 两条要求合起来：①桌宠大小**不能因为气泡出现而变化**（否则观感像在跳）；
  // ②气泡不能盖住模型。所以把"气泡那块高度"**固定算进缩放预算**：
  // 有没有气泡，桌宠都是这个大小，气泡出现时正好落在上面预留的位置里。
  // （曾经只按窗口算缩放、让气泡压在模型上，用户反馈"不要盖住模型"。）
  const reserveBottom = btnH + btnGap + bottomSafe;
  // **卡片不参与模型缩放预算**：加进去的话，每次开合卡片模型都要重新缩放一次，
  // 观感上就是"一开卡片模型就缩小"（用户明确不要）。卡片占用的是"气泡预留"那条
  // 带子（顶部 182px），足够放下卡片，所以去掉它模型大小和位置都不变。
  const bubbleReserve = BUBBLE_FIXED_H + 8;    // 顶部固定留给气泡的那条
  const reserveTop = bubbleReserve;
  const maxH = Math.max(60, h - reserveTop - reserveBottom);
  const scale = Math.min(maxW / model.internalModel.width, maxH / model.internalModel.height);
  state.modelScale = scale;   // 弹跳特效要基于这个基础值做压扁/拉伸
  model.scale.set(scale);
  model.x = (w - model.width) / 2;
  // 角色贴在预留区下方（气泡出现时它不动），卡片打开时才整体下移让位
  model.y = reserveTop;
  if (model.y + model.height > h - reserveBottom) {
    model.y = Math.max(reserveTop, h - reserveBottom - model.height);
  }
  // PIXI 的 width/height 来自缓存的 bounds，改完 scale/位置要更新变换才是最新值；
  // 不刷新的话紧接着读 model.height 会拿到上一帧的数字，位置就会飘（实测踩过）。
  try {
    model.updateTransform();
  } catch (e) {}

  // 从上往下依次摆放（全部视口坐标）：卡片最上 → 气泡 → 角色 → 按钮
  let cursor = 4;
  if (cardOpen) {
    ui.card.style.top = `${Math.round(cursor)}px`;
    cursor += cardH + gap;
  }
  if (bubbleOpen) {
    // 气泡**底边紧贴模型顶边**（留 8px 间隙），并且用**实际高度**算。
    // 原来用的是常量 BUBBLE_FIXED_H，导致：①气泡内容短时被顶到窗口最上面、
    // 离模型老远；②模型缩放后模型 y 一变，气泡相对模型的距离就跟着变（实测
    // 135px → 76.5px，用户看到的就是"气泡相对模型严重位移"）。
    // 改成按实际高度对齐后，无论内容多长、模型多大，间隙恒定。
    const bubbleActualH = ui.chatBubble.getBoundingClientRect().height;
    const aboveHead = model.y - bubbleActualH - 8;
    ui.chatBubble.style.top = `${Math.round(Math.max(2, aboveHead))}px`;
  }
  // 底部那排按钮：落在角色脚下那条空白里（同一套视口坐标，不做 dpr 换算）
  const placeRow = (nodes) => {
    const visible = nodes.filter((n) => n && !n.classList.contains("hidden"));
    if (!visible.length) return;
    const bw = 34.0;
    const bgap = 10.0;
    const totalW = visible.length * bw + (visible.length - 1) * bgap;
    let x = (w - totalW) / 2.0;
    const belowFeet = model.y + model.height + btnGap;
    const y = Math.max(4, Math.min(belowFeet, h - btnH - 4));
    for (const n of visible) {
      n.style.left = `${Math.round(x)}px`;
      n.style.top = `${Math.round(y)}px`;
      x += bw + bgap;
    }
  };
  placeRow([ui.chatBtn, ui.dshBtn, ui.deepseekBtn, ui.cardBtn]);
  // 排查用：把这次布局的关键数字记下来（window.__petLayout 可被读出来核对）
  window.__petLayout = {
    window: [w, h],
    bubbleOpen,
    cardOpen,
    BUBBLE_FIXED_H,
    CARD_EST_H,
    reserveBottom,
    modelTop: Math.round(model.y),
    modelBottom: Math.round(model.y + model.height),
    bubbleTop: bubbleOpen ? Math.round(ui.chatBubble.getBoundingClientRect().top) : null,
    btnTop: Math.round(ui.chatBtn ? ui.chatBtn.getBoundingClientRect().top : 0),
  };
  reportHitbox();
  // 反应文字（toast）落在"模型底部与按钮之间"的空隙里
  positionToast();
  // 常驻提示跟气泡一样是绝对定位，布局时重新摆一下（模型缩放/窗口变化都要跟）
  if (notice.open) noticePosition();
  // 权限申请卡片同理：窗口被拖动/缩放时要始终贴着模型上方
  if (approval.open) approvalPosition();
}

function cardGap() {
  const value = Number(state.settings && state.settings.cardGap != null ? state.settings.cardGap : 12);
  return Number.isFinite(value) ? Math.max(-20, Math.min(60, value)) : 12;
}

/** 桌宠放大时卡片跟着放大一点（字号/内边距），不然大桌宠配小卡片会很奇怪 */
function applyCardScale() {
  const base = (state.settings && state.settings.baseSize) || [400, 620];
  const petScale = base[0] ? window.innerWidth / base[0] : 1;
  const linked = !state.settings || state.settings.cardScaleWithPet !== false;
  // 上限收到 1.0：桌宠放大时卡片原来会跟着涨到 1.45 倍，字号/内边距一起变大，
  // 卡片又高又占地方（用户反馈"卡片过大、把模型压缩得特别小"）。保持 1.0 上限，
  // 只允许在小桌宠时缩一点。
  // 再缩一点点（乘 0.94）：卡片整体更紧凑，少占地方
  const rawScale = linked ? Math.min(1.0, Math.max(0.85, 1 + (petScale - 1) * 0.6)) : 1;
  // 再乘上 layout() 算出的"要塞进模型上方那条带子"的系数（state.cardFit）
  const value = rawScale * 0.94 * (state.cardFit || 1);
  if (ui.card) ui.card.style.setProperty("--card-scale", value.toFixed(3));
}

function characterRect() {
  if (!model) return [0, 0, 0, 0];
  const b = model.getBounds();
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
}

function reportHitbox() {
  let chatRect = null;
  if (ui.chatBtn && !ui.chatBtn.classList.contains("hidden")) {
    const r = ui.chatBtn.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      chatRect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    }
  }
  // 气泡矩形：宿主判到光标在上面就把滚轮转给气泡（长回复靠它看全）。
  // 注意必须判"真正可见"（on 且没有 hidden）：气泡是常驻的，收起后
  // chat.shown 可能还是 true —— 只判 chat.shown 会一直上报一块看不见的矩形，
  // 宿主于是把滚轮当成"滚气泡"吃掉，**滚轮缩放桌宠就失效了**（实测踩过）。
  let bubbleRect = null;
  const bubbleVisible = Boolean(
    chat.shown &&
      ui.chatBubble &&
      !ui.chatBubble.classList.contains("hidden") &&
      ui.chatBubble.classList.contains("on")
  );
  if (bubbleVisible) {
    const r = ui.chatBubble.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      bubbleRect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    }
  }
  // 滚动按钮矩形：滚动条拖不动，点击这两个按钮由宿主钩子命中后发消息回来
  const btnRect = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  // DSH / DS 两个快捷键按钮：和「说话」按钮共用一套上报机制
  const keyRect = (node) => {
    if (!node || node.classList.contains("hidden")) return null;
    return btnRect(node);
  };
  const payload = {
    t: "size",
    rect: characterRect(),
    headRect: headRect(),
    chatRect,
    bubbleRect,
    scrollUpRect: btnRect(ui.chatScrollUp),
    scrollDownRect: btnRect(ui.chatScrollDown),
    bubbleCloseRect: chat.shown ? btnRect(ui.chatClose) : null,
    // 常驻提示（可手动关闭）：关闭按钮的点击同样只能靠宿主钩子命中
    noticeRect: notice.open ? btnRect(ui.notice) : null,
    noticeCloseRect: notice.open ? btnRect(ui.noticeClose) : null,
    // 权限申请卡片：整卡 + 两个按钮的矩形（按钮只能由宿主钩子命中）
    approvalRect: approval.open ? btnRect(ui.approval) : null,
    approvalAllowRect: approval.open ? btnRect(ui.approvalAllow) : null,
    approvalDenyRect: approval.open ? btnRect(ui.approvalDeny) : null,
    approvalCloseRect: approval.open ? btnRect(ui.approvalClose) : null,
    dshBtnRect: keyRect(ui.dshBtn),
    deepseekBtnRect: keyRect(ui.deepseekBtn),
    // 任务进度卡片：关闭键 + 第 4 个按钮（都由宿主钩子命中）
    cardCloseRect: state.cardOpen ? btnRect(ui.cardClose) : null,
    cardBtnRect: keyRect(ui.cardBtn),
    dpr: window.devicePixelRatio || 1,
  };
  // 完全没变化就不发：鼠标静止时这份数据是死的，每 220ms 发一次纯属浪费
  const signature = JSON.stringify(payload);
  if (signature === lastHitboxSignature) return;
  lastHitboxSignature = signature;
  bridge.send(payload);
}

function headRect() {
  const rect = characterRect();
  if (!rect[2]) return null;
  return [
    Math.round(rect[0] + rect[2] * 0.18),
    Math.round(rect[1] + rect[3] * 0.02),
    Math.round(rect[2] * 0.64),
    Math.round(rect[3] * 0.36),
  ];
}

function reportFps() {
  // 暂停渲染期间不上报（也没帧可报），省掉这趟无意义的跨进程消息
  if (state.renderPaused) return;
  const fps = state.fpsValue || (app && app.ticker ? app.ticker.FPS : 0);
  // 顺带上报帧间隔诊断：只有"最长帧间隔"变大才说明真的掉帧了（卡顿的客观证据）
  bridge.send({
    t: "fps",
    value: Math.round(fps),
    maxGap: Math.round(state.frameMaxGap || 0),
    slow: state.frameSlowCount || 0,
  });
}

function canvasElement() {
  return (app && (app.view || app.canvas)) || null;
}

/* ---------------------------------------------------------------- motions */

function motionConfig() {
  const s = state.settings || {};
  const allowed = Array.isArray(s.motionAllowed) ? s.motionAllowed : ["*"];
  return {
    allowed: allowed.includes("*") ? null : new Set(allowed),
    gapMs: Math.max(0, Number(s.motionGapSeconds != null ? s.motionGapSeconds : 4)) * 1000,
    idleMs: Math.max(0, Number(s.idleMotionSeconds != null ? s.idleMotionSeconds : 6)) * 1000,
    motionChance: Number(s.motionChance != null ? s.motionChance : 30),
    moodChance: Number(s.moodChance != null ? s.moodChance : 80),
    autoMotion: s.autoMotion !== false,
    autoExpression: s.autoExpression !== false,
  };
}

function allowedIndices(group) {
  const cfg = motionConfig();
  const mgr = model && model.internalModel && model.internalModel.motionManager;
  const defs = (mgr && mgr.definitions && mgr.definitions[group]) || [];
  const out = [];
  for (let i = 0; i < defs.length; i += 1) {
    if (!cfg.allowed || cfg.allowed.has(`${group}:${i}`)) out.push(i);
  }
  return out;
}

function playMotion(group, index) {
  if (!model) return false;
  const cfg = motionConfig();
  if (!cfg.autoMotion) return false;
  const candidates = allowedIndices(group);
  const wanted = typeof index === "number" ? candidates.filter((i) => i === index) : candidates;
  if (!wanted.length) return false;                       // 这个组的动作被关掉了
  const now = Date.now();
  if (now - (state.lastMotionAt || 0) < cfg.gapMs) return false;  // 还没到最小间隔
  const chosen = wanted[Math.floor(Math.random() * wanted.length)];
  try {
    model.motion(group, chosen);
    state.lastMotion = `${group}:${chosen}`;
    state.lastMotionAt = now;
    return true;
  } catch (err) {
    console.warn("motion failed", group, chosen, err);
    return false;
  }
}

function scheduleIdle() {
  if (!model) return;
  const mgr = model.internalModel.motionManager;
  const cfg = motionConfig();
  if (!cfg.autoMotion) {
    stopAllMotions("quiet-poll");
    return;
  }
  const busy = mgr && typeof mgr.isFinished === "function" ? !mgr.isFinished() : false;
  if (busy) return;
  if (cfg.idleMs <= 0) return;                          // 用户关掉了闲置动作
  const now = Date.now();
  if (now - (state.lastIdleAt || 0) < cfg.idleMs) return;
  state.lastIdleAt = now;
  playMotion("Idle");
}

/* ---------------------------------------------------------------- 心情系统 */

function setTempExpression(name, seconds) {
  if (!name) return false;
  state.tempExpr = name;
  state.tempUntil = Date.now() + seconds * 1000;
  state.expression = null;
  setExpression(name);
  return true;
}

/**
 * 临时表情到点复原。
 *
 * 以前 setTempExpression 只写了一个"截止时间"，**没有任何地方负责到点复原** ——
 * 抚摸/拖拽设的表情会一直挂着，只有等下一次状态更新或下一次随机心情才可能换掉，
 * 于是看起来就是"表情卡住不复原"（用户反馈）。这里补上到期还原。
 */
function tempExprTick() {
  if (!state.tempExpr) return;
  if (Date.now() < state.tempUntil) return;
  state.tempExpr = null;
  state.tempUntil = 0;

  // **必须先把 state.expression 清空、并 resetExpression()**，再应用基础表情：
  //   · setExpression 有"name === state.expression 就 return"的短路；
  //   · 有些表情（脸红 / 爱心眼 / 吐舌 这类改参数或叠加的）在表达式管理器里
  //     并不会被"设置另一个表情"真正顶掉，只靠 setExpression 会残留 ——
  //     这就是"表情卡住不恢复"的根源。
  // 清空标记 + 显式 reset 之后，无论基础表情是什么都能真正生效。
  state.expression = null;
  resetExpression();

  const base = exprFor(state.key);
  if (base) setExpression(base);
  // 复原后先安静一会儿，别立刻又被随机心情换掉，否则看着像"复原失败"
  state.moodAt = Date.now();
}

function moodTick() {
  if (!model) return;
  if (state.settings && state.settings.autoExpression === false) return;
  if (Date.now() < state.tempUntil) return;      // 正在演临时情绪（拖动/被戳/害羞）
  if (Date.now() - state.moodAt < moodIntervalMs()) return;
  const cfg = motionConfig();
  if (Math.random() * 100 > cfg.moodChance) return;   // 概率控制（设置里可调）

  const pool = MOOD_POOLS[state.key] || MOOD_POOLS.idle;
  const preferred = state.settings && state.settings.expressions ? state.settings.expressions[state.key] : null;
  const name = preferred && Math.random() < 0.5 ? preferred : pickAllowed(pool);
  setExpression(name);
  state.moodAt = Date.now();

  if (Math.random() * 100 < cfg.motionChance) {
    playMotion(state.key === "idle" ? "Idle" : "Tap");
  }
}

function moodIntervalMs() {
  const seconds = Number((state.settings && state.settings.moodSeconds) || DEFAULT_MOOD_SECONDS);
  return Math.max(2, Math.min(120, seconds)) * 1000;
}

function gazeRange() {
  const range = Number((state.settings && state.settings.gazeRange) ?? DEFAULT_GAZE_RANGE);
  return Number.isFinite(range) && range > 0 ? range : 0;  // 0 = 不跟随
}

function onCursor(data) {
  if (!data) return;
  state.cursor = data;
  const now = Date.now();
  if (data.inside) {
    if (!state.hoverSince) state.hoverSince = now;
    // 被盯着看了一会儿：偶尔害羞一下
    const autoExpression = !state.settings || state.settings.autoExpression !== false;
    if (autoExpression && now - state.hoverSince > 2600 && now - state.lastShy > 22000 && Date.now() > state.tempUntil) {
      state.lastShy = now;
      setTempExpression(pickAllowed(SHY_MOODS), 1.4);
      if (Math.random() < 0.5) playMotion("Tap");
    }
  } else {
    state.hoverSince = 0;
  }
}

/* 视线：按"相对窗口中心的偏移比例"映射，而不是固定像素偏移
   ratioX = dx / (窗口宽/2)，ratioY = dy / (窗口高/2)，都夹在 [-1, 1]。
   窗口一变，分母（innerWidth/innerHeight）下一帧就用新的，所以任何大小都对得上。

   手感（这一版的重点）：
   1) 不再用"每帧靠近 10%"——那种写法帧率一高眼珠就变快，掉帧又会顿一下。
      现在按时间常数平滑，快慢只看秒数；
   2) 眼睛先动、头慢半拍、身体再慢一点，三层错开，转头看着才不像整颗头被拽着走；
   3) 鼠标离开跟随范围（或跟随关掉）之后不再硬拽回中位：先顿一下，
      再走一段缓入缓出的回正动画，收尾是慢下来的，不会"啪"地弹回去。 */
function updateGaze() {
  if (!model) return;
  const g = state.gaze;
  const now = performance.now();
  const dt = clamp(((now - state.gazeAt) || 0) / 1000, 0, GAZE_MAX_STEP);
  state.gazeAt = now;

  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  const range = gazeRange();
  const cursor = state.cursor;
  let targetX = 0;
  let targetY = 0;
  let distance = 0;
  let inRange = false;

  if (cursor && typeof cursor.x === "number") {
    const dx = cursor.x - w / 2;
    const dy = cursor.y - h / 2;
    distance = Math.hypot(dx, dy);
    if (range > 0 && distance <= range) {
      inRange = true;
      targetX = softDeadZone(clamp(dx / (w / 2), -1, 1), GAZE_DEAD_ZONE);
      targetY = softDeadZone(clamp(dy / (h / 2), -1, 1), GAZE_DEAD_ZONE);
    }
  }

  if (inRange) {
    g.phase = "follow";
    g.targetX = targetX;
    g.targetY = targetY;
    const kEye = easeFactor(dt, GAZE_EYE_TAU);
    const kHead = easeFactor(dt, GAZE_HEAD_TAU);
    const kBody = easeFactor(dt, GAZE_BODY_TAU);
    g.ratioX += (targetX - g.ratioX) * kEye;
    g.ratioY += (targetY - g.ratioY) * kEye;
    g.headX += (targetX - g.headX) * kHead;
    g.headY += (targetY - g.headY) * kHead;
    g.bodyX += (targetX - g.bodyX) * kBody;
  } else if (g.phase === "follow") {
    startGazeReturn(now);      // 这一步刚离开跟随范围：起一段回正动画
  } else if (g.phase === "return") {
    const t = g.returnDur > 0 ? (now - g.returnAt) / (g.returnDur * 1000) : 1;
    if (t >= 1) {
      restGaze(g);
    } else {
      const k = easeInOutCubic(clamp(t, 0, 1));   // t < 0 = 还在"先顿一下"的等待里
      g.ratioX = g.fromEyeX * (1 - k);
      g.ratioY = g.fromEyeY * (1 - k);
      g.headX = g.fromHeadX * (1 - k);
      g.headY = g.fromHeadY * (1 - k);
      g.bodyX = g.fromBodyX * (1 - k);
    }
  }

  g.x = g.ratioX;
  g.y = g.ratioY;
  g.distance = Math.round(distance);
  g.clamped = Boolean(cursor && typeof cursor.x === "number" && !inRange);
  applyGazeParameters(g);
}

/** 离开跟随范围的那一刻：记下当前角度，过一小会儿再做回正动画（"视线停留"的感觉）。 */
function startGazeReturn(now) {
  const g = state.gaze;
  const offset = clamp(Math.max(Math.abs(g.ratioX), Math.abs(g.ratioY), Math.abs(g.headX), Math.abs(g.headY)), 0, 1);
  g.phase = "return";
  g.fromEyeX = g.ratioX;
  g.fromEyeY = g.ratioY;
  g.fromHeadX = g.headX;
  g.fromHeadY = g.headY;
  g.fromBodyX = g.bodyX;
  g.returnAt = now + GAZE_RETURN_DELAY * 1000;                  // 等待期里 t 是负的，画面保持不动
  g.returnDur = GAZE_RETURN_SECONDS * (0.55 + 0.45 * offset);   // 偏得越多，回正稍慢一点
}

function restGaze(g) {
  g.phase = "rest";
  g.ratioX = 0;
  g.ratioY = 0;
  g.headX = 0;
  g.headY = 0;
  g.bodyX = 0;
  g.targetX = 0;
  g.targetY = 0;
}

/** 指数平滑系数：按"经过了多少秒"算，所以 60Hz 和 144Hz 的手感一样 */
function easeFactor(dt, tau) {
  return 1 - Math.exp(-Math.max(0, dt) / Math.max(0.02, tau));
}

/** 缓入缓出：起步慢、中间快、收尾慢，回正才像"自己转回来"而不是被拽回去 */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** 软死区：中心附近直接压到 0，跨过边界时是连续的（硬阈值会在边界上"啪"地跳一下） */
function softDeadZone(value, zone) {
  const a = Math.abs(value);
  if (a <= zone) return 0;
  return Math.sign(value) * ((a - zone) / (1 - zone));
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * 爱心爆发（摸头特效），对齐鲸鱼娘插件的实现：
 *
 * 模型自带 `love`（爱心粒子）和 `ParamCheek73`（爱心/心跳）两条参数，它们属于
 * "通用动画(循环)"组 —— 只要把它们顶到 1，爱心就会持续冒；松手自然停。
 * 鲸鱼娘是每帧写这两个参数、持续 2.2 秒，这里照做（比换表情更"有特效感"）。
 *
 * 注意：写参数必须**每帧**做（模型的参数每帧会被动作/表情重置），
 * 所以真正落笔在 applyGazeParameters 里（那里本来就跑在共享 ticker 上）。
 */
function heartBurst(ms) {
  state.heartBurstUntil = performance.now() + (ms || 2200);
}

function heartBurstTick(core, now) {
  const until = state.heartBurstUntil || 0;
  if (until && now <= until) {
    setParam(core, "love", 1);
    setParam(core, "ParamCheek73", 1);
    // 记着"结束后要写几帧 0"。Live2D 的参数**不会自动归零** —— 如果只是不写了，
    // 爱心会一直冒险（这正是之前"表情卡住不恢复"的同一类原因）。
    state.heartBurstTail = 8;
    return;
  }
  if (state.heartBurstUntil) state.heartBurstUntil = 0;
  if (state.heartBurstTail > 0) {
    state.heartBurstTail -= 1;
    setParam(core, "love", 0);
    setParam(core, "ParamCheek73", 0);
  }
}

/* ---------------------------------------------------------------- 压扁弹跳

   移植自鲸鱼娘插件的 qBounce()：点一下会有一下"弹性下压"。

   那边用的是 CSS `el.animate([{transform: scale(...)}...])`。在桌宠这种
   **透明分层窗口**上，transform 会在动画期间反复触发 DWM 整窗重合成 ——
   这正是之前查了很久的卡顿来源。这里改成直接改 PIXI 模型的 scale：
   模型本来就每帧重建，改 scale 不产生新图层，开销只有每帧两次属性写入。
*/
/* ---------------------------------------------------------------- 压扁弹跳

   参数与鲸鱼娘插件的 qBounce() **完全一致**：

     keyframes: scale(1,1) → (1+0.1k, 1-0.12k) → (1-0.045k, 1+0.055k) → (1,1)
     duration : 460ms
     easing   : cubic-bezier(.34, 1.56, .64, 1)
     origin   : 50% 100%（底边中点固定，往下压）

   唯一的区别是**实现手法**：插件用 CSS `el.animate([{transform:...}])`，而桌宠是
   透明分层窗口，transform 动画期间会反复触发 DWM 整窗重合成（卡顿元凶之一）。
   这里按同样的关键帧 + 同样的贝塞尔曲线算出 sx/sy，落到 PIXI 模型的 scale 上，
   并且通过调整 y 复现"底边固定"的 origin，观感一致但没有那笔重合成开销。
*/

const BOUNCE_MS = 460;
const BOUNCE_BEZIER = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

// 关键帧（t 为整体进度 0..1，值是 k=1 时的缩放；实际按 k 缩放增量）
const BOUNCE_KEYS = [
  { at: 0, sx: 1, sy: 1 },
  { at: 1 / 3, sx: 1.1, sy: 0.88 },
  { at: 2 / 3, sx: 0.955, sy: 1.055 },
  { at: 1, sx: 1, sy: 1 },
];

/** 解 cubic-bezier(x1,y1,x2,y2)，输入时间 x，返回缓动后的进度 y。 */
function bezierY(x, b) {
  const x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let u = x;
  for (let i = 0; i < 6; i += 1) {
    const px = ((ax * u + bx) * u + cx) * u;
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(d) < 1e-6) break;
    u -= (px - x) / d;
    u = Math.min(1, Math.max(0, u));
  }
  return ((ay * u + by) * u + cy) * u;
}

/** 给定整体进度 t 和力度 k，算这一帧的 (sx, sy)。 */
function bounceScaleAt(t, k) {
  const e = bezierY(t, BOUNCE_BEZIER);   // 整体缓动（和 WAAPI 的 timing function 一致）
  const p = Math.min(1, Math.max(0, e));
  for (let i = 1; i < BOUNCE_KEYS.length; i += 1) {
    const a = BOUNCE_KEYS[i - 1];
    const b = BOUNCE_KEYS[i];
    if (p <= b.at) {
      const span = b.at - a.at;
      const local = span > 0 ? (p - a.at) / span : 1;
      const sx = a.sx + (b.sx - a.sx) * local;
      const sy = a.sy + (b.sy - a.sy) * local;
      // 关键帧是"k=1 时"的值，这里把增量按 k 缩放。
      // **横向不参与**：插件那套是 scale(x, y) 双向反向挤压，看起来像横向抖动；
      // 用户要的是纯纵向弹跳，所以 sx 恒为 1，只有 sy 变化。
      return [1, 1 + (sy - 1) * k];
    }
  }
  return [1, 1];
}

function bounceModel(power) {
  const base = state.modelScale || 0;
  if (!model || !base) return;
  const baseH = (model.internalModel ? model.internalModel.height : 0) * base;
  // 记下"底边"：origin 50% 100% 等于底边不动，缩放时靠调 y 复现。
  // **上一次弹跳还没结束时不能重新取锚点** —— 那时 model.y 正处在被压扁的中间态，
  // 拿它当底边会让模型一次比一次往下漂（连点几下就明显跑位）。
  if (!state.bounceAt) state.bounceBottom = model.y + baseH;
  state.bounceAt = performance.now();
  state.bouncePower = power == null ? 1 : power;
}

function bounceTick(now) {
  if (!state.bounceAt) return;
  const base = state.modelScale || 0;
  if (!model || !base) {
    state.bounceAt = 0;
    return;
  }
  const baseH = (model.internalModel ? model.internalModel.height : 0) * base;
  const t = (now - state.bounceAt) / BOUNCE_MS;
  if (t >= 1) {
    model.scale.set(base);
    if (state.bounceBottom) model.y = state.bounceBottom - baseH;
    state.bounceAt = 0;
    return;
  }
  const [sx, sy] = bounceScaleAt(t, state.bouncePower || 1);
  model.scale.set(base * sx, base * sy);
  if (state.bounceBottom) model.y = state.bounceBottom - baseH * sy;   // 底边固定
}

function applyGazeParameters(g) {
  const core = model && model.internalModel && model.internalModel.coreModel;
  if (!core) {
    window.__gazeDebug = { error: "no coreModel" };
    return;
  }
  if (typeof core.setParameterValueById !== "function") {
    window.__gazeDebug = { error: "no setParameterValueById", keys: Object.getOwnPropertyNames(Object.getPrototypeOf(core)).slice(0, 20) };
    return;
  }
  setParam(core, "ParamEyeBallX", g.x * GAZE_SCALE_EYE);
  setParam(core, "ParamEyeBallY", -g.y * GAZE_SCALE_EYE);
  setParam(core, "ParamAngleX", g.headX * GAZE_SCALE_HEAD);
  setParam(core, "ParamAngleY", -g.headY * GAZE_SCALE_HEAD);
  setParam(core, "ParamAngleZ", g.headX * GAZE_SCALE_HEAD * 0.25);
  setParam(core, "ParamBodyAngleX", g.bodyX * GAZE_SCALE_HEAD * 0.3);
  heartBurstTick(core, performance.now());
  bounceTick(performance.now());
  // 到期复原**每帧**检查一次：原来挂在 2.5 秒的定时器上，表情到期后最长还要再等
  // 2.5 秒才清掉，观感上就是"改了表情很久不恢复"。这个函数内部先判空/判未到期，
  // 绝大多数帧是零开销。
  tempExprTick();
  window.__gazeDebug = { error: null, phase: g.phase, written: g.x, readBack: readParam(core, "ParamEyeBallX") };
}

function setParam(core, id, value) {
  try {
    core.setParameterValueById(id, value);
  } catch (err) {
    window.__gazeDebug = { error: "set failed: " + id + " " + String(err) };
  }
}

function readParam(core, id) {
  try {
    return Number(core.getParameterValueById(id));
  } catch (err) {
    return null;
  }
}

function setExpression(name, recordHistory = true) {
  if (!model || !name || name === state.expression) return;
  if (!expressionAllowed(name)) return;      // 被关掉的表情直接跳过
  if (recordHistory && state.expression) {
    state.expressionHistory.push(state.expression);
    if (state.expressionHistory.length > 12) state.expressionHistory.shift();
  }
  state.expression = name;
  try {
    const result = model.expression(name);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (err) {
    console.warn("expression failed", name, err);
  }
}

/* ------------------------------------------------------------------ state */

function applyState(payload) {
  state.payload = payload;
  const style = STATE_STYLE[payload.state] || STATE_STYLE.idle;
  const changed = payload.state !== state.key;
  state.key = payload.state;

  ui.chipText.textContent = payload.label || style.label;
  ui.chipDot.style.background = style.color;
  ui.chip.classList.toggle("thinking", payload.state === "thinking" || payload.state === "working");
  const chipAllowed = !state.settings || state.settings.showChip !== false;
  ui.chip.classList.toggle("hidden", !(chipAllowed && payload.title && payload.state !== "idle"));

  // 进度卡片（就在这个页面里，不改窗口尺寸）
  ui.cardDot.style.background = style.color;
  ui.cardState.textContent = payload.label || style.label;
  ui.cardState.style.color = style.color;
  ui.cardTitle.textContent = payload.title || "当前没有进行中的任务";
  ui.cardElapsed.textContent = payload.title ? humanTime(payload.elapsed || 0) : "—";
  ui.cardTools.textContent = payload.tools == null ? "—" : String(payload.tools);
  ui.cardTokens.textContent = payload.tokens || "—";
  ui.cardSource.textContent = payload.source || "—";
  ui.cardActivityText.textContent = payload.activity || "等待 " + (payload.source || "Agent") + " 开始工作…";
  ui.cardSay.textContent = payload.say || "";
  ui.cardUsage.textContent = payload.usage || "";   // 今日新增 / 本会话累积（设置里可切、可关）
  // API 余额（宿主每 60 秒从 DSH 的 /dsh-pet/hud 取一次，随状态下发）
  if (ui.cardBalance) {
    ui.cardBalance.textContent = payload.balance ? `余额 ${payload.balance}` : "";
    ui.cardBalance.classList.toggle("hidden", !payload.balance);
  }

  state.elapsed = payload.elapsed || 0;

  const expression = exprFor(payload.state);
  // **只有状态真的变了**才清掉临时表情。
  // 宿主每秒都会推一次状态（耗时/余额/用量在变），原来每次都清，于是戳出来的表情
  // 活不过一秒就被状态表情顶回去 —— 用户看到的就是"有时候戳了表情不变"。
  if (changed) {
    state.tempExpr = null;
    state.tempUntil = 0;
    state.moodAt = Date.now();     // 顺带修掉：原来每秒都把 moodAt 刷新，
                                   // 导致随机心情永远等不到间隔、实际几乎不触发
  }
  const tempActive = Boolean(state.tempExpr) && Date.now() < state.tempUntil;
  if (!tempActive) {
    if (expression) setExpression(expression);
    else if (changed) {
      state.expression = null;
      try {
        if (model && model.internalModel.motionManager.expressionManager) {
          model.internalModel.motionManager.expressionManager.resetExpression();
        }
      } catch (err) {
        /* older builds do not expose resetExpression */
      }
    }
  }
  if (changed && style.motion) playMotion(style.motion);
  if (changed) {
    layout();
    toast(`${payload.label || style.label}${payload.title ? " · " + short(payload.title, 18) : ""}`);
  }
}

function tick(payload) {
  if (typeof payload.elapsed === "number") {
    state.elapsed = payload.elapsed;
    if (state.payload && state.payload.title && ui.cardElapsed) {
      ui.cardElapsed.textContent = humanTime(state.elapsed);
    }
  }
}

function humanTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分 ${sec % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function setCardOpen(open) {
  const wasOpen = state.cardOpen;
  const nextOpen = Boolean(open);
  const turningOn = nextOpen && !wasOpen;
  const turningOff = !nextOpen && wasOpen;
  state.cardOpen = nextOpen;

  // 打开卡片时把回复气泡收起来（两者同时出现必然盖住模型），
  // 但**记下这条回复**：用户再按一次关掉卡片时，把它原样放回来。
  if (turningOn && chat.shown) {
    chat.suspended = {
      text: chat.target,
      name: ui.chatBubbleName ? ui.chatBubbleName.textContent : "",
      foot: ui.chatBubbleFoot ? ui.chatBubbleFoot.textContent : "",
    };
    chatHide();
  }
  // 关掉卡片：如果之前是因为开卡片才收起的回复，这里放回来
  if (turningOff && chat.suspended) {
    const saved = chat.suspended;
    chat.suspended = null;
    chatShow(saved.text, { name: saved.name, foot: saved.foot, keepSuspended: true });
    chatRenderFull();
  }
  const tooSmall = window.innerHeight < 180 || window.innerWidth < 160;
  if (state.cardOpen && tooSmall) {
    state.cardOpen = false;
    toast("桌宠太小了，放大一点再看进度");
  }
  updateCardDensity();
  applyCardScale();
  ui.card.classList.toggle("hidden", !state.cardOpen);
  layout();          // 只重算模型缩放，不动窗口尺寸
  reportHitbox();
  // 页面可能自己收起过卡片（例如来了回复），把状态回报给宿主，
  // 否则宿主的 inline_card_open 会和实际不一致（"任务完成自动弹卡片"就失效了）。
  bridge.send({ t: "card-state", open: state.cardOpen });
}

function updateCardDensity() {
  const small = window.innerWidth < 320 || window.innerHeight < 360;
  ui.card.classList.toggle("compact", small);
}

// 卡片内容变长/变短时也要重算，保证任何时候都不压到角色
if (window.ResizeObserver) {
  const observer = new ResizeObserver(() => layout());
  observer.observe(el("card"));
  // 气泡同理：打字机把内容一点点长出来，高度变了要重新贴到模型上方，
  // 否则它会按旧高度定位、越写越压住模型（实测 100% 缩放时重叠 48px）。
  const bubbleNode = el("chat-bubble");
  if (bubbleNode) observer.observe(bubbleNode);
}

function short(text, n) {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

let toastTimer = 0;
/**
 * 把反应文字摆到"模型底边"和"按钮顶边"之间的空隙里。
 *
 * 之前只在 layout() 里算，而 layout 有"输入没变就跳过"的守卫（还有提前 return），
 * 结果经常压根没执行，toast 就一直停在 CSS 的默认位置上 —— 也就是按钮底下。
 * 现在**每次显示时都重算**，并且在 layout 里也调一次（缩放/窗口变化要跟）。
 */
function positionToast() {
  if (!ui.toast || !model) return;
  const modelBottom = model.y + model.height;
  let btnTop = 0;
  if (ui.chatBtn) btnTop = ui.chatBtn.getBoundingClientRect().top;
  // 按钮没显示（矩形全 0）时给个兜底
  if (!(btnTop > 0)) btnTop = modelBottom + 8;
  const toastH = ui.toast.getBoundingClientRect().height || 26;
  // 挂在**按钮正上方**：底边离按钮 4px。这样允许压住模型下沿一点 ——
  // 用户说没关系，而且比"把按钮往下推"更省纵向空间。
  let top = Math.round(btnTop - toastH - 4);
  top = Math.max(Math.round(model.y + 8), top);   // 别顶到模型头顶上去
  ui.toast.style.top = `${top}px`;
  ui.toast.style.bottom = "auto";
}

function toast(text) {
  positionToast();
  ui.toast.textContent = text;
  ui.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add("hidden"), 2200);
}

/* ------------------------------------------------- 常驻提示（可手动关闭）

   和 toast 的区别：不自动消失、带关闭按钮、能显示多行。
   用途：DSH 掉线这种"需要用户处理"的情况 —— 提示一次就够，不要反复弹。
   关闭按钮的点击由宿主的鼠标钩子命中（透明窗口收不到网页点击），
   命中矩形通过 bubbleRect 同一条通道上报给宿主。
*/

const notice = {
  open: false,
  userClosed: false,   // 用户手动关过：同一轮故障里不再自动弹回来
  key: "",             // 当前提示的标识（换了 key 才重新弹）
};

/** 显示常驻提示。key 相同且用户没关过时不会重复弹（避免刷屏）。 */
function noticeShow(key, title, body) {
  if (!ui.notice) return;
  if (notice.open && notice.key === key) return;
  if (notice.userClosed && notice.key === key) return;   // 用户关过了，别烦他
  notice.open = true;
  notice.key = key;
  if (ui.noticeTitle) ui.noticeTitle.textContent = title || "提示";
  if (ui.noticeBody) ui.noticeBody.textContent = body || "";
  ui.notice.classList.remove("hidden");
  // 先摆好位置再淡入，免得在错位置闪一下
  noticePosition();
  requestAnimationFrame(() => ui.notice.classList.add("on"));
  layout();
}

function noticeHide() {
  if (!ui.notice) return;
  notice.open = false;
  ui.notice.classList.remove("on");
  setTimeout(() => {
    if (!notice.open) {
      ui.notice.classList.add("hidden");
      layout();
    }
  }, 180);
  layout();
}

/** 摆到模型上方（和气泡错开：气泡贴模型顶，提示再往上）。 */
function noticePosition() {
  if (!ui.notice || !model) return;
  const h = ui.notice.classList.contains("hidden") ? 0 : ui.notice.getBoundingClientRect().height;
  const bubbleOn = ui.chatBubble && ui.chatBubble.classList.contains("on");
  const bubbleH = bubbleOn ? ui.chatBubble.getBoundingClientRect().height : 0;
  // 任务卡片开着时，提示卡要**排在任务卡片下面**，两张卡片不能互相压：
  // 提示卡（登录状态 / DSH 断联）是必须看清的内容，被任务卡片盖住会让人漏掉。
  const cardOn = Boolean(
    ui.card && !ui.card.classList.contains("hidden") && state.cardOpen !== false
  );
  let top;
  if (cardOn) {
    const cardH = ui.card.getBoundingClientRect().height;
    top = Math.round(4 + cardH + 8);
  } else {
    top = Math.round(model.y - bubbleH - h - 10);
  }
  const maxTop = Math.max(2, window.innerHeight - h - 4);
  ui.notice.style.top = `${Math.max(2, Math.min(top, maxTop))}px`;
}


/* --------------------------------------------- 权限申请卡片（DSH approval）

   DSH 需要用户批准时才弹出来（沙箱外操作、写工作区外的文件等）。
   网页收不到鼠标事件，所以「允许 / 拒绝」两个按钮只能由**宿主的全局鼠标钩子**
   命中 —— 位置通过 size 消息上报，和「说话」按钮是同一套机制。

   卡片刻意做得"轻"：
   · 用 opacity 过渡，不用 transform / backdrop-filter（分层窗口下会拖慢整体合成）；
   · 内容只在**状态真的变了**的时候才写 DOM（宿主侧也做了缓存，见 run.py），
     避免轮询把同一个申请反复推过来导致无谓重排。
*/
const approval = {
  open: false,
  id: "",          // 当前申请的 id（换了才重绘）
  key: "",         // 去重键：id + 内容摘要
  dismissedId: "", // 用户点 ✕ 收起的申请 id：同一个申请不再自动弹回来
  // 权限卡片弹出时把任务卡片临时收起（两者都会占用模型上方那条带子，必然重叠），
  // 处理完（通过 / 驳回 / ✕）再把它恢复回来。
  cardWasOpen: false,
  chatWasShown: false,
};

/** 显示（或更新）权限申请。内容没变就只保证可见，不碰 DOM。 */
function approvalShow(pending) {
  if (!ui.approval || !pending) return;
  const pendingId = String(pending.id || "");
  // 用户主动收起过这一条：别再弹回来烦人（换了新申请即恢复）
  if (pendingId && pendingId === approval.dismissedId) return;
  const key = `${pending.id || ""}|${pending.tool || ""}|${pending.detail || ""}|${pending.reason || ""}`;
  const first = !approval.open;
  const changed = approval.key !== key;

  // 权限卡片优先级最高：先把它会重叠的东西收起来（记下来，处理完再恢复）
  if (first) {
    approval.cardWasOpen = Boolean(state.cardOpen);
    approval.chatWasShown = Boolean(chat.shown);
    if (state.cardOpen) setCardOpen(false);
    if (chat.shown) chatHide();
  }

  approval.open = true;
  approval.id = String(pending.id || "");
  approval.key = key;

  if (changed) {
    // 标题固定是"需要授权"，工具名 + 具体内容放正文
    if (ui.approvalTitle) ui.approvalTitle.textContent = pending.title || "需要授权";
    if (ui.approvalTool) {
      const tool = String(pending.tool || "").trim();
      ui.approvalTool.textContent = tool ? `工具：${tool}` : "";
      ui.approvalTool.classList.toggle("hidden", !tool);
    }
    if (ui.approvalDetail) {
      // 优先显示"为什么"，没有再显示具体命令/内容
      const text = String(pending.reason || pending.detail || "").trim();
      ui.approvalDetail.textContent = text || "（无附加说明）";
    }
    // 换了新的申请：取消旧的按下/悬停态，免得残留
    [ui.approvalAllow, ui.approvalDeny].forEach((btn) => {
      if (btn) btn.classList.remove("hot", "press");
    });
  }

  if (first) {
    ui.approval.classList.remove("hidden");
    approvalPosition();
    requestAnimationFrame(() => ui.approval.classList.add("on"));
  } else if (changed) {
    approvalPosition();   // 内容变高变矮，重新贴一下
  }
  layout();
}

/** 收起权限申请卡片。 */
function approvalHide() {
  if (!ui.approval) return;
  const wasOpen = approval.open;
  approval.open = false;
  approval.id = "";
  approval.key = "";
  ui.approval.classList.remove("on");
  if (wasOpen) {
    setTimeout(() => {
      if (!approval.open) {
        ui.approval.classList.add("hidden");
        layout();
      }
    }, 170);
    // 权限处理完了（通过 / 驳回 / ✕）：把刚才让位的东西恢复回来。
    // 任务卡片优先（它是用户主动在看的），否则恢复被收起的回复气泡。
    if (approval.cardWasOpen) {
      approval.cardWasOpen = false;
      approval.chatWasShown = false;
      setCardOpen(true);
    } else if (approval.chatWasShown) {
      approval.chatWasShown = false;
      if (chat.suspended) {
        const saved = chat.suspended;
        chat.suspended = null;
        chatShow(saved.text, { name: saved.name, foot: saved.foot, keepSuspended: true });
        chatRenderFull();
      }
    }
  }
}

/**
 * 用户点了 ✕：只把卡片收起来，**不代替用户回应**（申请仍留在 DSH 里，
 * 想处理还可以去网页界面点）。同时记下这个申请 id，
 * 免得宿主重连后把同一条又推上来 —— 那会显得"关不掉"。
 */
function approvalDismiss() {
  const dismissed = approval.id;
  approval.dismissedId = dismissed;
  approvalHide();
  // 悬停/按下态清掉，下次弹出不会残留高亮
  [ui.approvalAllow, ui.approvalDeny, ui.approvalClose].forEach((btn) => {
    if (btn) btn.classList.remove("hot", "press");
  });
}

/** 摆到模型上方；如果普通气泡和提示也在，就依次往上叠，避免互相压住。 */
function approvalPosition() {
  if (!ui.approval || !model) return;
  const hidden = ui.approval.classList.contains("hidden");
  const h = hidden ? 0 : ui.approval.getBoundingClientRect().height;
  const bubbleOn = ui.chatBubble && ui.chatBubble.classList.contains("on");
  const bubbleH = bubbleOn ? ui.chatBubble.getBoundingClientRect().height : 0;
  const noticeOn = ui.notice && !ui.notice.classList.contains("hidden");
  const noticeH = noticeOn ? ui.notice.getBoundingClientRect().height : 0;
  // 避开任务卡片：权限卡是最需要看清的内容，被任务卡片压住会漏掉
  const cardOn = Boolean(
    ui.card && !ui.card.classList.contains("hidden") && state.cardOpen !== false
  );
  const cardH = cardOn ? ui.card.getBoundingClientRect().height + 8 : 0;
  const top = cardOn
    ? Math.round(4 + cardH + (noticeOn ? noticeH + 8 : 0))
    : Math.round(model.y - bubbleH - noticeH - h - 12);
  ui.approval.style.top = `${Math.max(2, top)}px`;

  // 水平居中：直接算 left，不用 transform（transform 会创建合成层，
  // 让透明分层窗口整体重新合成 —— 见上面 CSS 里的说明）。
  const winW = window.innerWidth || 0;
  const cardW = hidden ? 0 : ui.approval.getBoundingClientRect().width;
  const width = cardW > 0 ? cardW : Math.min(300, Math.max(0, winW - 16));
  ui.approval.style.left = `${Math.max(0, Math.round((winW - width) / 2))}px`;
}



/** 气泡：显示和 chat.deepseek.com 的对话。
 *
 *  流式回复用"类型机"逐字长出来 —— 宿主每 ~400ms 推一次累计文本，
 *  不能直接整段替换，否则字是一跳一跳蹦出来的。
 *  样式对齐参考插件 dsh-whale-girl-live2d 的 dshp-bubble。
 */
const chat = {
  shown: false,
  streaming: false,
  target: "",       // 已经收到的完整文本
  typed: 0,         // 已经长出来的字数
  hideAt: 0,        // 非流式气泡的自动隐藏时间
  ticker: null,
  userScrolled: false,   // 用户手动滚过：别再被"自动贴底"拉回去
  pin: null,             // 本次要把内容滚到哪："top"（新回复，从开头看）/ "bottom"（流式追尾）
  // 因为"打开进度卡片"而被收起来的那条回复：卡片关掉时原样放回来。
  // { text, name, foot }，没有就是 null。
  suspended: null,
  heartBurstUntil: 0,   // 摸头爱心爆发的截止时刻（performance.now 口径）
  heartBurstTail: 0,    // 结束后还要写几帧 0，确保爱心真的收干净
  CHARS_PER_TICK: 2,
};

/** 宿主把滚轮/▲▼按钮转过来时调用：滚动气泡内容。
 *
 *  桌宠窗口对鼠标是全穿透的，网页收不到 wheel 事件，所以滚轮由宿主的全局
 *  鼠标钩子捕获后发消息过来。
 *
 *  方向约定（踩过坑，别改）：宿主那边"滚轮向上"给的是**正值**，
 *  而 scrollTop 加正值是**向下滚**，所以这里必须**取反** ——
 *  否则滚轮上滑会变成看后面的内容（用户实测反馈过方向相反）。
 *  按行滚动，不再乘"内容/视口"比例：那个比例是给拖动设计的，
 *  用在这里会让一格滚过头。
 */
function chatScroll(deltaY) {
  const body = ui.chatBubbleBody;
  if (!body) return;
  const before = body.scrollTop;
  const amount = -(Number(deltaY) || 0);
  body.scrollTop = before + amount;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  // 只要不在底部就算"用户接管了滚动"，自动贴底就不再插手 ——
  // 以前只在"这次是向上滚"时才置位，滚动量小于 1px 时会被判成 false，于是被拉回底部。
  chat.userScrolled = !atBottom;
  chatRefreshScrollButtons();
  // 诊断：宿主转过来的 deltaY 与最终 scrollTop（便于确认方向）
  chat.lastScroll = { in: Number(deltaY) || 0, applied: amount,
                      from: Math.round(before), to: Math.round(body.scrollTop) };
}

/** 刷新两个滚动按钮的状态：到底/到顶时置灰，超出可视区才需要它们。 */
function chatRefreshScrollButtons() {
  const body = ui.chatBubbleBody;
  if (!body || !ui.chatScrollUp) return;
  const scrollable = body.scrollHeight > body.clientHeight + 2;
  const atTop = body.scrollTop <= 1;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
  ui.chatScrollUp.classList.toggle("off", !scrollable || atTop);
  ui.chatScrollDown.classList.toggle("off", !scrollable || atBottom);
}

/* ------------------------------------------------- 气泡富文本渲染

   DeepSeek 的回复是 Markdown + LaTeX。以前这里直接 textContent 写进去，
   所以 **加粗** 、`代码`、\(公式\) 全都原样显示成符号 —— 现在改成渲染成 HTML。

   · Markdown 只做常用子集（标题/列表/引用/代码块/行内代码/加粗/斜体/删除线/链接），
     够用且没有依赖；
   · 公式交给本地 KaTeX（web/lib/katex）真正排版，支持 \(...\)、\[...\]、$...$、$$...$$；
   · **先抽公式再处理 Markdown**：否则 LaTeX 里的 * _ \ 会被当成 Markdown 语法破坏掉。
*/

const CHAT_RICH_INTERVAL_MS = 50;   // 打字机重渲染节流（约 20fps）

// 公式文本 → 原始渲染宽度（px）。见 fitMathInBubble 里的说明。
const MATH_WIDTH_CACHE = new Map();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 用 KaTeX 渲染一段公式；KaTeX 不在或出错时退回等宽原文，绝不抛异常。 */
function renderMath(src, display) {
  const body = String(src == null ? "" : src).trim();
  if (!body) return "";
  const katex = window.katex;
  if (katex && typeof katex.renderToString === "function") {
    try {
      return katex.renderToString(body, {
        displayMode: Boolean(display),
        throwOnError: false,       // 打字过程中公式常是半截的，别报错
        strict: false,
        output: "html",
      });
    } catch (err) {
      /* 落到下面的降级分支 */
    }
  }
  return `<code class="math-fallback">${escapeHtml(body)}</code>`;
}

/** Markdown 子集 + LaTeX → HTML 字符串。 */
function renderRichText(text) {
  const src = String(text == null ? "" : text);
  if (!src) return "";

  // ---- 1) 抽出围栏代码块和公式（先保护起来，免得被后续替换破坏）----
  const slots = [];                       // 占位槽：{ html }
  const stamp = (html) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let work = src.replace(/```([\w+#.-]*)\n([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    return stamp(`<pre class="md-code"><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
  });

  // 行内公式 \(..\) / $..$，块级公式 \[..\] / $$..$$
  work = work.replace(
    /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g,
    (m, b1, b2, b3, b4) => {
      const display = b1 != null || b3 != null;
      const body = b1 != null ? b1 : b3 != null ? b3 : b2 != null ? b2 : b4;
      return stamp(renderMath(body, display));
    }
  );

  // ---- 2) 转义剩下的纯文本 ----
  work = escapeHtml(work);

  // ---- 3) 行内 Markdown ----
  work = work
    .replace(/`([^`\n]+?)`/g, (m, code) => stamp(`<code class="md-inline">${code}</code>`))
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+?)\)/g,
      '<a class="md-link" href="$2" title="$2">$1</a>');

  // ---- 4) 行内代码里的占位要先还原（它的内容不能再被当成 Markdown）----
  //     占位是 \u0000n\u0000，转义不会动它，这里统一在最后还原，顺序无关。

  // ---- 5) 块级 Markdown：按行处理 ----
  const lines = work.split("\n");
  const out = [];
  let listType = "";          // "ul" | "ol" | ""
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = "";
    }
  };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if (!t) { closeList(); out.push(""); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      closeList();
      const level = Math.min(6, m[1].length);
      out.push(`<h${level} class="md-h">${m[2]}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push('<hr class="md-hr" />'); continue; }
    if ((m = /^&gt;\s?(.*)$/.exec(t))) { closeList(); out.push(`<blockquote class="md-quote">${m[1]}</blockquote>`); continue; }
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
      if (listType !== "ul") { closeList(); out.push('<ul class="md-list">'); listType = "ul"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      if (listType !== "ol") { closeList(); out.push('<ol class="md-list">'); listType = "ol"; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="md-p">${t}</p>`);
  }
  closeList();

  let html = out.join("\n");
  // ---- 6) 还原占位（代码块 / 公式 / 行内代码）----
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] || "");
  return html;
}

/**
 * 把过宽的公式等比缩小到气泡宽度以内。
 *
 * 为什么必须缩小、不能加滚动条：桌宠窗口对鼠标是穿透的，网页收不到拖拽事件，
 * **横向滚动条根本拖不动**（纵向是靠滚轮和 ▲▼ 按钮代劳的，横向没有这套机制）。
 * 所以超宽公式只能缩。
 *
 * 为什么用 font-size 而不用 transform: scale：
 *   · KaTeX 内部尺寸全用 em 计算，改字号就是整体等比缩小，排版不会走形；
 *   · transform 会创建新合成层，而桌宠是色键透明的分层窗口 ——
 *     之前按钮用 transform 就导致鼠标划过卡顿，这里必须避开同一个坑。
 *
 * 为什么不能用 scrollWidth 量宽度（踩过的坑）：
 *   `.katex-display` 是 `text-align: center`，超宽内容会**左右两侧同时溢出**，
 *   而 scrollWidth 只统计右侧溢出 —— 量出来只有真实宽度的一半左右，
 *   于是缩得不够、右侧依旧被裁。必须用内部元素的 getBoundingClientRect().width
 *   量真实宽度（它不受居中和溢出裁剪影响）。
 */
function fitMathInBubble(container) {
  if (!container) return;
  // 可用宽度 = 容器内容盒宽度（clientWidth 含 padding，要减掉）
  const cs = getComputedStyle(container);
  const avail = container.clientWidth
    - (parseFloat(cs.paddingLeft) || 0)
    - (parseFloat(cs.paddingRight) || 0);
  if (avail <= 24) return;

  /**
   * 量公式的**真实内容宽度**。这块踩了五个坑，实测数据记在这里免得以后又绕回去：
   *   rangeK=206.7 / rangeHtml=206.7 / scrollWidth=209 —— 全被容器宽度夹住了；
   *   克隆挂到**气泡容器内**也只有 206.7（绝对定位的包含块就是气泡）；
   *   只有克隆挂到 **document.body** 才量到真实的 315.1。
   * 原因：`.katex-display` 是 text-align:center、`.katex` 是 display:block，
   * 盒子被撑满容器、内容只是"溢出显示"，所以基于现有盒子的测量都拿不到真值。
   * 办法：克隆挂到 body、绝对定位挪到屏幕外、width:auto（shrink-to-fit）、
   * 并用**绝对 px 字号**保证渲染尺寸与气泡里一致；量完立刻移除。
   */
  const measure = (el) => {
    // 同一个公式的**原始宽度**只需要量一次：打字机期间每 ~50ms 重渲染一次，
    // 回复里公式一多，每次都克隆整棵 KaTeX DOM 很浪费（会有卡顿感）。
    // 只在"字号已被复位"时用缓存 —— 缩放后的宽度不能混进缓存。
    const cacheKey = el.style.fontSize ? "" : (el.textContent || "").trim();
    if (cacheKey) {
      const hit = MATH_WIDTH_CACHE.get(cacheKey);
      if (hit) return hit;
    }
    let clone = null;
    try {
      const computed = getComputedStyle(el);
      clone = el.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.left = "-9999px";
      clone.style.top = "0";
      clone.style.width = "auto";
      clone.style.maxWidth = "none";
      clone.style.whiteSpace = "nowrap";
      clone.style.fontSize = computed.fontSize;   // 绝对 px，挂到 body 也保持一致
      clone.style.visibility = "hidden";
      document.body.appendChild(clone);
      const width = clone.getBoundingClientRect().width;
      if (width > 0) {
        if (cacheKey) {
          if (MATH_WIDTH_CACHE.size > 60) MATH_WIDTH_CACHE.clear();   // 简单上限，防无限增长
          MATH_WIDTH_CACHE.set(cacheKey, width);
        }
        return width;
      }
    } catch (err) {
      /* 落到下面的兜底 */
    } finally {
      if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
    }
    return el.scrollWidth || 0;
  };

  const MIN_SCALE = 0.45;      // 再小就看不清了，宁可轻微裁切
  // 安全边距：KaTeX 的根号横线等字形有负边距，正好顶满可用宽度时会被裁掉一点，
  // 所以按"可用宽度 - 8px"来缩。
  const target = Math.max(30, avail - 8);

  const shrink = (el) => {
    el.style.fontSize = "";                 // 先复位，按原始尺寸量
    const need = measure(el);
    if (!need || need <= target + 0.5) return;   // 没超宽：保持原样

    // 第一步按比例直接算到位（KaTeX 尺寸随 em 线性缩放，一步就基本准确）
    let scale = Math.max(MIN_SCALE, target / need);
    el.style.fontSize = scale.toFixed(3) + "em";
    if (scale <= MIN_SCALE + 0.001) return;

    // 再用实测宽度补一两次（吸收小数舍入带来的细微溢出）
    for (let i = 0; i < 2; i += 1) {
      const now = measure(el);
      if (!now || now <= target + 0.5) return;
      const cur = parseFloat(el.style.fontSize) || 1;
      const next = Math.max(MIN_SCALE, cur * (target / now));
      if (Math.abs(next - cur) < 0.005) return;   // 收敛了，别再动
      el.style.fontSize = next.toFixed(3) + "em";
    }
  };

  // 块级公式：独占一行，直接按自身宽度量
  container.querySelectorAll(".katex-display").forEach(shrink);
  // 行内公式：只有它自己就比整行还宽时才缩（否则让它自然换行）
  container.querySelectorAll(".katex").forEach((el) => {
    if (el.closest(".katex-display")) return;
    shrink(el);
  });

}


function chatEnsureTicker() {
  if (chat.ticker) return;
  const shared = PIXI.Ticker.shared;
  chat.ticker = () => {
    const body = ui.chatBubbleBody;
    if (!body) return;
    if (chat.typed < chat.target.length) {
      // 落后越多长得越快，免得长回复永远追不上
      const lag = chat.target.length - chat.typed;
      const step = Math.max(chat.CHARS_PER_TICK, Math.ceil(lag / 12));
      chat.typed = Math.min(chat.target.length, chat.typed + step);
      // 富文本（Markdown + 公式）每次重渲染有成本，节流到 ~20fps；
      // 打字机本身不需要每帧都重排整段 HTML。
      const nowMs = performance.now();
      if (chat.typed >= chat.target.length ||
          nowMs - (chat.richAt || 0) >= CHAT_RICH_INTERVAL_MS) {
        chat.richAt = nowMs;
        body.innerHTML = renderRichText(chat.target.slice(0, chat.typed));
        // 渲染完立刻把超宽公式缩到能放下（量宽度会触发一次布局，只在有公式时有成本）
        fitMathInBubble(body);
      }
      if (chat.typed >= chat.target.length) {
        // 打完字了：把最后的贴底/贴顶动作做完，之后不再每帧动它
        chatApplyPin(body);
      }
      chatRefreshScrollButtons();
    } else if (!chat.streaming && chat.hideAt && Date.now() > chat.hideAt) {
      chatHide();
    }
  };
  shared.add(chat.ticker, null, 12);   // 排在模型更新(0)之后、渲染(25)之前
}

/**
 * 决定这次要不要把气泡滚到某个位置。
 *
 * 用户明确要的：**抓到新回复后从最上面开始显示**。所以 `chat.pin = "top"` 时
 * 把 scrollTop 归零，而不是原来那样一路贴到最底（贴底会让人一上来就看见回复的
 * 结尾，前面全被滚过去了）。
 *
 * 只做一次（做完清掉标记）：之后用户自己滚轮浏览时不能再被强行拉走；
 * 而且每帧都写 scrollTop 会让滚动条一直在动、还会和用户的滚动打架。
 */
function chatApplyPin(body) {
  if (!body || !chat.pin) return;
  const where = chat.pin;
  chat.pin = null;
  if (chat.userScrolled) return;          // 用户自己滚过了：别抢
  if (where === "top") {
    body.scrollTop = 0;
  } else {
    body.scrollTop = body.scrollHeight;
  }
  chatRefreshScrollButtons();
}

function chatPosition() {
  if (!model || !ui.chatBubble) return;
  const bubbleH = ui.chatBubble.classList.contains("hidden")
    ? 0
    : ui.chatBubble.getBoundingClientRect().height;
  const top = Math.max(4, Math.round(model.y - bubbleH - 8));
  ui.chatBubble.style.top = `${top}px`;
}

function chatShow(text, opts) {
  const o = opts || {};
  if (!ui.chatBubble) return;
  // 卡片和气泡互斥：纵向只有一条带子（模型上方 ~174px），两者同时出现必然重叠、
  // 盖住模型。回复比"进度快照"更重要，所以显示回复时先收起卡片。
  if (state.cardOpen) {
    // 有新回复要显示：之前暂存的旧回复就不用再恢复了，清掉以免它盖住这条新的
    chat.suspended = null;
    setCardOpen(false);
  }
  // 恢复调用（卡片关掉时）要保留暂存以外的语义；正常显示新回复则清掉暂存
  if (!o.keepSuspended) chat.suspended = null;
  chatEnsureTicker();
  if (o.name && ui.chatBubbleName) ui.chatBubbleName.textContent = o.name;
  chat.target = String(text == null ? "" : text);
  if (o.restart) {
    chat.typed = 0;
    chat.userScrolled = false;   // 新一轮回复：清掉"用户接管过"的标记
    // 用户要求：抓到回复后**从最上面开始显示**（别再一路贴底，
    // 那样一上来只能看见回复的结尾）。真正的滚动在 ticker 里做，
    // 因为那时 DOM 才刚更新完、scrollHeight 才是准的。
    chat.pin = "top";
  } else {
    // 流式追加：内容在往下长，保持贴底才跟得上（且只做一次，之后交给用户）
    chat.pin = chat.pin || "bottom";
  }
  chat.streaming = Boolean(o.streaming);
  chat.hideAt = o.ttl ? Date.now() + o.ttl : 0;
  if (ui.chatBubbleDot) ui.chatBubbleDot.classList.toggle("pulse", chat.streaming);
  if (ui.chatBubbleFoot) ui.chatBubbleFoot.textContent = o.foot || "";
  ui.chatBubble.classList.remove("hidden");
  // 先把位置算好再显示，避免它在错误位置闪一下
  chatPosition();
  requestAnimationFrame(() => ui.chatBubble.classList.add("on"));
  chat.shown = true;
  layout();
  chatRefreshScrollButtons();
}

/**
 * 立刻把整段文本渲染出来（不给打字机逐字长）。
 *
 * 用于"卡片关掉后把之前收起的回复放回来"：这条回复用户已经看过，
 * 再逐字打一遍既慢又奇怪。
 */
function chatRenderFull() {
  if (!ui.chatBubbleBody) return;
  chat.typed = chat.target.length;
  chat.pin = "top";
  ui.chatBubbleBody.innerHTML = renderRichText(chat.target);
  fitMathInBubble(ui.chatBubbleBody);
  chatApplyPin(ui.chatBubbleBody);
  chatRefreshScrollButtons();
  layout();
}

function chatHide() {
  if (!ui.chatBubble) return;
  chat.streaming = false;
  chat.hideAt = 0;
  if (ui.chatBubbleDot) ui.chatBubbleDot.classList.remove("pulse");
  ui.chatBubble.classList.remove("on");
  chat.shown = false;
  // 等过渡走完再真正隐藏，并清掉占位
  setTimeout(() => {
    if (!chat.shown) {
      ui.chatBubble.classList.add("hidden");
      if (ui.chatBubbleBody) ui.chatBubbleBody.textContent = "";
      layout();
    }
  }, 200);
  layout();
}

function chatSetHot(hot) {
  if (ui.chatBtn) ui.chatBtn.classList.toggle("hot", Boolean(hot));
}

/** which → 按钮节点 */
function petBtnNode(which) {
  const map = {
    chat: ui.chatBtn,
    dsh: ui.dshBtn,
    deepseek: ui.deepseekBtn,
    close: ui.chatClose,
    "notice-close": ui.noticeClose,
    "approval-allow": ui.approvalAllow,
    "approval-deny": ui.approvalDeny,
    "approval-close": ui.approvalClose,
    "card-close": ui.cardClose,
    "card-key": ui.cardBtn,
    "scroll-up": ui.chatScrollUp,
    "scroll-down": ui.chatScrollDown,
  };
  return map[which] || null;
}

/** 宿主驱动的高亮（悬停）：which = chat | dsh | deepseek | close | scroll-up | scroll-down */
function petBtnHot(which, hot) {
  const node = petBtnNode(which);
  if (node) node.classList.toggle("hot", Boolean(hot));
}

/**
 * 按下 / 松开反馈。
 *
 * 网页收不到鼠标事件（透明窗口是穿透的），所以"按下去"这个瞬间只能由宿主的
 * 全局鼠标钩子告诉我们。这里加 .press 类做出"按进去"的观感。
 *
 * 防丢复位：万一松开的消息没到（钩子被摘、窗口失焦等），按钮会一直卡在按下的
 * 样子，所以每种按钮都挂一个兜底定时器，超时就自己弹回来。
 */
const petPressTimers = {};
function petBtnPress(which, on) {
  const node = petBtnNode(which);
  if (!node) return;
  if (petPressTimers[which]) {
    clearTimeout(petPressTimers[which]);
    petPressTimers[which] = null;
  }
  node.classList.toggle("press", Boolean(on));
  if (on) {
    petPressTimers[which] = setTimeout(() => {
      node.classList.remove("press");
      petPressTimers[which] = null;
    }, 700);
  }
}

function chatButtonVisible(visible) {
  if (ui.chatBtn) ui.chatBtn.classList.toggle("hidden", !visible);
  layout();
}

/** 宿主发来的聊天消息：宿主负责和 chat.deepseek.com 通信，这里只管显示。 */
function applyChatMessage(msg) {
  const action = msg.action;
  if (action === "delta") {
    // 流式：累计文本
    chatShow(String(msg.text || ""), {
      name: msg.name || "DeepSeek",
      streaming: true,
      restart: !chat.shown,
      foot: msg.foot || "正在回复…",
    });
  } else if (action === "done") {
    // ttl=0 / 不传 = 一直留着，直到用户点右上角的 ✕ 手动收起
    const ttl = msg.ttl == null ? 0 : Number(msg.ttl);
    chatShow(String(msg.text || ""), {
      name: msg.name || "DeepSeek",
      streaming: false,
      foot: msg.foot || "",
      ttl: ttl > 0 ? ttl : 0,
      // 抓取完成：让打字机从头长一遍，并把气泡钉到**最上面** ——
      // 用户要的就是"抓到回复后自动翻到回复的最上面"，而不是停在结尾。
      restart: true,
    });
  } else if (action === "thinking") {
    chatShow(String(msg.text || "正在思考…"), {
      name: msg.name || "DeepSeek",
      streaming: true,
      restart: true,
      foot: msg.foot || "",
    });
  } else if (action === "error") {
    chatShow(String(msg.text || "出错了"), {
      name: "提示",
      streaming: false,
      foot: "",
      ttl: 6000,
    });
  } else if (action === "hide") {
    chatHide();
  } else if (action === "enable") {
    chatButtonVisible(msg.enabled !== false);
    // 两个快捷键按钮跟着一起显隐（只在接入 DSH 时出现）
    for (const node of [ui.dshBtn, ui.deepseekBtn]) {
      if (node) node.classList.toggle("hidden", msg.enabled === false);
    }
    layout();
  }
}

/* ------------------------------------------------------------ interactions */

// 进度卡片已经改成宿主那边的独立窗口，网页不再做任何"变大变小"，
// 桌宠窗口尺寸一旦确定就永远不动（频繁改尺寸是性能杀手）。

function wireInteractions() {
  // 透明窗口是分层的，网页收不到鼠标事件；点击/拖动由宿主程序读取鼠标状态后发消息过来，
  // 所以这里只保留"被戳到了怎么反应"。
  //
  // 顺带把右键默认行为整页拦掉（捕获阶段，先于任何元素）：WebView2 已经关掉了自带
  // 右键菜单，不拦的话没被消费的 WM_CONTEXTMENU 会冒泡给宿主窗口，把窗口自己的
  // 系统菜单（还原/移动/大小/关闭）勾出来。
  window.addEventListener("contextmenu", (ev) => ev.preventDefault(), true);
  initProbe();
}

/* —— 像素级命中探测 ——

   窗口的"点击穿透"是色键（洋红）做的：网页透明像素 = 洋红 = 鼠标点直接穿到桌面。
   所以"点在不在角色身上"也只能按**像素**判断。宿主一直在等网页发 {t:"over"}，
   而网页以前从来没发过，于是只能退回"角色包围盒"判断 —— 包围盒里的透明缝隙
   （发丝之间、手臂和身体之间、两条腿之间）就变成"又穿过去了、又当成点中了角色"：
   右键同时弹两个菜单，拖动顺带点到下面的窗口，都是这么来的。

   采样时机是关键：画布没开 preserveDrawingBuffer，只有**这一帧渲染刚结束**时读到的
   才是有效像素（实测：挂在 PIXI.Ticker.shared 默认优先级上永远读到 0，因为那一刻
   渲染还没发生）。所以这里包住 renderer.render，在它返回之后立刻读。

   开销控制：一次只读 1 个像素、~20Hz、而且**光标不在窗口里就完全不读** ——
   早期版本每 120ms 读一次整块画布，把 GPU 流水线读停顿了，这次不能再犯。 */
const probe = {
  canvas: null,
  ctx: null,
  usable: null,    // null=还没测过 / true=像素读数可信 / false=不可用（宿主退回包围盒判断）
  over: null,      // 上一次报给宿主的值
  sampled: false,  // 真采到过一次样才允许上报，避免链路没起来时把点击全禁掉
  lastAt: 0,
  lastPt: null,    // 上一次采样的画布坐标（用来判断光标动没动）
};

function initProbe() {
  probe.canvas = document.createElement("canvas");
  probe.canvas.width = 1;
  probe.canvas.height = 1;
  probe.ctx = probe.canvas.getContext("2d", { willReadFrequently: true });
  const renderer = app && app.renderer;
  if (!renderer || typeof renderer.render !== "function") return;
  const original = renderer.render.bind(renderer);
  renderer.render = (...args) => {
    original(...args);
    sampleProbe();
  };
}

/** 光标位置折算成画布像素坐标（画布带 resolution/autoDensity，按比例换算）。 */
function probePoint() {
  const canvas = canvasElement();
  const cur = state.cursor;
  if (!canvas || !cur || !cur.inside || typeof cur.x !== "number") return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.floor((cur.x - rect.left) * (canvas.width / rect.width));
  const y = Math.floor((cur.y - rect.top) * (canvas.height / rect.height));
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return { x, y };
}

function sampleProbe() {
  const pt = probePoint();
  const sameSpot = Boolean(pt && probe.lastPt && pt.x === probe.lastPt.x && pt.y === probe.lastPt.y);
  const now = performance.now();
  // 光标一动就跟帧采（把刚移开就按下的滞后压到 1 帧内）；
  // 光标不动时只是隔一会儿复核一下（模型自己会动），没必要每帧去读 GPU。
  if (now - probe.lastAt < (sameSpot ? 500 : 16)) return;
  probe.lastAt = now;
  probe.lastPt = pt;
  if (!pt) {
    reportProbe(false, 0);                  // 光标不在窗口里，那一定不是"点在角色上"
    return;
  }
  try {
    const ctx = probe.ctx;
    ctx.clearRect(0, 0, 1, 1);
    ctx.drawImage(canvasElement(), pt.x, pt.y, 1, 1, 0, 0, 1, 1);
    const alpha = ctx.getImageData(0, 0, 1, 1).data[3];
    probe.sampled = true;
    if (probe.usable !== true) {
      probe.usable = true;
      const canvas = canvasElement();
      const box = canvas ? canvas.getBoundingClientRect() : null;
      // 画布尺寸/CSS 尺寸/dpr 一起带上：宿主据此就能验证"采样点 = 光标点"
      bridge.send({
        t: "over-probe",
        value: true,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        css: box ? [Math.round(box.width), Math.round(box.height)] : null,
        dpr: window.devicePixelRatio || 1,
      });
    }
    // alpha>8 = 这一格真的画了东西 = 屏幕上不是洋红 = 点下去归桌宠
    reportProbe(alpha > 8, alpha);
  } catch (err) {
    if (probe.usable !== false) {
      probe.usable = false;
      bridge.send({ t: "over-probe", value: false });
    }
  }
}

/** 只在结论变化时上报：宿主 on_character() 用的就是这个值。
    x/y/alpha 只是给日志排查用的，宿主判断只看 value。 */
function reportProbe(over, alpha) {
  const value = Boolean(over);
  if (!probe.sampled || value === probe.over) return;
  probe.over = value;
  const pt = probe.lastPt;
  bridge.send({ t: "over", value, x: pt ? pt.x : null, y: pt ? pt.y : null, alpha: alpha });
}


/* ---------------------------------------------------------------- 戳戳互动

   移植自 DSH 网页版鲸鱼娘插件的 poke()：核心不是"点一下换个表情"，而是
     · **连击分档**：看滑动窗口里的点击速率，慢点只是可爱反应，手快才会撒娇抗议，
       手速党才会真炸毛（而且炸毛后有冷静期，不会一直凶人）
     · **加权表情池 + 专属台词**，连续点不重复
     · **干活时**走"人家在忙"的池子，只给一次性反应，不动工作状态
     · 部分表情附带爱心爆发（复用 heartBurst）

   卡顿考量：这里没有任何每帧逻辑，也没有新的 CSS 合成层（不用 transform/滤镜），
   点击时只是一次临时表情 + 一次 toast 文案，开销和原来的"换个表情"同一量级。
*/

// 连击分档阈值（毫秒）。数值直接沿用鲸鱼娘插件，手感是调过的。
const POKE_TIER = {
  window: 2600,     // 统计窗口
  softCount: 4,     // 窗口内至少 4 下
  softGap: 420,     // 且平均间隔 ≤ 420ms（≈2.4 下/秒）→ 撒娇抗议
  hardCount: 7,     // 窗口内至少 7 下
  hardGap: 260,     // 且平均间隔 ≤ 260ms（≈3.8 下/秒）→ 真炸毛
  softCool: 1500,   // 撒娇之间的最小间隔
  angerCool: 6000,  // 炸毛后的冷静期
};

// 干活时被戳：带一点"人家在忙啦"
const POKE_BUSY = [
  { face: "调皮", w: 1.4, lines: ["别闹啦，人家在忙", "等一下下嘛", "（嘴上嫌弃，手上没停）", "手拿开啦，正忙着呢"] },
  { face: "生气", w: 0.4, lines: ["主人！人家正在忙", "再戳就做不完了哦", "（气鼓鼓地继续干活）"] },
  { face: "脸红", w: 1.2, lines: ["唔…等我弄完再说", "（被戳得晃了一下，又低头看本子）"] },
  { face: "开心兴奋", w: 1.2, lines: ["知道啦知道啦", "（抬头笑一下，又埋头干活）", "在在在，人家听着呢"] },
  { face: "吐舌", w: 1.0, lines: ["忙着呢，不理你", "略，等会儿再说"] },
  { face: "星星眼", w: 0.6, lines: ["！（笔掉了）", "吓人家一跳！"] },
];

// 摸头（宿主判定为头部区域）
const POKE_HEAD = [
  { face: "脸红", w: 1.6, fx: "heart", lines: ["不要突然摸头啦……再摸一下也不是不行。", "唔…头发要乱了啦", "（脸红）就、就一下哦", "哼，才没有很享受", "（尾巴尖偷偷晃了一下）"] },
  { face: "开心兴奋", w: 1.4, lines: ["嘿嘿～主人", "嗯？叫人家吗", "在的在的", "摸摸头也不错嘛", "（眯着眼睛蹭了一下）"] },
  { face: "爱心眼", w: 1.0, fx: "heart", lines: ["最喜欢主人了", "（冒爱心）", "（踮脚）还要！", "今天也最喜欢主人"] },
  { face: "调皮", w: 1.0, lines: ["哼，就这一次哦", "才、才没有很开心", "别以为人家好哄", "（嘴上嫌弃，头却没躲）"] },
  { face: "星星眼", w: 0.8, lines: ["（眼睛亮了一下）", "再摸一下？", "今天心情不错嘛"] },
];

// 戳身体
const POKE_BODY = [
  { face: "调皮", w: 1.3, lines: ["别戳啦", "痒！", "（躲了一下）", "手拿开啦", "戳我干嘛呀"] },
  { face: "吐舌", w: 1.1, lines: ["略略略", "就不理你", "（吐舌头）", "戳一下换一碗白饭，成交吗"] },
  { face: "脸红", w: 1.0, fx: "heart", lines: ["别、别戳那里啦", "唔…", "（往后缩了缩）"] },
  { face: "开心兴奋", w: 1.0, lines: ["嗯？什么什么", "主人在叫人家吗", "（凑过来）"] },
  { face: "生气", w: 0.35, lines: ["再戳就生气了", "（气鼓鼓）", "说了别戳啦"] },
];

// 摸头用的台词（从上面 POKE_HEAD 拍平；表情不再用，只要台词）
const HEAD_LINES = POKE_HEAD.reduce((acc, it) => acc.concat(it.lines || []), []);

// 手快被戳痒 / 真炸毛
// 手快被戳痒：每个条目自带表情和对应台词（之前是"随机表情 + 通用台词"，
// 于是会出现"脸红配一句生气的话"这种文不对脸的情况；鲸鱼娘插件是成对的）。
const POKE_TICKLISH = [
  { face: "调皮", w: 1.3, lines: ["好痒！别戳这么快啦", "（缩成一团）", "别戳啦别戳啦"] },
  { face: "脸红", w: 1.1, lines: ["慢、慢一点啦", "（边躲边笑）", "唔…太痒了"] },
  { face: "吐舌", w: 0.9, lines: ["哈哈哈不要", "戳这么快想干嘛", "（笑得停不下来）"] },
];

// 真炸毛：同样是成对的（生气多半，偶尔被戳晕）
const POKE_MANY = [
  { face: "生气", w: 1.8, lines: ["再戳人家真的要生气了！", "哼！不理你了", "主人你够了哦", "（炸毛）"] },
  // 不用「晕晕」：那张"被砸晕"的脸之前被明确要求从所有池子里移除
  { face: "流汗", w: 0.5, lines: ["（被戳得有点晕）", "别、别戳了啦"] },
];

const pokeState = { times: [], softAt: 0, angerAt: 0, lastPick: {} };

function pokePrune(now) {
  const t = pokeState.times;
  while (t.length && now - t[0] > POKE_TIER.window) t.shift();
}

function pokeRecord(now) {
  const t = pokeState.times;
  t.push(now);
  if (t.length > 60) t.splice(0, t.length - 60);
  pokePrune(now);
}

/** 现在的手速处在哪一档。只读，不改记录。 */
function pokeTier(now) {
  pokePrune(now);
  const t = pokeState.times;
  const count = t.length;
  const gap = count >= 2 ? (t[count - 1] - t[0]) / (count - 1) : Infinity;
  const T = POKE_TIER;
  const rapid = count >= T.softCount && gap <= T.softGap;
  const furious =
    rapid && count >= T.hardCount && gap <= T.hardGap && now - pokeState.angerAt > T.angerCool;
  return { count, gap, rapid, furious };
}

/** 按权重抽一个（同时跳过被设置关掉的表情）。 */
function pickWeighted(list) {
  let source = (list || []).filter((it) => it && expressionAllowed(it.face));
  if (!source.length) return null;
  // 别抽到"当前正显示的那张脸"：同一个表情再设一次，画面上等于没变化
  // （台词会换，但用户先看到的是脸）。
  // 两个都要避开：
  //   · state.expression —— 当前实际在演的那张脸（可能是状态底表情，比如
  //     working 的"开心兴奋"，而戳的池子里也有它）；
  //   · state.tempExpr   —— 正在演的临时表情。
  if (source.length > 1) {
    const busyFaces = [state.expression, state.tempExpr].filter(Boolean);
    if (busyFaces.length) {
      const others = source.filter((it) => !busyFaces.includes(it.face));
      if (others.length) source = others;
    }
  }
  let total = 0;
  for (const it of source) total += it.w || 1;
  let r = Math.random() * total;
  for (const it of source) {
    r -= it.w || 1;
    if (r <= 0) return it;
  }
  return source[source.length - 1];
}

/** 从台词里抽一句，尽量不和上一句重复。 */
function pickFreshFrom(lines, key) {
  const list = lines || [];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  let pick = list[Math.floor(Math.random() * list.length)];
  if (pick === pokeState.lastPick[key]) {
    const i = list.indexOf(pick);
    pick = list[(i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length];
  }
  pokeState.lastPick[key] = pick;
  return pick;
}

/** 执行一次互动：一个表情 + 一句台词 +（至多）一个爱心爆发。 */
function pokeAct(hit, ms, withMotion) {
  if (!hit) return;
  setTempExpression(hit.face, ms / 1000);
  if (hit.fx === "heart") heartBurst(ms);
  if (hit.lines && hit.lines.length) {
    // key 用表情名 + 首句：不同条目可能共用同一个表情（比如"调皮"在身体池和
    // 撒娇池里都有），只看表情名会让它们互相污染"上一句"的记录。
    toast(pickFreshFrom(hit.lines, "line-" + hit.face + "-" + hit.lines[0]));
  }
  // 连点时不放动作：多个动作叠着播最容易掉帧，而且视觉上也乱
  if (withMotion) playMotion(Math.random() < 0.5 ? "Tap" : "Show");
}

/** 单击身体：完整移植鲸鱼娘的分档逻辑。 */
function pokeReact() {
  const now = performance.now();
  const key = state.key || "idle";
  const busy = key !== "idle" && key !== "done";

  // 干活时被戳：只给一次性反应，不动工作状态
  if (busy) {
    pokeAct(pickWeighted(POKE_BUSY), 1200, true);
    return;
  }

  pokeRecord(now);
  const tier = pokeTier(now);

  // 真炸毛：只有手速党见得到，且有冷静期
  if (tier.furious) {
    pokeState.angerAt = now;
    pokeAct(pickWeighted(POKE_MANY), 1400, true);
    return;
  }

  // 手快但没到炸毛：撒娇抗议（有最小间隔，免得连点变刷屏）
  if (tier.rapid && now - pokeState.softAt > POKE_TIER.softCool) {
    pokeState.softAt = now;
    pokeAct(pickWeighted(POKE_TICKLISH), 1300, true);
    return;
  }

  // 12% 概率喷水：沿用鲸鱼娘"把 splash 绑在左键点她上"的设计
  if (Math.random() < 0.12 && playMotion("Splash")) {
    bounceModel(1.25);
    toast(pickFreshFrom(["（喷水）噗——", "鲸鱼是会喷水的！", "（喷你一脸）嘻嘻"], "splash"));
    return;
  }

  // 普通一次戳：加权池 + 专属台词（连点不重复），不放动作以免叠播
  bounceModel(1);
  pokeAct(pickWeighted(POKE_BODY), 1200, false);
}

function reaction(kind) {
  if (kind === "pat") {
    // 摸头：只做爱心爆发 + 一句台词 + 弹一下，**不再改表情**（用户要求删除）
    heartBurst(1500);
    bounceModel(0.85);
    toast(pickFreshFrom(HEAD_LINES, "head"));
  } else if (kind === "poke") {
    // 单击戳戳：连击分档 + 加权池（见 pokeReact）
    pokeReact();
  } else if (kind === "drag") {
    // 拖拽：只记录状态，**不再改表情**（用户要求删除）
  } else if (kind === "drop") {
    bounceModel(0.7);            // 放下时弹一下就够了
  } else if (kind === "motion") {
    playMotion(Math.random() < 0.5 ? "Tap" : "Show");
    setTempExpression(pickAllowed(MOOD_POOLS[state.key] || MOOD_POOLS.idle), 1.4);
  }
}

function cycleExpression() {
  const names = expressionNames().filter(expressionAllowed);   // 双击换表情也会跳过被关掉的
  if (!names.length) {
    toast("没有可用的表情（都被白名单关掉了？）");
    return;
  }
  expressionCursor = (expressionCursor + 1) % names.length;
  const name = names[expressionCursor];
  setTempExpression(name, 6);
  toast("表情：" + name);
}

/* ------------------------------------------------------------------- boot */

bridge.onMessage((raw) => {
  let msg = raw;
  if (typeof raw === "string") {
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
  }
  if (!msg) return;
  // 宿主会把同一帧的多条消息**打包成一个数组**一次发过来（见 run.py 的 flush）：
  // 每次 PostWebMessageAsJson 都是界面线程上的同步跨进程调用，鼠标划过按钮时
  // "视线 + 高亮"会各发一次，打包成一次能直接砍掉一半开销。逐条按顺序处理，
  // 顺序与以前逐条发送时完全一致。
  if (Array.isArray(msg)) {
    for (const one of msg) applyHostMessage(one);
    return;
  }
  applyHostMessage(msg);
});

function applyHostMessage(msg) {
  if (!msg || !msg.t) return;
  if (msg.t === "state") applyState(msg.data);
  if (msg.t === "tick") tick(msg.data);
  if (msg.t === "cursor") onCursor(msg.data);
  if (msg.t === "settings") applySettings(msg.data);
  if (msg.t === "card") setCardOpen(msg.open);
  if (msg.t === "react") reaction(msg.kind);
  if (msg.t === "cycle-expression") cycleExpression();
  if (msg.t === "status-request") bridge.send({ t: "status", data: window.__pet.getStatus() });
  if (msg.t === "snapshot-request") {
    try {
      const canvas = canvasElement();
      const url = canvas ? canvas.toDataURL("image/png") : "";
      bridge.send({ t: "snapshot", data: url });
    } catch (err) {
      bridge.send({ t: "snapshot", data: "", error: String(err) });
    }
  }
  if (msg.t === "say") {
    toast(String(msg.text || ""));
  }
  if (msg.t == "button-page-action") {
    if (msg.action === "undo-expression") undoExpression();
    if (msg.action === "clear-card") clearCard();
  }
  if (msg.t === "mute") muteAnimations(Number(msg.seconds) || 300);
  // 宿主隐藏桌宠（切到 DSH）时暂停渲染；恢复显示时再开回来。
  // 不做这件事的话，窗口 Hide 了但页面还在满帧跑，长时间空转会积热、掉帧。
  if (msg.t === "render") setRenderPaused(msg.paused === true);
  // 常驻提示：DSH 掉线这类"需要用户处理"的情况用它，不自动消失、可手动关闭
  if (msg.t === "notice") {
    if (msg.show === false) {
      noticeHide();
      notice.userClosed = false;    // 故障解除：下一轮可以再提示
      notice.key = "";
    } else {
      noticeShow(String(msg.key || "notice"), msg.title, msg.body);
    }
  }
  if (msg.t === "chat") applyChatMessage(msg);
  if (msg.t === "chat-scroll") chatScroll(msg.deltaY);
  // 权限申请：pending 为空表示"没有待批准的申请了"，收起卡片
  if (msg.t === "approval") {
    if (msg.pending) approvalShow(msg.pending);
    else approvalHide();
  }
  // 用户点了卡片上的 ✕：只收起，不回应申请
  if (msg.t === "approval-dismiss") approvalDismiss();
  if (msg.t === "pet-btn-hot") petBtnHot(msg.which, msg.hot);
  if (msg.t === "pet-btn-press") petBtnPress(msg.which, msg.on);
}

function undoExpression() {
  const previous = state.expressionHistory.pop();
  if (!previous) {
    toast("没有可撤销的表情");
    return;
  }
  state.expression = null;
  setExpression(previous, false);
  toast("已撤销表情：" + previous);
}

function clearCard() {
  if (state.payload) {
    state.payload = {
      ...state.payload,
      title: "",
      elapsed: 0,
      tools: null,
      tokens: "",
      source: "",
      activity: "任务信息已清空",
      say: "",
    };
  }
  ui.cardTitle.textContent = "当前没有进行中的任务";
  ui.cardElapsed.textContent = "—";
  ui.cardTools.textContent = "—";
  ui.cardTokens.textContent = "—";
  ui.cardSource.textContent = "—";
  ui.cardActivityText.textContent = "任务信息已清空";
  ui.cardUsage.textContent = "";
  ui.cardSay.textContent = "";
  toast("进度卡片已清空");
}

function muteAnimations(seconds) {
  if (!state.settings) return;
  if (!state.muteBackup) {
    state.muteBackup = {
      autoExpression: state.settings.autoExpression !== false,
      autoMotion: state.settings.autoMotion !== false,
    };
  }
  clearTimeout(state.muteTimer);
  state.settings.autoExpression = false;
  state.settings.autoMotion = false;
  refreshPlaybackPolicy();
  state.muteTimer = setTimeout(() => {
    if (state.muteBackup && state.settings) {
      state.settings.autoExpression = state.muteBackup.autoExpression;
      state.settings.autoMotion = state.muteBackup.autoMotion;
    }
    state.muteBackup = null;
    refreshPlaybackPolicy();
    toast("动画静音已结束");
  }, seconds * 1000);
}

setInterval(() => bridge.send({ t: "status", data: window.__pet.getStatus() }), 5000);

window.__pet = {
  applyState,
  onCursor,
  moodTick,
  reaction,
  cycleExpression,
  setCardOpen,
  applySettings,
  setTempExpression,
  state: () => state,
  gaze: () => {
    const fc = model && model.internalModel && model.internalModel.focusController;
    return fc ? { x: fc.x, y: fc.y } : null;
  },
  gazeTarget: () => state.lastGaze || null,
  gazeState: () => ({ ...state.gaze }),
  expressions: () => expressionNames(),
  expressionCursor: () => expressionCursor,
  model: () => model,
  app: () => app,
  getStatus: () => ({
    state: state.key,
    label: STATE_STYLE[state.key] ? STATE_STYLE[state.key].label : state.key,
    expression: state.expression,
    tempExpr: state.tempExpr || null,
    tempLeftMs: state.tempUntil ? Math.max(0, Math.round(state.tempUntil - Date.now())) : 0,
    burstLeftMs: state.heartBurstUntil ? Math.max(0, Math.round(state.heartBurstUntil - performance.now())) : 0,
    burstTail: state.heartBurstTail || 0,
    params: (() => {
      try {
        const c = model && model.internalModel && model.internalModel.coreModel;
        if (!c) return null;
        const read = (id) => {
          try { return Math.round(c.getParameterValueById(id) * 1000) / 1000; } catch (e) { return null; }
        };
        return { love: read("love"), cheek73: read("ParamCheek73") };
      } catch (e) { return null; }
    })(),
    lastMotion: state.lastMotion || null,
    autoMotion: !state.settings || state.settings.autoMotion !== false,
    autoExpression: !state.settings || state.settings.autoExpression !== false,
    playbackGuardInstalled: Boolean(state.playbackGuardInstalled),
    queuedMotions: model && model.internalModel && model.internalModel.motionManager && Array.isArray(model.internalModel.motionManager._motions)
      ? model.internalModel.motionManager._motions.length
      : null,
    rect: characterRect(),
    modelLoaded: !!model,
    modelSize: model ? [model.width, model.height] : null,
    expressions: expressionNames(),
    chip: ui.chipText.textContent,
  }),
  setExpression,
  playMotion,
};

window.__petReceive = window.__petReceive || null;

boot().catch((err) => {
  console.error("pet boot failed", err);
  bridge.send({ t: "error", message: "boot failed: " + String(err && err.stack ? err.stack : err) });
  document.body.innerHTML = `<div style="color:#fff;font:14px sans-serif;padding:12px">桌宠加载失败：${err}</div>`;
});
