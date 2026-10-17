"""聊天输入窗口（点「说话」按钮弹出来的那个小输入框）。

为什么要单独开一个窗口：桌宠的透明分层窗口对鼠标几乎全穿透，网页里收不到点击、
也拿不到键盘焦点。设置窗口就是这么解决的（自己的 STA 线程 + 一个辅助窗口），
这里照同一套路做，输入体验才正常（能选中、能按 Enter 发送）。

样式参考 dsh-whale-girl-live2d 的 composer 面板：深色卡片 + 细边 + 毛玻璃质感，
输入框占满宽度，底部一行「发送 / 打断」。
"""

from __future__ import annotations

import ctypes
import threading


class ChatInputWindow:
    """一个无边框小面板：多行输入 + 发送 / 打断。"""

    def __init__(self, on_send=None, on_interrupt=None, dpi_scale: float = 1.0,
                 on_close=None, host_invoke=None) -> None:
        self.on_send = on_send
        self.on_interrupt = on_interrupt
        self.on_close = on_close              # 「✕」被点击时回调（在宿主界面线程里执行）
        self.host_invoke = host_invoke        # 把可调用对象转回宿主界面线程的工具
        self.dpi_scale = float(dpi_scale or 1.0)
        self.form = None
        self.textbox = None
        self.status = None
        self.send_btn = None
        self.stop_btn = None
        self.close_btn = None
        self._pet_offset = None               # 输入框相对桌宠窗口的偏移（拖动跟随时用）
        self._thread = None
        self._ready = threading.Event()

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
            Padding,
            TextBox,
        )

        # 高度加一点：顶部单独留一条标题栏放「✕」，这样它不会压到文本框的滚动条上
        pad, width, height = 12.0, 380.0, 190.0
        form = Form()
        form.Text = "和 DeepSeek 说话"
        form.FormBorderStyle = getattr(FormBorderStyle, "None")
        form.StartPosition = FormStartPosition.CenterScreen
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

        self.stop_btn = make_button("打断", pad, 74, False, lambda: self._call(self.on_interrupt))
        self.send_btn = make_button("发送", width - pad - 86, 86, True, lambda: self._call(self.on_send))

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

    def _call(self, fn) -> None:
        if fn is None:
            return
        try:
            fn()
        except Exception:  # noqa: BLE001
            pass

    def _close_from_ui(self) -> None:
        """「✕」被点击：把自己收起来，然后通知宿主（在宿主界面线程里执行）。"""
        try:
            if self.form is not None and not self.form.IsDisposed:
                self.form.Hide()
        except Exception:  # noqa: BLE001
            pass
        fn = getattr(self, "on_close", None)
        if fn is None:
            return
        # 这个按钮的回调跑在窗口自己的 STA 线程上；宿主那边要改桌宠/托盘状态，
        # 必须回到宿主界面线程再做（否则可能跨线程访问控件）。
        host_ui = getattr(self, "host_invoke", None)
        try:
            if host_ui is not None:
                host_ui(lambda: self._call(fn))
            else:
                self._call(fn)
        except Exception:  # noqa: BLE001
            self._call(fn)

    def _on_key(self, sender, args) -> None:
        Keys = __import__("System.Windows.Forms", fromlist=["Keys"]).Keys
        if args.KeyCode == Keys.Enter and not args.Shift:
            args.SuppressKeyPress = True
            self._call(self.on_send)

    def text(self) -> str:
        if self.textbox is None:
            return ""
        try:
            return str(self.textbox.Text or "")
        except Exception:  # noqa: BLE001
            return ""

    def clear(self) -> None:
        try:
            self.textbox.Clear()
        except Exception:  # noqa: BLE001
            pass

    def set_status(self, text: str) -> None:
        try:
            self.status.Text = text
        except Exception:  # noqa: BLE001
            pass

    def place_near_pet(self, pet_rect, bubble_rect=None) -> None:
        """把输入框摆到桌宠模型旁边（默认正上方；上方被气泡占住时优先摆左侧）。

        pet_rect 是桌宠窗口的屏幕矩形 (left, top, width, height)；
        bubble_rect 是气泡的屏幕矩形（可空）—— 气泡在上方时输入框改放模型左边。
        结果会夹在当前屏幕工作区内，免得摆到屏幕外面看不见。
        """
        if self.form is None or self.form.IsDisposed:
            return
        try:
            from System import Action

            # 必须在这个窗口自己的界面线程上执行（它是独立 STA 线程）
            self.form.BeginInvoke(Action(lambda: self._place_near_pet_ui(pet_rect, bubble_rect)))
        except Exception:  # noqa: BLE001
            pass

    def _place_near_pet_ui(self, pet_rect, bubble_rect=None) -> None:
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
        except Exception:  # noqa: BLE001
            pass

    def follow_pet(self, pet_rect) -> None:
        """桌宠被拖动时，让输入框按记录好的偏移跟着一起动。

        只在输入框可见时才有意义；偏移还没记录过（从未摆放）就直接按左侧摆一次。
        """
        if self.form is None or self.form.IsDisposed:
            return
        try:
            if not self.form.Visible:
                return
            offset = getattr(self, "_pet_offset", None)
            if offset is None:
                self._place_near_pet_ui(pet_rect)
                return
            from System.Drawing import Point

            pl, pt = float(pet_rect[0]), float(pet_rect[1])
            self.form.Location = Point(int(round(pl + offset[0])), int(round(pt + offset[1])))
        except Exception:  # noqa: BLE001
            pass

    def set_enabled_sending(self, sending: bool) -> None:
        try:
            self.send_btn.Enabled = not sending
            self.stop_btn.Enabled = bool(sending)
            self.send_btn.Text = "发送中…" if sending else "发送"
        except Exception:  # noqa: BLE001
            pass

    def toggle(self, pet_rect=None, bubble_rect=None) -> None:
        """显示/隐藏（再点一次就关）。pet_rect 给了就顺手摆到桌宠旁边。"""
        if self.form is None or self.form.IsDisposed:
            self._spawn()
            if pet_rect is not None:
                self.place_near_pet(pet_rect, bubble_rect)
            return
        try:
            if self.form.Visible:
                self.form.Hide()
            else:
                if pet_rect is not None:
                    # 先定位再显示，避免在旧位置闪一下
                    self._place_near_pet_ui(pet_rect, bubble_rect)
                self.form.Show()
                self.form.Activate()
                self.textbox.Focus()
        except Exception:  # noqa: BLE001
            pass

    def _spawn(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name="chat-input", daemon=True)
        self._thread.start()
        self._ready.wait(3.0)

    def _run(self) -> None:
        ctypes.windll.ole32.CoInitializeEx(None, 0x2)   # STA，和设置窗口一致
        try:
            from System.Windows.Forms import Application

            form = self.build()
            self._ready.set()
            form.Show()
            form.Activate()
            try:
                self.textbox.Focus()
            except Exception:  # noqa: BLE001
                pass
            Application.Run(form)
        except Exception:  # noqa: BLE001
            self._ready.set()
