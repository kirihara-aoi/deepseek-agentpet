"""聊天输入窗口（点「说话」按钮弹出来的那个小输入框）。

为什么要单独开一个窗口：桌宠的透明分层窗口对鼠标几乎全穿透，网页里收不到点击、
也拿不到键盘焦点。设置窗口就是这么解决的（自己的 STA 线程 + 一个辅助窗口），
这里照同一套路做，输入体验才正常（能选中、能按 Enter 发送）。

样式参考 dsh-whale-girl-live2d 的 composer 面板：深色卡片 + 细边 + 毛玻璃质感，
输入框占满宽度，底部一行「发送 / 打断」。

**线程模型（重要，改之前先读完）**
这个窗口活在自己的 STA 线程上（`_run` 里 Application.Run）。桌宠的界面线程
（鼠标钩子也在上面）**绝不允许**：
  · 直接读写本窗口的任何 WinForms 属性（跨线程 SendMessage 会互相等 → 卡死）；
  · 等待窗口创建完成（一等就是几百毫秒，界面线程一停，全局鼠标就发涩）。
所以对外只暴露"投递"接口：所有动作都走 `_post()`，由它 BeginInvoke 到窗口线程；
窗口还没建好时先排进 `_pending`，`_run` 里 Show 完立刻补跑 —— 这样"把输入框
摆到模型左边"这一步一定发生在句柄有效之后，不会再出现 BeginInvoke 抛异常、
输入框留在屏幕中间的毛病。
"""

from __future__ import annotations

import ctypes
import threading
import time


class ChatInputWindow:
    """一个无边框小面板：多行输入 + 发送 / 打断。"""

    def __init__(self, on_send=None, on_interrupt=None, dpi_scale: float = 1.0,
                 on_close=None, host_invoke=None, on_log=None) -> None:
        self.on_send = on_send
        self.on_interrupt = on_interrupt
        self.on_close = on_close              # 「✕」被点击时回调（在宿主界面线程里执行）
        self.host_invoke = host_invoke        # 把可调用对象转回宿主界面线程的工具
        self.on_log = on_log                  # 诊断日志（宿主传 log 进来）
        self.dpi_scale = float(dpi_scale or 1.0)
        self.form = None
        self.textbox = None
        self.status = None
        self.send_btn = None
        self.stop_btn = None
        self.close_btn = None
        self._pet_offset = None               # 输入框相对桌宠窗口的偏移（拖动跟随时用）
        self._thread = None
        self._ready = threading.Event()       # 仅用于诊断/收尾，不再有人阻塞等它
        self._lock = threading.Lock()
        self._pending: list = []              # 窗口还没建好时排队的动作
        self._failed = ""                     # 上次 build() 的失败原因
        self._visible = False                 # 缓存：表单当前是否可见（跨线程只读这个）
        self._want_visible = False            # 期望的可见状态（只由 toggle 翻转）
        self._text_cache = ""                 # 缓存输入框文字：跨线程读 .Text 会 SendMessage
        self._follow_at = 0.0                 # 拖动跟随节流
        self._reassert_at = 0.0               # 置顶复查节流
        self._placed = False
        self._drain_timer = None              # 窗口线程内的兜底补跑（句柄就绪前的排队动作）
        self._spawned_at = 0.0                # 线程启动时刻：兜底定时器最多跑 10 秒

    # -- 诊断 ---------------------------------------------------------------

    def _log(self, message: str) -> None:
        fn = self.on_log
        if fn is None:
            return
        try:
            fn("[chat-ui] %s" % message)
        except Exception:  # noqa: BLE001
            pass

    # -- 跨线程投递 ---------------------------------------------------------

    def _queue(self, fn) -> None:
        with self._lock:
            if len(self._pending) < 64:
                self._pending.append(fn)

    def _post(self, fn) -> None:
        """把动作投到窗口自己的线程上执行（绝不阻塞调用方）。"""
        form = self.form
        if form is None or getattr(form, "IsDisposed", True):
            self._queue(fn)
            self._spawn_async()
            return
        try:
            from System import Action

            if not form.IsHandleCreated:
                self._queue(fn)          # Show() 还没跑完：等 _run 补跑
                return
            form.BeginInvoke(Action(fn))
        except Exception:  # noqa: BLE001
            self._queue(fn)

    def _is_alive(self) -> bool:
        """窗口线程还活着吗。"""
        return self._thread is not None and self._thread.is_alive()

    def _post_if_ready(self, fn) -> None:
        """只在窗口**已经建好**时投递。

        状态栏文字、按钮可用性属于"锦上添花"的更新，不能顺手把窗口建出来：
        DS 按钮那条路径（ensure_chat_page_async）也会写状态栏，否则按一下 DS，
        桌宠就在后台凭空造出一个看不见的输入窗口，还让它的消息循环空转。
        """
        form = self.form
        if form is None or getattr(form, "IsDisposed", True):
            return
        self._post(fn)

    def _drain_pending(self) -> None:
        with self._lock:
            items, self._pending = self._pending, []
        for fn in items:
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                self._log("补跑动作失败：%r" % (exc,))

    def _drain_tick(self, sender=None, args=None) -> None:
        """兜底：_post 在"句柄还没建好"时只能排队，而 _run 可能已经补跑过了 ——
        那样这条动作会一直躺在队列里。这里在窗口线程上隔 60ms 扫一次，
        等句柄真的建好（Show 之后 BeginInvoke 才有效）就停掉定时器。"""
        self._drain_pending()
        form = self.form
        ready = form is not None and getattr(form, "IsHandleCreated", False)
        # 句柄建好了就收工；窗口一直没显示的话最多空转 10 秒也收工（别常驻一个 60ms 定时器）
        if ready or (self._spawned_at and time.time() - self._spawned_at > 10.0):
            try:
                timer = self._drain_timer
                if timer is not None:
                    timer.Stop()
            except Exception:  # noqa: BLE001
                pass

    def _notify(self, fn) -> None:
        """窗口线程 → 宿主界面线程（发送/打断/关闭这些要动桌宠状态的事）。"""
        if fn is None:
            return
        host_ui = self.host_invoke
        if host_ui is not None:
            try:
                host_ui(fn)
                return
            except Exception:  # noqa: BLE001
                pass
        try:
            fn()
        except Exception:  # noqa: BLE001
            pass

    # -- 构建 ---------------------------------------------------------------

    def _px(self, v: float) -> int:
        return int(round(v * self.dpi_scale))

    def build(self):
        from System.Drawing import Color, ContentAlignment, Font, Size
        from System.Drawing.Drawing2D import GraphicsPath
        from System.Drawing import Rectangle as Rect
        from System.Windows.Forms import (
            BorderStyle,
            Button,
            FlatStyle,
            Form,
            FormBorderStyle,
            FormStartPosition,
            Label,
            TextBox,
        )

        # 高度加一点：顶部单独留一条标题栏放「✕」，这样它不会压到文本框的滚动条上
        pad, width, height = 12.0, 380.0, 190.0
        form = Form()
        form.Text = "和 DeepSeek 说话"
        form.FormBorderStyle = getattr(FormBorderStyle, "None")
        # Manual：位置由 _place_ui 在 Show 之前算好，先 Manual 才不会先闪一下居中位置
        form.StartPosition = FormStartPosition.Manual
        form.ShowInTaskbar = True
        form.TopMost = True
        form.BackColor = Color.FromArgb(20, 24, 34)
        form.ClientSize = Size(self._px(width), self._px(height))

        try:  # 圆角和设置窗口一个手感
            radius = self._px(10)
            path = GraphicsPath()
            box = Rect(0, 0, self._px(width) - 1, self._px(height) - 1)
            path.AddArc(box.X, box.Y, radius, radius, 180, 90)
            path.AddArc(box.Right - radius, box.Y, radius, radius, 270, 90)
            path.AddArc(box.Right - radius, box.Bottom - radius, radius, radius, 0, 90)
            path.AddArc(box.X, box.Bottom - radius, radius, radius, 90, 90)
            path.CloseFigure()
            form.Region = __import__("System.Drawing", fromlist=["Region"]).Region(path)
        except Exception:  # noqa: BLE001
            pass

        font = Font("Microsoft YaHei UI", 9.5)
        font_small = Font("Microsoft YaHei UI", 8.5)

        # 标题栏：左侧文字 + 右侧「✕」。
        # 为什么要单独一条：之前「✕」直接叠在文本框右上角，而多行 TextBox 自带的
        # 垂直滚动条正好也占右边那条缝 —— 于是关闭键被滚动条盖住、点不到（用户反馈）。
        title = Label()
        title.Text = "和 DeepSeek 说话"
        title.ForeColor = Color.FromArgb(150, 162, 186)
        title.Font = font_small
        title.TextAlign = ContentAlignment.MiddleLeft
        title.SetBounds(self._px(pad), self._px(2), self._px(width - pad * 2 - 26), self._px(17))
        form.Controls.Add(title)

        textbox = TextBox()
        textbox.Multiline = True
        textbox.AcceptsReturn = True
        textbox.ScrollBars = getattr(__import__("System.Windows.Forms", fromlist=["ScrollBars"]), "ScrollBars").Vertical
        textbox.BorderStyle = getattr(BorderStyle, "FixedSingle")
        textbox.BackColor = Color.FromArgb(30, 35, 48)
        textbox.ForeColor = Color.FromArgb(238, 243, 255)
        textbox.Font = font
        # 从标题栏下方开始（22），高度 84
        textbox.SetBounds(self._px(pad), self._px(22), self._px(width - pad * 2), self._px(84))
        textbox.KeyDown += self._on_key
        # 缓存文字：宿主线程读 .Text 会触发跨线程 WM_GETTEXT（SendMessage 会互相等）
        textbox.TextChanged += self._on_text_changed
        form.Controls.Add(textbox)

        status = Label()
        status.Text = "Enter 发送 · Shift+Enter 换行"
        status.ForeColor = Color.FromArgb(150, 162, 186)
        status.Font = font_small
        status.TextAlign = ContentAlignment.MiddleLeft
        status.SetBounds(self._px(pad), self._px(110), self._px(width - pad * 2), self._px(18))
        form.Controls.Add(status)

        def make_button(text, x, w, primary, handler):
            btn = Button()
            btn.Text = text
            btn.FlatStyle = getattr(FlatStyle, "Flat")
            btn.FlatAppearance.BorderSize = 1
            btn.Font = font
            btn.Cursor = getattr(__import__("System.Windows.Forms", fromlist=["Cursors"]), "Cursors").Hand
            if primary:
                btn.BackColor = Color.FromArgb(54, 88, 176)
                btn.FlatAppearance.BorderColor = Color.FromArgb(92, 128, 220)
                btn.ForeColor = Color.FromArgb(240, 245, 255)
            else:
                btn.BackColor = Color.FromArgb(38, 43, 57)
                btn.FlatAppearance.BorderColor = Color.FromArgb(62, 70, 92)
                btn.ForeColor = Color.FromArgb(220, 228, 245)
            btn.UseVisualStyleBackColor = False
            btn.SetBounds(self._px(x), self._px(height - pad - 26), self._px(w), self._px(26))
            btn.Click += (lambda s, e: handler())
            form.Controls.Add(btn)
            return btn

        self.stop_btn = make_button("打断", pad, 74, False, lambda: self._notify(self.on_interrupt))
        self.send_btn = make_button("发送", width - pad - 86, 86, True, lambda: self._notify(self.on_send))

        # 右上角「✕」：单击关掉输入框（用户要求）。
        # 这个回调是在窗口自己的界面线程里触发的，所以要用 BeginInvoke 转回
        # 宿主界面线程再执行（宿主那边要动托盘/桌宠状态，不能跨线程直接碰）。
        close_btn = Button()
        close_btn.Text = "✕"
        close_btn.FlatStyle = getattr(FlatStyle, "Flat")
        close_btn.FlatAppearance.BorderSize = 1
        close_btn.FlatAppearance.BorderColor = Color.FromArgb(62, 70, 92)
        close_btn.BackColor = Color.FromArgb(38, 43, 57)
        close_btn.ForeColor = Color.FromArgb(200, 208, 226)
        close_btn.Font = Font("Microsoft YaHei UI", 8.5)
        close_btn.Cursor = getattr(__import__("System.Windows.Forms", fromlist=["Cursors"]), "Cursors").Hand
        close_btn.UseVisualStyleBackColor = False
        close_btn.SetBounds(self._px(width - pad - 20), self._px(1), self._px(20), self._px(18))
        close_btn.Click += lambda s, e: self._close_from_ui()
        form.Controls.Add(close_btn)
        self.close_btn = close_btn

        form.AcceptsButton = True
        self.form = form
        self.textbox = textbox
        self.status = status
        return form

    # -- 行为 ---------------------------------------------------------------

    def _on_text_changed(self, sender, args) -> None:
        try:
            self._text_cache = str(sender.Text or "")
        except Exception:  # noqa: BLE001
            pass

    def _close_from_ui(self) -> None:
        """「✕」被点击：把自己收起来，然后通知宿主（在宿主界面线程里执行）。"""
        try:
            if self.form is not None and not self.form.IsDisposed:
                self.form.Hide()
                self._visible = False
                self._want_visible = False
        except Exception:  # noqa: BLE001
            pass
        self._notify(self.on_close)

    def _on_key(self, sender, args) -> None:
        Keys = __import__("System.Windows.Forms", fromlist=["Keys"]).Keys
        if args.KeyCode == Keys.Enter and not args.Shift:
            args.SuppressKeyPress = True
            self._notify(self.on_send)

    def text(self) -> str:
        """输入框里的文字（读的是缓存，跨线程调用也不会阻塞）。"""
        return str(self._text_cache or "")

    def clear(self) -> None:
        def ui() -> None:
            try:
                self.textbox.Clear()
                self._text_cache = ""
            except Exception:  # noqa: BLE001
                pass

        self._post_if_ready(ui)

    def set_status(self, text: str) -> None:
        def ui() -> None:
            try:
                self.status.Text = text
            except Exception:  # noqa: BLE001
                pass

        self._post_if_ready(ui)

    def set_enabled_sending(self, sending: bool) -> None:
        def ui() -> None:
            try:
                self.send_btn.Enabled = not sending
                self.stop_btn.Enabled = bool(sending)
                self.send_btn.Text = "发送中…" if sending else "发送"
            except Exception:  # noqa: BLE001
                pass

        self._post_if_ready(ui)

    def is_visible(self) -> bool:
        """当前是不是显示着（缓存值，随时可以从任何线程问）。"""
        return bool(self._visible)

    def wants_visible(self) -> bool:
        """期望的显示状态（toggle 一翻转就立刻生效，不用等窗口线程）。"""
        return bool(self._want_visible)

    # -- 摆放 ---------------------------------------------------------------

    def place_near_pet(self, pet_rect, bubble_rect=None) -> None:
        """把输入框摆到桌宠模型左边（放不下才退右边/上下）。"""
        self._post(lambda: self._place_ui(pet_rect, bubble_rect))

    def _place_ui(self, pet_rect, bubble_rect=None) -> None:
        try:
            from System.Drawing import Point
            from System.Windows.Forms import Screen

            pl, pt, pw, ph = [float(v) for v in pet_rect]
            w = float(self.form.Width)
            h = float(self.form.Height)
            mid = Point(int(pl + pw / 2.0), int(pt + ph / 2.0))
            area = Screen.FromPoint(mid).WorkingArea
            gap = 10.0

            # 候选顺序：**左侧优先**（用户要求输入框就放在模型左边）→ 右侧 → 上方 → 下方。
            # 左边放不下（屏幕边缘）才退到右边；再不行才考虑上下。
            left = (pl - w - gap, pt + (ph - h) / 2.0)
            right = (pl + pw + gap, pt + (ph - h) / 2.0)
            above = (pl + (pw - w) / 2.0, pt - h - gap)
            below = (pl + (pw - w) / 2.0, pt + ph + gap)
            cands = [left, right, above, below]

            def fits(x: float, y: float) -> bool:
                return x >= area.Left and y >= area.Top and x + w <= area.Right and y + h <= area.Bottom

            x, y = cands[0]
            for cx, cy in cands:
                if fits(cx, cy):
                    x, y = cx, cy
                    break

            x = max(float(area.Left), min(x, float(area.Right) - w))
            y = max(float(area.Top), min(y, float(area.Bottom) - h))
            self.form.Location = Point(int(round(x)), int(round(y)))
            # 记住"输入框相对桌宠窗口的偏移"：桌宠被拖动时按这个偏移跟着走
            # （拖动是 60 次/秒的高频动作，重新挑位置太费，直接加偏移最省）
            self._pet_offset = (float(x) - pl, float(y) - pt)
            self._placed = True
        except Exception as exc:  # noqa: BLE001
            self._log("摆放输入框失败：%r" % (exc,))

    def follow_pet(self, pet_rect) -> None:
        """桌宠被拖动时，让输入框按记录好的偏移跟着一起动（节流到 ~30fps）。"""
        if not self._visible:
            return
        now = time.time()
        if now - self._follow_at < 0.033:
            return
        self._follow_at = now
        self._post(lambda: self._follow_ui(pet_rect))

    def _follow_ui(self, pet_rect) -> None:
        try:
            if self.form is None or self.form.IsDisposed or not self.form.Visible:
                return
            offset = self._pet_offset
            if offset is None:
                self._place_ui(pet_rect)
                return
            from System.Drawing import Point

            pl, pt = float(pet_rect[0]), float(pet_rect[1])
            self.form.Location = Point(int(round(pl + offset[0])), int(round(pt + offset[1])))
        except Exception:  # noqa: BLE001
            pass

    # -- 置顶 ---------------------------------------------------------------

    def bring_to_front(self) -> None:
        self._post(self._topmost_ui)

    def _topmost_ui(self) -> None:
        form = self.form
        if form is None or getattr(form, "IsDisposed", True):
            return
        try:
            if not form.Visible:
                return
            if not form.TopMost:
                form.TopMost = True
            form.BringToFront()
            self._setwindowpos_topmost(int(form.Handle.ToInt64()))
        except Exception:  # noqa: BLE001
            pass

    def _setwindowpos_topmost(self, hwnd: int) -> None:
        if not hwnd:
            return
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            user32.SetWindowPos.argtypes = [
                ctypes.c_void_p, ctypes.c_void_p,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                ctypes.c_uint,
            ]
            user32.SetWindowPos.restype = ctypes.c_int
            HWND_TOPMOST = ctypes.c_void_p((1 << 64) - 1)
            SWP_NOSIZE, SWP_NOMOVE = 0x0001, 0x0002
            user32.SetWindowPos(ctypes.c_void_p(hwnd), HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOSIZE | SWP_NOMOVE)
        except Exception:  # noqa: BLE001
            pass

    def reassert_topmost(self) -> None:
        """宿主每 tick 调一次；内部节流，真正干活在窗口线程上（不跨线程碰 WinForms）。"""
        if not self._visible:
            return
        now = time.time()
        if now - self._reassert_at < 2.0:
            return
        self._reassert_at = now
        self._post(self._reassert_ui)

    def _reassert_ui(self) -> None:
        form = self.form
        if form is None or getattr(form, "IsDisposed", True) or not form.Visible:
            return
        if not form.TopMost:
            # Windows 在切前台/换虚拟桌面后会清掉置顶：补回来
            self._topmost_ui()
            self._log("置顶被系统清掉了，已补回")

    # -- 显示 / 隐藏 ---------------------------------------------------------

    def hide(self) -> None:
        self._want_visible = False
        self._post(self._apply_ui)

    def show(self, pet_rect=None, bubble_rect=None) -> None:
        """强制显示（让位结束后恢复用）。不给 pet_rect 就沿用上次的位置。"""
        self._want_visible = True
        self._post(lambda: self._apply_ui(pet_rect, bubble_rect))

    def toggle(self, pet_rect=None, bubble_rect=None) -> None:
        """显示/隐藏（再点一次就关）。pet_rect 给了就顺手摆到桌宠旁边。"""
        if self.form is None or not self._is_alive():
            # 窗口还没建起来（或线程已经结束）：这一下就是"打开"。
            # 否则状态会在"关"上翻转，用户按一次毫无反应、得按两次。
            self._want_visible = True
        else:
            self._want_visible = not bool(self._want_visible)
        self._post(lambda: self._apply_ui(pet_rect, bubble_rect))

    def _apply_ui(self, pet_rect=None, bubble_rect=None) -> None:
        form = self.form
        if form is None or getattr(form, "IsDisposed", True):
            return
        try:
            if self._want_visible:
                if pet_rect is not None:
                    # 先定位再显示，避免在旧位置闪一下
                    self._place_ui(pet_rect, bubble_rect)
                elif self._pet_offset is None and not self._placed:
                    self._center_ui()      # 拿不到桌宠位置：至少别出现在屏幕左上角
                if not form.Visible:
                    form.Show()
                self._visible = True
                form.Activate()
                self._topmost_ui()
                try:
                    self.textbox.Focus()
                except Exception:  # noqa: BLE001
                    pass
            else:
                if form.Visible:
                    form.Hide()
                self._visible = False
        except Exception as exc:  # noqa: BLE001
            self._log("切换显示失败：%r" % (exc,))

    def _center_ui(self) -> None:
        try:
            from System.Drawing import Point
            from System.Windows.Forms import Screen

            area = Screen.PrimaryScreen.WorkingArea
            x = area.Left + (area.Width - self.form.Width) / 2.0
            y = area.Top + (area.Height - self.form.Height) / 2.0
            self.form.Location = Point(int(round(x)), int(round(y)))
            self._placed = True
        except Exception:  # noqa: BLE001
            pass

    # -- 线程 -----------------------------------------------------------------

    def _spawn_async(self) -> None:
        """起窗口线程。**不等待**：调用方是桌宠界面线程，等几百毫秒鼠标就发涩。"""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if self._thread is not None:
                self.form = None          # 上一个线程已经结束：句柄作废，重新建
                self._visible = False
            self._ready.clear()
            self._failed = ""
            self._spawned_at = time.time()
            self._thread = threading.Thread(target=self._run, name="chat-input", daemon=True)
            self._thread.start()

    def _on_thread_exception(self, sender, args) -> None:
        try:
            self._log("窗口线程异常（已忽略）：%r" % (args.Exception,))
        except Exception:  # noqa: BLE001
            pass

    def _run(self) -> None:
        ctypes.windll.ole32.CoInitializeEx(None, 0x2)   # STA，和设置窗口一致
        started = time.time()
        try:
            from System.Windows.Forms import Application, UnhandledExceptionMode

            # 窗口线程上的 WinForms 事件异常默认会弹框 / 直接终结进程（用户报的"崩溃"）。
            # 全部接住只记日志：输入框再怎么出问题也不该带崩桌宠。
            try:
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException)
                Application.ThreadException += self._on_thread_exception
            except Exception:  # noqa: BLE001
                pass

            form = self.build()
            self._log("窗口创建完成 %.0f ms" % ((time.time() - started) * 1000.0))
            self._ready.set()
            # 先补跑排队的动作（里面通常就是"定位到模型左边 + 显示"）：
            # 此时句柄还没建，Location 只是记下来，Show 的时候一次到位，不会先闪中间。
            self._drain_pending()
            # 兜底：万一有动作正好卡在"build 完、Show 之前"投进来，那次 _drain_pending
            # 已经跑过了，这条会被搁在队列里 —— 用窗口线程的定时器补跑，句柄一建好就停。
            from System.Windows.Forms import Timer as _WinTimer

            self._drain_timer = _WinTimer()
            self._drain_timer.Interval = 60
            self._drain_timer.Tick += self._drain_tick
            self._drain_timer.Start()
            if not form.Visible and self._want_visible:
                form.Show()
                self._visible = True
                try:
                    form.Activate()
                    self.textbox.Focus()
                except Exception:  # noqa: BLE001
                    pass
            # 用无主窗体的消息循环：Application.Run(form) 会**强制**把主窗体显示出来，
            # 那样"用户连点两下已经把它关掉"时又会被强行弹回来。
            form.FormClosed += lambda s, e: Application.ExitThread()
            Application.Run()
        except Exception as exc:  # noqa: BLE001
            self._failed = repr(exc)
            self._log("输入窗口线程异常退出：%r" % (exc,))
            self._ready.set()
            self._drain_pending()
        finally:
            self._visible = False
            self._log("输入窗口线程结束")

    @property
    def last_error(self) -> str:
        return self._failed
