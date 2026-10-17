"""chat.deepseek.com 桥接（桌宠用）。

负责拉起并驱动 chat-bridge/daemon.mjs：那个 Node 守护进程用 CDP 控制一个
**专用 Edge 实例**，把文字送进 chat.deepseek.com 的输入框、点发送、并把流式
回复抓回来。

为什么要单独起一个 Edge：跨进程没法给用户已有 Edge 里的页面注入 JS，只能自
己起一个带 --remote-debugging-port 的实例（独立 user-data-dir，首次要登录）。

对上层暴露的最小接口：
    bridge = ChatBridge(on_event=回调)
    bridge.start()                 # 起 daemon（后台线程读它的 stdout）
    bridge.send("你好")            # 发一条
    bridge.stop_reply()            # 打断当前生成
    bridge.status()                # 探活
    bridge.shutdown()              # 收摊
回调收到的消息就是 daemon 的 JSON：{"type":"delta"|"done"|"state"|"ready"|"error", ...}
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.join(HERE, "chat-bridge")
DAEMON = os.path.join(BRIDGE_DIR, "daemon.mjs")


def find_node() -> str:
    """找 node.exe：先看 PATH，再看常见安装位置。"""
    import shutil

    for name in ("node.exe", "node"):
        found = shutil.which(name)
        if found:
            return found
    for path in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ):
        if os.path.isfile(path):
            return path
    return ""


class ChatBridge:
    """驱动 chat-bridge/daemon.mjs 的小客户端。"""

    def __init__(self, on_event=None, on_log=None, cdp_port: int = 9333) -> None:
        self.on_event = on_event
        self.on_log = on_log
        self.cdp_port = int(cdp_port)
        self.proc = None
        self._reader = None
        self._stderr_reader = None
        self._lock = threading.Lock()
        self._next_id = 0
        self._pending = {}
        self._cmd_lock = threading.Lock()
        self._start_lock = threading.Lock()   # 防止并发起两个 daemon 抢同一个端口
        self.ready_info = None
        self.ready_event = threading.Event()
        self.streaming = False
        self.last_error = ""

    # -- 生命周期 -----------------------------------------------------------

    def log(self, message: str) -> None:
        if self.on_log is not None:
            try:
                self.on_log(message)
            except Exception:  # noqa: BLE001
                pass

    def start(self) -> bool:
        """起 daemon。已经起着就直接返回 True。

        必须加锁：原来的"检查 proc 是否活着 → Popen"之间没有保护，
        两个线程同时调用就会**各起一个 daemon**，它们抢同一个调试端口
        (9333) 互相踩踏，表现就是连接被重置、按钮按了没反应（实测踩过：
        bridge.log 里每次启动都有两条"启动 Edge"）。
        """
        with self._start_lock:
            return self._start_locked()

    def _start_locked(self) -> bool:
        if self.proc is not None and self.proc.poll() is None:
            return True
        if not os.path.isfile(DAEMON):
            self.last_error = "找不到 %s" % DAEMON
            self.log("chat 桥接启动失败：%s" % self.last_error)
            return False
        node = find_node()
        if not node:
            self.last_error = "找不到 node.exe"
            self.log("chat 桥接启动失败：%s" % self.last_error)
            return False

        env = dict(os.environ)
        env["CHAT_CDP_PORT"] = str(self.cdp_port)
        try:
            self.proc = subprocess.Popen(
                [node, DAEMON],
                cwd=BRIDGE_DIR,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as exc:  # noqa: BLE001
            self.last_error = repr(exc)
            self.log("chat 桥接启动异常：%r" % (exc,))
            self.proc = None
            return False

        self.ready_event.clear()
        self.ready_info = None
        self._reader = threading.Thread(target=self._read_stdout, name="chat-bridge-out", daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, name="chat-bridge-err", daemon=True)
        self._stderr_reader.start()
        self.log("chat 桥接已启动（node %s）" % os.path.basename(node))
        return True

    def shutdown(self) -> None:
        """让 daemon 退出（专用 Edge 留着，由用户决定关不关）。"""
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.poll() is None:
                self._write({"id": self._new_id(), "cmd": "quit"})
                deadline = time.time() + 2.0
                while proc.poll() is None and time.time() < deadline:
                    time.sleep(0.05)
        except Exception:  # noqa: BLE001
            pass
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:  # noqa: BLE001
            pass
        self.proc = None

    # -- 收发 ---------------------------------------------------------------

    def _read_stdout(self) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:  # noqa: BLE001
                self.log("chat 桥接输出非 JSON：%s" % line[:120])
                continue
            self._dispatch(msg)

    def _read_stderr(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            line = line.rstrip()
            if line:
                self.log("chat 桥接 stderr: %s" % line[:200])

    def _dispatch(self, msg) -> None:
        if not isinstance(msg, dict):
            return
        kind = msg.get("type")
        if kind == "ack":
            with self._lock:
                self._pending[msg.get("id")] = msg
        elif kind == "ready":
            self.ready_info = msg
            self.ready_event.set()
        elif kind == "state":
            self.streaming = bool(msg.get("streaming"))
        elif kind == "error":
            self.last_error = str(msg.get("message") or "")
        if self.on_event is not None:
            try:
                self.on_event(msg)
            except Exception as exc:  # noqa: BLE001
                self.log("chat 事件回调出错：%r" % (exc,))

    def _new_id(self) -> int:
        with self._lock:
            self._next_id += 1
            return self._next_id

    def _write(self, obj) -> bool:
        proc = self.proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return False
        try:
            with self._cmd_lock:
                proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
                proc.stdin.flush()
            return True
        except Exception as exc:  # noqa: BLE001
            self.log("chat 桥接写入失败：%r" % (exc,))
            return False

    def _restart(self) -> bool:
        """把旧 daemon 干掉并重新起一个（用于处理"进程还在但 stdin 已断"的僵尸态）。

        为什么需要：`poll()` 是 None 只说明进程没退出，不代表管道还能用。
        实测存在这种僵尸：进程活着、stdout 已 EOF、写 stdin 直接失败 ——
        此时 `_write` 返回 False，上层看到的就是"命令发了但没反应"。
        """
        with self._start_lock:
            try:
                if self.proc is not None:
                    try:
                        self.proc.kill()
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        self.proc.wait(timeout=3)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
            self.proc = None
            self._pending.clear()
            return self._start_locked()

    def command(self, cmd: str, timeout: float = 10.0, **fields):
        """发一条命令并等它的 ack（超时返回 None；写入失败会自动重启 daemon 重试一次）。"""
        if not self.start():
            return None
        mid = self._new_id()
        payload = {"id": mid, "cmd": cmd}
        payload.update(fields)
        if not self._write(payload):
            # 僵尸 daemon：进程还在但写不进去。重启一个再来一次。
            self.log("chat 桥接写入失败（daemon 可能已成僵尸），重启后重试：%s" % cmd)
            if not self._restart():
                return None
            mid = self._new_id()
            payload = {"id": mid, "cmd": cmd}
            payload.update(fields)
            if not self._write(payload):
                self.log("chat 桥接重启后仍然写不进去：%s" % cmd)
                return None
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                got = self._pending.pop(mid, None)
            if got is not None:
                return got
            time.sleep(0.03)
        return None

    def wait_ready(self, timeout: float = 45.0):
        """等 daemon 报 ready（它会顺带把 Edge 和页面拉起来）。"""
        if self.ready_event.wait(timeout):
            return self.ready_info
        return None

    def status(self, timeout: float = 20.0):
        ack = self.command("status", timeout=timeout)
        if ack and ack.get("ok"):
            return ack.get("status")
        return None

    def send(self, text: str, timeout: float = 15.0) -> bool:
        ack = self.command("send", timeout=timeout, text=text)
        return bool(ack and ack.get("ok"))

    def stop_reply(self, timeout: float = 10.0) -> bool:
        ack = self.command("stop", timeout=timeout)
        return bool(ack and ack.get("ok"))

    def focus(self, timeout: float = 10.0) -> bool:
        ack = self.command("focus", timeout=timeout)
        return bool(ack and ack.get("ok"))

    def open_chat(self, timeout: float = 180.0) -> bool:
        """确保聊天页开着（没有就导航过去），并顺手处理浏览器窗口。

        **超时必须大于 daemon 内部的最坏耗时**，否则会出现"浏览器其实开起来了、
        但命令先超时返回 False"的假失败 —— 这正是此前"第一次大概率失败"的原因：
        daemon 侧最坏要 等输入框10s + 窗口重试10s + waitForLoad最长30s ≈ 70 秒，
        而这里原来只给 60 秒。现在给 180 秒（调用方另有 150 秒的进度等待兜底）。
        """
        ack = self.command("open-chat", timeout=timeout)
        if ack is None:
            self.log("open-chat 没有收到应答（超时或 daemon 无响应）")
            return False
        if not ack.get("ok"):
            # 把 daemon 报的错误原样记下来，不然只能看到"失败"两个字，无法排查
            self.log("open-chat 失败：%s" % (ack.get("error") or "(未提供原因)"))
            return False
        return True

    def minimize_page(self, timeout: float = 20.0) -> bool:
        """把聊天页那个 Edge 窗口最小化。"""
        ack = self.command("minimize", timeout=timeout)
        return bool(ack and ack.get("ok"))

    def move_aside(self, timeout: float = 20.0) -> bool:
        """把聊天页那个 Edge 窗口挪到屏幕最旁边（右下角露出一块）。

        **不靠标题猜、也不交给 PowerShell**：直接枚举窗口，要求
        "标题像聊天页 **且** 进程是浏览器"，再挪走。
        为什么要这么严：聊天输入框的窗口标题是"和 DeepSeek 说话"，标题里也带
        deepseek —— 只按标题匹配会挪错窗口，表现就是"挪到旁边的效果没了"
        （实测踩过，输入框被挪了、真正的 Edge 一动不动）。

        还没登录时用它：完全最小化用户点不到、没法登录，
        所以先挪到旁边，等登录成功再由收尾任务自动最小化。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt

            user32 = ctypes.windll.user32
            k32 = ctypes.windll.kernel32
            sw = int(user32.GetSystemMetrics(0))
            sh = int(user32.GetSystemMetrics(1))
            # 右下角露出一块：能看见、也能点进去登录
            x = max(0, sw - 420)
            y = max(0, sh - 320)
            browsers = ("msedge", "chrome", "firefox", "brave", "vivaldi", "opera")
            moved = []

            def image_of(hwnd):
                pid = wt.DWORD()
                user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(pid))
                handle = k32.OpenProcess(0x1000, False, pid.value)   # QUERY_LIMITED
                if not handle:
                    return ""
                try:
                    buf = ctypes.create_unicode_buffer(1024)
                    size = wt.DWORD(1024)
                    if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                        return buf.value.lower()
                finally:
                    k32.CloseHandle(handle)
                return ""

            @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
            def visit(hwnd, _):
                n = user32.GetWindowTextLengthW(hwnd)
                if n <= 0 or not user32.IsWindowVisible(hwnd):
                    return True
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                title_l = buf.value.lower()
                if "deepseek" not in title_l or "deepseek harness" in title_l:
                    return True
                base = image_of(hwnd)
                if not any(b in base for b in browsers):
                    return True                  # 不是浏览器窗口（例如输入框）：跳过
                # 先恢复出来：最小化状态下 SetWindowPos 只改"还原位置"，窗口看起来还最小化
                user32.ShowWindow(wt.HWND(hwnd), 4)          # SW_SHOWNOACTIVATE
                user32.SetWindowPos(wt.HWND(hwnd), None, int(x), int(y), 900, 700, 0x0010)  # NOACTIVATE
                moved.append(buf.value[:40])
                return True

            user32.EnumWindows(visit, 0)
            if moved:
                self.log("把聊天窗口挪到屏幕最旁边：成功（%s → %d,%d）" % (moved[0], x, y))
                return True
            self.log("把聊天窗口挪到屏幕最旁边：没找到 Edge 窗口")
            return False
        except Exception as exc:  # noqa: BLE001
            self.log("挪窗口失败：%r" % (exc,))
            return False

