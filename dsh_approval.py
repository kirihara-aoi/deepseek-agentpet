"""DSH 权限申请：监听待批准请求 + 回传决定（纯标准库，无第三方依赖）。

## 链路（从 dsh 源码逆向 + 实测确认）

* **下行**：WebSocket `ws://127.0.0.1:<port>/api/remote.mux`，开一条逻辑流
  `endpoint = "$events"`。服务端把待批准申请以这样的帧推下来：

      {"type":"item","streamId":"s1","value":{
         "type":"waterfall","event":"approval/request",
         "eventId":"<事件 id>","agentId":"<会话 id>",
         "request":{"toolName":"edit","callId":"...","reason":"...",
                    "displayReason":{"zh":"...","en":"..."}}}}

  **连上就会补发所有积压的申请**，所以"当前有没有待批准"不需要轮询。
  有人先答了 / 被取消时，会收到 `{"type":"cancel","eventId":...}`。

* **上行**：`POST /api/$events/result`，信封里 `method` 必须是 `"$events/result"`：

      {"type":"client-request","rpcId":"<uuid>","method":"$events/result",
       "payload":{"args":{"clientId":"...","eventId":"...",
                          "outcome":{"kind":"result","value":"allowed-once"}}}}

  `value` 只有 `allowed-once` 是批准，`rejected` 是拒绝。

* **鉴权**：`/api` 需要浏览器会话 cookie。不依赖 `dsh web` 打印的 token，
  直接用 `~/.dsh/.credentials.yaml` 里的密钥自签：

      name  = "dsh-auth-" + base64url(sha256(authority))
      body  = base64url(JSON{"version":1,"authority","issuedAt","expiresAt"})  # 毫秒
      value = "v1." + body + "." + base64url(HMAC-SHA256(secret, body))

## 设计取舍（都是为了不卡）

* 完全**事件驱动**，没有轮询定时器；
* 只有"待批准集合真的变了"才通知界面（去重键 = eventId），避免无谓重排；
* 断线用指数退避重连（2s 起，封顶 30s），重连期间不碰界面；
* 所有网络操作都在后台线程，绝不占用界面线程（鼠标钩子回调在界面线程上）。
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import random
import socket
import struct
import threading
import time
import uuid

DEFAULT_PORT = 3080
WS_PATH = "/api/remote.mux"
RESULT_PATH = "/api/$events/result"
EVENTS_ENDPOINT = "$events"
STREAM_ID = "s1"

# 浏览器会话 cookie 的有效期（服务端有 maxAge 校验，取 7 天足够安全）
COOKIE_TTL_MS = 7 * 24 * 3600 * 1000


# --------------------------------------------------------------- cookie 签名


def _b64u(raw: bytes) -> str:
    """base64url（无填充），与 dsh 的 encodeBase64Url 一致。"""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64u_decode(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text.replace("-", "+").replace("_", "/") + pad)


def _parse_yaml_scalar_block(path: str, wants) -> str:
    """从 credentials.yaml 里取某个嵌套键的标量值。

    只实现"按缩进分层"的极简 YAML 子集 —— 这个文件就是固定的三层结构：
        records:
          client-connection/browser-session:
            payload:
              secret: xxx
    `wants` 是键名路径，例如 ("client-connection/browser-session", "payload", "secret")。
    不引入 PyYAML：桌宠的依赖越少越稳。
    """
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return ""

    stack = []            # [(indent, key)]
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        text = raw.strip()
        if ":" not in text:
            continue
        key, _, value = text.partition(":")
        key = key.strip().strip("'\"")
        value = value.strip().strip("'\"")
        # 弹掉比当前层更深的键
        while stack and stack[-1][0] >= indent:
            stack.pop()
        stack.append((indent, key))
        path_now = [k for _, k in stack]
        if tuple(path_now) == tuple(wants) and value:
            return value
    return ""


def load_cookie_secret(path: str = "") -> bytes:
    """读取 dsh 的浏览器会话签名密钥（base64url，32 字节）。"""
    if not path:
        home = os.path.expanduser("~")
        path = os.path.join(home, ".dsh", ".credentials.yaml")
    text = _parse_yaml_scalar_block(
        path, ("records", "client-connection/browser-session", "payload", "secret")
    )
    if not text:
        return b""
    try:
        secret = _b64u_decode(text)
    except Exception:  # noqa: BLE001
        return b""
    return secret if len(secret) == 32 else b""


def make_cookie(authority: str, secret: bytes) -> str:
    """按 dsh 的格式自签一个浏览器会话 cookie（返回 "name=value"）。"""
    name = "dsh-auth-" + _b64u(hashlib.sha256(authority.encode("utf-8")).digest())
    now_ms = int(time.time() * 1000)
    payload = {
        "version": 1,
        "authority": authority,
        "issuedAt": now_ms,
        "expiresAt": now_ms + COOKIE_TTL_MS,
    }
    body = _b64u(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64u(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    return "%s=v1.%s.%s" % (name, body, sig)


# ------------------------------------------------------------- 极简 WebSocket


class _WebSocket:
    """RFC6455 客户端的最小实现（只要文本帧 + ping/pong/close）。

    为什么自己写：这台机器的 Python 没装 websockets/websocket-client，
    而目标只是"收几帧 JSON + 偶尔发一帧"，协议代码很少，不必引依赖。
    """

    def __init__(self, host: str, port: int, path: str, cookie: str, timeout: float = 15.0):
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._buf = b""
        self._closed = False
        self._handshake(host, port, path, cookie)
        self._sock.settimeout(None)      # 之后用阻塞读（配合 shutdown 打断）

    def _handshake(self, host: str, port: int, path: str, cookie: str) -> None:
        # 注意：Sec-WebSocket-Key 必须是**标准 base64（带填充、24 字符）**。
        # 用 base64url 无填充（22 字符）会被 ws 库判为非法握手，直接返回 400。
        key = base64.b64encode(bytes(random.getrandbits(8) for _ in range(16))).decode("ascii")
        lines = [
            "GET %s HTTP/1.1" % path,
            "Host: %s:%d" % (host, port),
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: %s" % key,
            "Sec-WebSocket-Version: 13",
        ]
        if cookie:
            lines.append("Cookie: %s" % cookie)
        self._sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))

        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = self._sock.recv(4096)
            if not chunk:
                break
            raw += chunk
        head, _, rest = raw.partition(b"\r\n\r\n")
        self._buf = rest
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1", "replace")
        if " 101 " not in status_line + " ":
            raise OSError("WebSocket 握手失败：%s" % status_line)

    # ---- 发送 ----

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        first = 0x80 | opcode            # FIN + opcode
        mask = bytes(random.getrandbits(8) for _ in range(4))
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", first, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", first, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", first, 0x80 | 127, length)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(header + mask + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(0x8, b"")
        except Exception:  # noqa: BLE001
            pass
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except Exception:  # noqa: BLE001
            pass
        try:
            self._sock.close()
        except Exception:  # noqa: BLE001
            pass

    # ---- 接收 ----

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self._sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise OSError("连接已关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def recv_message(self) -> str:
        """读一条完整的文本消息（自动处理 ping/pong、分片、close）。"""
        parts = []
        while True:
            b1, b2 = self._read(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if masked else b""
            payload = self._read(length) if length else b""
            if masked:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))

            if opcode == 0x8:                      # close
                raise OSError("服务端关闭连接")
            if opcode == 0x9:                      # ping → 必须回 pong
                try:
                    self._send_frame(0xA, payload)
                except Exception:  # noqa: BLE001
                    pass
                continue
            if opcode == 0xA:                      # pong
                continue
            parts.append(payload)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")


# ------------------------------------------------------------------- 监听器


class ApprovalWatcher:
    """后台线程：订阅 DSH 的 approval 事件，并能够回传决定。

    对外只暴露两个动作：
      · `start()`            —— 起后台线程（幂等）
      · `answer(decision)`   —— 回答当前申请："allowed-once" / "rejected"
    以及一个回调 `on_pending(payload)`，`payload` 为 None 表示没有待批准的了。
    """

    def __init__(self, port: int, on_pending, log=None):
        self.port = int(port or DEFAULT_PORT)
        self.on_pending = on_pending
        self.log = log or (lambda _msg: None)

        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._ws = None
        self._client_id = ""
        self._current = None        # 当前待批准
        self._last_key = "\x00"     # 去重键：只有变化才通知界面

    # ---- 生命周期 ----

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="dsh-approval", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        ws = self._ws
        if ws is not None:
            ws.close()

    def has_pending(self) -> bool:
        with self._lock:
            return self._current is not None

    # ---- 对外：回答当前申请 ----

    def answer_async(self, decision: str) -> bool:
        """异步回答（**界面线程必须用这个**）。

        为什么：`answer()` 里是同步 HTTP 请求（最长 8 秒超时）。而"点了卡片按钮"
        这件事是由宿主的鼠标钩子发现、在**界面线程**上处理的 —— 界面线程一卡，
        Windows 就会阻塞鼠标输入（正是之前排查很久的"鼠标停滞"）。所以这里
        必须扔到后台线程去做，界面线程只负责"发起"。
        """
        if decision not in ("allowed-once", "rejected"):
            return False
        threading.Thread(
            target=self.answer, args=(decision,), name="approval-answer", daemon=True
        ).start()
        return True

    def answer(self, decision: str) -> bool:
        """decision: "allowed-once"（批准）或 "rejected"（拒绝）。"""
        if decision not in ("allowed-once", "rejected"):
            return False
        with self._lock:
            current = self._current
            client_id = self._client_id
        # self._current 是我们自己构造的 payload，键名是 id（不是 eventId）。
        # 这里原先写成 current.get("eventId")，永远取不到值 ——
        # 于是点击「允许/拒绝」一律被当成"没有待批准申请"直接忽略。
        if not current or not current.get("id") or not client_id:
            self.log("权限应答被忽略：当前没有待批准的申请")
            return False
        event_id = current["id"]

        body = json.dumps({
            "type": "client-request",
            "rpcId": str(uuid.uuid4()),
            "method": "$events/result",
            "payload": {"args": {
                "clientId": client_id,
                "eventId": event_id,
                "outcome": {"kind": "result", "value": decision},
            }},
        }, ensure_ascii=False).encode("utf-8")

        secret = load_cookie_secret()
        authority = "127.0.0.1:%d" % self.port
        headers = {"Content-Type": "application/json"}
        if secret:
            headers["Cookie"] = make_cookie(authority, secret)

        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=8.0)
            conn.request("POST", RESULT_PATH, body=body, headers=headers)
            resp = conn.getresponse()
            text = resp.read().decode("utf-8", "replace")
            conn.close()
            ok = '"ok":true' in text.replace(" ", "")
            self.log("权限决定已回传：%s → %s（%s）"
                     % ("批准" if decision == "allowed-once" else "拒绝",
                        "成功" if ok else "失败", text[:160]))
        except Exception as exc:  # noqa: BLE001
            self.log("回传权限决定失败：%r" % (exc,))
            return False

        # 乐观收卡片；服务端随后还会用 cancel 帧确认一次
        with self._lock:
            self._current = None
        self._notify(None, force=True)
        return ok

    # ---- 内部：通知界面（带去重）----

    def _notify(self, payload, force: bool = False) -> None:
        # 注意：payload 里标识申请用的字段名是 **"id"**（见 _handle 构造的字典）。
        # 这里曾经写成 .get("eventId")，永远是空串 —— 第一次推送后 _last_key 变成 ""，
        # 其后的申请全被判成"没变化"静默丢弃，表现是"卡片只在最早那次弹过"。
        key = (payload or {}).get("id") or ""
        if not force and key == self._last_key:
            return                     # 内容没变：不碰界面，省一次重排
        self._last_key = key
        self.log("推送权限卡片到桌宠：%s" % (key if key else "收起卡片"))
        try:
            self.on_pending(payload)
        except Exception as exc:  # noqa: BLE001
            self.log("推送权限申请失败：%r" % (exc,))

    # ---- 内部：主循环（断线退避重连）----

    def _run(self) -> None:
        backoff = 2.0
        while not self._stop.is_set():
            ws = None
            try:
                secret = load_cookie_secret()
                if not secret:
                    self.log("没有找到 dsh 的会话密钥（~/.dsh/.credentials.yaml），"
                             "权限卡片功能不可用")
                    return
                authority = "127.0.0.1:%d" % self.port
                cookie = make_cookie(authority, secret)
                ws = _WebSocket("127.0.0.1", self.port, WS_PATH, cookie)
                self._ws = ws
                ws.send_text(json.dumps({
                    "type": "open",
                    "streamId": STREAM_ID,
                    "endpoint": EVENTS_ENDPOINT,
                    "payload": {"args": {}},
                }))
                self.log("已订阅 DSH 权限事件（端口 %d），断线会自动重连" % self.port)
                backoff = 2.0

                while not self._stop.is_set():
                    message = ws.recv_message()
                    if message:
                        self._handle(message)
            except Exception as exc:  # noqa: BLE001
                if self._stop.is_set():
                    break
                self.log("权限事件订阅断开：%r（%.0f 秒后重连）" % (exc, backoff))
                with self._lock:
                    self._client_id = ""
                    self._current = None
                self._notify(None, force=True)   # 断开时收卡片，别对着过期申请点
                if ws is not None:
                    ws.close()
                self._stop.wait(backoff)
                backoff = min(30.0, backoff * 2)
            finally:
                self._ws = None

    def _handle(self, message: str) -> None:
        try:
            msg = json.loads(message)
        except ValueError:
            return
        value = msg.get("value")
        if not isinstance(value, dict):
            return
        kind = value.get("type")

        if kind == "ready":
            with self._lock:
                self._client_id = str(value.get("clientId") or "")
            return

        if kind == "cancel":
            # 这次申请已经被别人（浏览器界面）答掉了，或者被取消
            event_id = str(value.get("eventId") or "")
            with self._lock:
                current = self._current
                if current and current.get("id") == event_id:
                    self._current = None
                    self._notify(None, force=True)
            return

        if kind != "waterfall":
            return
        if value.get("event") != "approval/request":
            # 同一通道还有 user-questions/request 等，这里只关心权限
            return

        request = value.get("request") or {}
        event_id = str(value.get("eventId") or "")
        if not event_id:
            return
        display = request.get("displayReason")
        if isinstance(display, dict):
            friendly = str(display.get("zh") or display.get("en") or "")
        else:
            friendly = str(display or "")
        raw_reason = str(request.get("reason") or "")
        tool = str(request.get("toolName") or "")
        payload = {
            "id": event_id,
            "tool": tool,
            "title": "需要授权",
            # 界面上优先显示人话（displayReason），没有就退回原始 reason
            "reason": friendly or raw_reason,
            "detail": raw_reason if (friendly and raw_reason and raw_reason != friendly) else "",
        }
        with self._lock:
            self._current = payload
        self.log("收到权限申请：%s（%s）" % (tool or "未知工具", (friendly or raw_reason)[:80]))
        self._notify(payload)
