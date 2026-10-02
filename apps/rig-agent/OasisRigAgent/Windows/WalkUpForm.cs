using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;

namespace OasisRigAgent.Windows;

/// <summary>
/// The rig's sign-in and driving screens as one window, drawn from
/// <see cref="WalkUpViewModel.Snapshot"/> and nothing else: every button and
/// field hands its answer to the model, the model raises Changed on whatever
/// thread, and the window redraws on its own thread. The rules all live in
/// Core; this file is layout and marshalling.
///
/// It looks like the wall and the website on purpose (<see cref="Brand"/>):
/// the near-black `--bg`, the cyan and pink accents, Orbitron for headings and
/// Rajdhani for text, the helmet mark in the header over the site's gradient
/// rule. It is an ordinary window - resizable, opened centred on the primary
/// screen, never topmost and never full screen - so staff can reach iRacing and
/// anything else beside it; the owner asked for exactly that. Type is sized in
/// points from a 960x720 design and scaled with the window when a drag or a
/// maximise ends, so a bigger window reads from further away and a smaller one
/// still fits.
///
/// Sign-in is name first: one prompt at a time in large type, the notice on its
/// own line above it (red for a problem, green for the last driver's
/// thank-you), the typed name shown over every prompt about it, and "Not you?
/// Pick a different name" wherever a newcomer may have typed somebody else's
/// name. Driving shows the driver's name, their best lap tonight in the largest
/// type on the screen and their place on tonight's board - both off the same
/// feed the wall reads - their laps as a list, and Log out.
///
/// Light on the rig on purpose: plain WinForms controls, no timer, no
/// animation, a redraw only when the model changes (and fonts rebuilt only
/// when a resize ends), and the process already runs below normal priority -
/// iRacing keeps the CPU and the frame rate.
/// </summary>
internal sealed class WalkUpForm : Form
{
    private const float DesignWidth = 960f;
    private const float DesignHeight = 720f;
    private const string NoTime = "--:--.---";

    private readonly WalkUpViewModel _model;

    // Every control whose type scales, with its design size in points.
    private readonly List<(Control Control, Face Face, float Points)> _typed = new();
    private readonly List<Font> _fonts = new();
    private float _scale = 1f;
    private FormWindowState _lastState;

    private readonly Label _title = new();
    private readonly Label _subtitle = new();
    private readonly Label _rig = new();
    private readonly PictureBox _mark = new();
    private readonly Panel _rule = new();
    private readonly Label _warnings = new();
    private readonly Label _recent = new();

    private readonly TableLayoutPanel _signIn = new();
    private readonly Label _notice = new();
    private readonly Label _eyebrow = new();
    private readonly Label _nameShown = new();
    private readonly Label _prompt = new();
    private readonly Panel _inputFrame = new();
    private readonly TextBox _input = new();
    private readonly Button _next = new();
    private readonly Button _back = new();
    private readonly Label _hint = new();

    private readonly Label _busy = new();

    private readonly TableLayoutPanel _driving = new();
    private readonly Label _drivingEyebrow = new();
    private readonly Label _driverName = new();
    private readonly Label _welcome = new();
    private readonly Panel _card = new();
    private readonly Label _bestEyebrow = new();
    private readonly Label _bestLap = new();
    private readonly Label _bestSub = new();
    private readonly Label _placeEyebrow = new();
    private readonly Label _place = new();
    private readonly Label _placeSub = new();
    private readonly ListView _laps = new();
    private readonly Button _logOut = new();

    private SignInStep? _renderedStep;
    private string _renderedLaps = "";

    private enum Face { Display, Body, BodyBold, Mono }

    public WalkUpForm(WalkUpViewModel model)
    {
        _model = model;
        var view = model.Snapshot();

        Text = $"Oasis Sim Racing - Rig {view.RigNumber:D2}";
        BackColor = Brand.Bg;
        ForeColor = Brand.Ink;
        Font = Brand.BodyFont(12f);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size((int)DesignWidth, (int)DesignHeight);
        MinimumSize = new Size(640, 480);
        AutoScaleMode = AutoScaleMode.Dpi;
        KeyPreview = true;
        DoubleBuffered = true;
        if (Brand.Helmet is Bitmap helmet)
        {
            try { Icon = Icon.FromHandle(helmet.GetHicon()); }
            catch (Exception) { /* the default icon will do */ }
        }

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(28, 22, 28, 18) };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // header
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // gradient rule
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // warnings
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f)); // screen
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // recent lines
        Controls.Add(root);

        root.Controls.Add(BuildHeader(view.RigNumber), 0, 0);

        _rule.Height = 4;
        _rule.Dock = DockStyle.Top;
        _rule.Margin = new Padding(0, 14, 0, 0);
        _rule.Paint += (_, e) =>
        {
            using var brush = Brand.GradientRule(_rule.ClientRectangle);
            e.Graphics.FillRectangle(brush, _rule.ClientRectangle);
        };
        _rule.Resize += (_, _) => _rule.Invalidate();
        root.Controls.Add(_rule, 0, 1);

        Style(_warnings, Face.Body, 13f, Brand.Sunset);
        _warnings.Margin = new Padding(0, 12, 0, 0);
        root.Controls.Add(_warnings, 0, 2);

        var screen = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) };
        root.Controls.Add(screen, 0, 3);
        screen.Controls.Add(BuildSignIn());
        screen.Controls.Add(BuildBusy());
        screen.Controls.Add(BuildDriving());

        Style(_recent, Face.Body, 10f, Brand.Muted);
        _recent.Margin = new Padding(0, 12, 0, 0);
        root.Controls.Add(_recent, 0, 4);

        _model.Changed += OnModelChanged;
        Load += (_, _) => { ApplyScale(); Render(); };
        ResizeEnd += (_, _) => ApplyScale();
        Resize += (_, _) =>
        {
            // A maximise or restore ends no drag, so it is rescaled here.
            if (WindowState == _lastState) return;
            _lastState = WindowState;
            ApplyScale();
        };
        FormClosed += (_, _) => _model.Changed -= OnModelChanged;
        KeyDown += OnKeyDown;
    }

    private Control BuildHeader(int rigNumber)
    {
        var header = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, Margin = new Padding(0) };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        _mark.SizeMode = PictureBoxSizeMode.Zoom;
        _mark.Image = Brand.Helmet;
        _mark.Size = new Size(46, 56);
        _mark.Margin = new Padding(0, 0, 16, 0);
        _mark.Visible = Brand.Helmet is not null;
        header.Controls.Add(_mark, 0, 0);

        var titles = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Margin = new Padding(0), Anchor = AnchorStyles.Left };
        titles.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        titles.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Style(_title, Face.Display, 16f, Brand.Ink);
        _title.Text = "OASIS SIM RACING";
        _title.Dock = DockStyle.None;
        titles.Controls.Add(_title, 0, 0);
        Style(_subtitle, Face.Display, 8.5f, Brand.Muted);
        _subtitle.Text = "RACE CONTROL";
        _subtitle.Dock = DockStyle.None;
        _subtitle.Margin = new Padding(1, 2, 0, 0);
        titles.Controls.Add(_subtitle, 0, 1);
        header.Controls.Add(titles, 1, 0);

        Style(_rig, Face.Display, 26f, Brand.Accent);
        _rig.Text = $"RIG {rigNumber:D2}";
        _rig.Dock = DockStyle.None;
        _rig.Anchor = AnchorStyles.Right;
        header.Controls.Add(_rig, 2, 0);
        return header;
    }

    private Control BuildSignIn()
    {
        _signIn.Dock = DockStyle.Fill;
        _signIn.ColumnCount = 1;
        _signIn.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        _signIn.Padding = new Padding(0, 26, 0, 0);
        for (var i = 0; i < 7; i++) _signIn.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Style(_notice, Face.Body, 15f, Brand.Invalid);
        _notice.Margin = new Padding(0, 0, 0, 18);
        _signIn.Controls.Add(_notice, 0, 0);

        Style(_eyebrow, Face.Display, 10f, Brand.Accent2);
        _eyebrow.Margin = new Padding(0, 0, 0, 6);
        _signIn.Controls.Add(_eyebrow, 0, 1);

        Style(_nameShown, Face.Display, 28f, Brand.Ink);
        _nameShown.Margin = new Padding(0, 0, 0, 10);
        _signIn.Controls.Add(_nameShown, 0, 2);

        Style(_prompt, Face.BodyBold, 22f, Brand.Ink);
        _prompt.Margin = new Padding(0, 0, 0, 16);
        _signIn.Controls.Add(_prompt, 0, 3);

        var inputRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 14) };
        _inputFrame.BackColor = Brand.Edge;
        _inputFrame.Padding = new Padding(2);
        _inputFrame.AutoSize = true;
        _inputFrame.Margin = new Padding(0, 0, 16, 0);
        _input.BackColor = Brand.Surface;
        _input.ForeColor = Brand.Ink;
        _input.BorderStyle = BorderStyle.None;
        _input.Width = 420;
        _input.Margin = new Padding(0);
        _input.KeyPress += OnInputKeyPress;
        _input.GotFocus += (_, _) => _inputFrame.BackColor = Brand.Accent;
        _input.LostFocus += (_, _) => _inputFrame.BackColor = Brand.Edge;
        Typed(_input, Face.Body, 28f);
        _inputFrame.Controls.Add(_input);
        inputRow.Controls.Add(_inputFrame);
        PrimaryButton(_next, "Next");
        _next.Click += async (_, _) => await Submit();
        inputRow.Controls.Add(_next);
        _signIn.Controls.Add(inputRow, 0, 4);

        var choices = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        SecondaryButton(_back, "Back");
        _back.Click += async (_, _) => await _model.BackAsync();
        choices.Controls.Add(_back);
        _signIn.Controls.Add(choices, 0, 5);

        Style(_hint, Face.Body, 12.5f, Brand.Muted);
        _hint.Margin = new Padding(0, 18, 0, 0);
        _signIn.Controls.Add(_hint, 0, 6);
        return _signIn;
    }

    private Control BuildBusy()
    {
        Style(_busy, Face.Display, 18f, Brand.Muted);
        _busy.Dock = DockStyle.Fill;
        _busy.TextAlign = ContentAlignment.MiddleCenter;
        _busy.AutoSize = false;
        return _busy;
    }

    private Control BuildDriving()
    {
        _driving.Dock = DockStyle.Fill;
        _driving.ColumnCount = 1;
        _driving.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        _driving.Padding = new Padding(0, 20, 0, 0);
        _driving.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // name + log out
        _driving.RowStyles.Add(new RowStyle(SizeType.AutoSize));   // standing card
        _driving.RowStyles.Add(new RowStyle(SizeType.Percent, 100f)); // laps

        var top = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Margin = new Padding(0, 0, 0, 18) };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var who = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Margin = new Padding(0), Dock = DockStyle.Fill };
        for (var i = 0; i < 3; i++) who.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Style(_drivingEyebrow, Face.Display, 10f, Brand.Accent2);
        _drivingEyebrow.Text = "DRIVING AS";
        _drivingEyebrow.Margin = new Padding(0, 0, 0, 4);
        who.Controls.Add(_drivingEyebrow, 0, 0);
        Style(_driverName, Face.Display, 30f, Brand.Accent);
        who.Controls.Add(_driverName, 0, 1);
        Style(_welcome, Face.Body, 13.5f, Brand.Muted);
        _welcome.Margin = new Padding(0, 6, 0, 0);
        who.Controls.Add(_welcome, 0, 2);
        top.Controls.Add(who, 0, 0);
        SecondaryButton(_logOut, "Log out", Brand.Accent2);
        _logOut.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _logOut.Margin = new Padding(16, 4, 0, 0);
        _logOut.Click += async (_, _) => await _model.LogOutAsync();
        top.Controls.Add(_logOut, 1, 0);
        _driving.Controls.Add(top, 0, 0);

        _card.BackColor = Brand.Raised;
        _card.Dock = DockStyle.Top;
        _card.AutoSize = true;
        _card.Padding = new Padding(22, 16, 22, 18);
        _card.Margin = new Padding(0, 0, 0, 18);
        _card.Paint += (_, e) =>
        {
            using var pen = new Pen(Brand.Edge);
            var r = _card.ClientRectangle;
            e.Graphics.DrawRectangle(pen, r.X, r.Y, r.Width - 1, r.Height - 1);
        };
        var standing = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Margin = new Padding(0) };
        standing.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62f));
        standing.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38f));
        for (var i = 0; i < 3; i++) standing.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Style(_bestEyebrow, Face.Display, 10f, Brand.Muted);
        _bestEyebrow.Text = "BEST LAP TONIGHT";
        standing.Controls.Add(_bestEyebrow, 0, 0);
        Style(_bestLap, Face.Mono, 54f, Brand.Ink);
        _bestLap.Text = NoTime;
        _bestLap.Margin = new Padding(0, 2, 0, 0);
        standing.Controls.Add(_bestLap, 0, 1);
        Style(_bestSub, Face.Body, 12.5f, Brand.Muted);
        standing.Controls.Add(_bestSub, 0, 2);
        Style(_placeEyebrow, Face.Display, 10f, Brand.Muted);
        _placeEyebrow.Text = "TONIGHT'S BOARD";
        standing.Controls.Add(_placeEyebrow, 1, 0);
        Style(_place, Face.Display, 46f, Brand.Accent2);
        _place.Text = "--";
        _place.Margin = new Padding(0, 2, 0, 0);
        standing.Controls.Add(_place, 1, 1);
        Style(_placeSub, Face.Body, 12.5f, Brand.Muted);
        standing.Controls.Add(_placeSub, 1, 2);
        _card.Controls.Add(standing);
        _driving.Controls.Add(_card, 0, 1);

        _laps.Dock = DockStyle.Fill;
        _laps.View = View.Details;
        _laps.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        _laps.FullRowSelect = false;
        _laps.MultiSelect = false;
        _laps.BackColor = Brand.Surface;
        _laps.ForeColor = Brand.Ink;
        _laps.BorderStyle = BorderStyle.None;
        _laps.Margin = new Padding(0);
        _laps.Columns.Add("Lap", 90);
        _laps.Columns.Add("Time", 200);
        _laps.Columns.Add("Incidents", 160);
        _laps.Columns.Add("Status", 200);
        // The header is drawn here so it is dark like the rest; rows draw as usual.
        _laps.OwnerDraw = true;
        _laps.DrawColumnHeader += (_, e) =>
        {
            e.Graphics.FillRectangle(new SolidBrush(Brand.Bg), e.Bounds);
            TextRenderer.DrawText(e.Graphics, e.Header!.Text.ToUpperInvariant(), _placeEyebrow.Font,
                new Rectangle(e.Bounds.X + 6, e.Bounds.Y, e.Bounds.Width - 6, e.Bounds.Height), Brand.Muted,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        };
        _laps.DrawItem += (_, e) => e.DrawDefault = true;
        _laps.DrawSubItem += (_, e) => e.DrawDefault = true;
        _laps.Resize += (_, _) => SizeLapColumns();
        Typed(_laps, Face.Body, 15f);
        _driving.Controls.Add(_laps, 0, 2);
        return _driving;
    }

    /// <summary>A label that wraps at the window's edge and grows downward:
    /// auto-sized, docked across its 100% column, in one of the brand faces.</summary>
    private void Style(Label label, Face face, float points, Color color)
    {
        label.AutoSize = true;
        label.Dock = DockStyle.Fill;
        label.ForeColor = color;
        label.Margin = new Padding(0);
        label.UseMnemonic = false;
        Typed(label, face, points);
    }

    private void Typed(Control control, Face face, float points) => _typed.Add((control, face, points));

    private void PrimaryButton(Button button, string text)
    {
        Button(button, text);
        button.BackColor = Brand.Accent;
        button.ForeColor = Brand.Bg;
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Brand.Ink;
        button.FlatAppearance.MouseDownBackColor = Brand.Accent2;
    }

    private void SecondaryButton(Button button, string text, Color? edge = null)
    {
        Button(button, text);
        button.BackColor = Brand.Bg;
        button.ForeColor = edge ?? Brand.Muted;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = edge ?? Brand.Edge;
        button.FlatAppearance.MouseOverBackColor = Brand.Raised;
        button.FlatAppearance.MouseDownBackColor = Brand.Edge;
    }

    private void Button(Button button, string text)
    {
        button.Text = text;
        button.AutoSize = true;
        button.FlatStyle = FlatStyle.Flat;
        button.Padding = new Padding(22, 10, 22, 10);
        button.Margin = new Padding(0, 0, 14, 0);
        button.Cursor = Cursors.Hand;
        button.UseMnemonic = false;
        button.TabStop = true;
        Typed(button, Face.Display, 11.5f);
    }

    /// <summary>Rebuild every font for the window's current size: the design
    /// is 960x720 and the type grows or shrinks with whichever axis is tighter.
    /// Called when a drag ends and on maximise/restore, never on every pixel of
    /// a resize, so dragging the edge costs nothing until it stops.</summary>
    private void ApplyScale()
    {
        var scale = Math.Clamp(Math.Min(ClientSize.Width / DesignWidth, ClientSize.Height / DesignHeight), 0.6f, 2.2f);
        if (_fonts.Count > 0 && Math.Abs(scale - _scale) < 0.02f) return;
        _scale = scale;
        var old = _fonts.ToList();
        _fonts.Clear();
        SuspendLayout();
        foreach (var (control, face, points) in _typed)
        {
            var font = face switch
            {
                Face.Display => Brand.DisplayFont(points * scale),
                Face.BodyBold => Brand.BodyBoldFont(points * scale),
                Face.Mono => Brand.MonoFont(points * scale),
                _ => Brand.BodyFont(points * scale),
            };
            _fonts.Add(font);
            control.Font = font;
        }
        _mark.Size = new Size((int)(46 * scale), (int)(56 * scale));
        _input.Width = (int)(420 * scale);
        _rule.Height = Math.Max(3, (int)(4 * scale));
        foreach (ListViewItem item in _laps.Items) item.SubItems[1].Font = _bestSub.Font;
        SizeLapColumns();
        ResumeLayout(true);
        // The controls hold the new fonts now; the old ones can go.
        foreach (var font in old) font.Dispose();
    }

    private void SizeLapColumns()
    {
        if (_laps.Columns.Count < 4) return;
        var width = Math.Max(_laps.ClientSize.Width, 320);
        _laps.Columns[0].Width = (int)(width * 0.12);
        _laps.Columns[1].Width = (int)(width * 0.30);
        _laps.Columns[2].Width = (int)(width * 0.24);
        _laps.Columns[3].Width = width - _laps.Columns[0].Width - _laps.Columns[1].Width - _laps.Columns[2].Width - 4;
    }

    private void OnModelChanged()
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(Render); }
        catch (InvalidOperationException) { /* closing */ }
    }

    private void Render()
    {
        if (IsDisposed) return;
        var view = _model.Snapshot();

        _warnings.Text = string.Join(Environment.NewLine, view.Warnings);
        _warnings.Visible = view.Warnings.Count > 0;
        _recent.Text = string.Join(Environment.NewLine, view.Recent);

        _signIn.Visible = view.Stage == WalkUpStage.SignIn;
        _busy.Visible = view.Stage == WalkUpStage.Busy;
        _driving.Visible = view.Stage == WalkUpStage.Driving;

        switch (view.Stage)
        {
            case WalkUpStage.SignIn:
                RenderSignIn(view);
                break;
            // Off the sign-in surface the field holds nothing: a PIN must not
            // sit in a hidden textbox for the length of a stint.
            case WalkUpStage.Busy:
                _busy.Text = view.BusyText;
                _input.Clear();
                _renderedStep = null;
                break;
            case WalkUpStage.Driving:
                RenderDriving(view);
                _input.Clear();
                _renderedStep = null;
                break;
        }
    }

    private void RenderSignIn(WalkUpView view)
    {
        _notice.Text = view.Notice ?? "";
        _notice.ForeColor = view.NoticeIsFarewell ? Brand.Valid : Brand.Invalid;
        _notice.Visible = view.Notice is not null;

        var refused = view.Step == SignInStep.PinRefused;
        var returning = view.Step is SignInStep.AskPin or SignInStep.PinRefused;
        var pin = view.Step is SignInStep.AskPin or SignInStep.AskNewPin or SignInStep.AskNewPinAgain;

        _eyebrow.Text = view.Step switch
        {
            SignInStep.AskName => "SIGN IN",
            SignInStep.AskPin => "WELCOME BACK",
            SignInStep.PinRefused => "PIN NOT ACCEPTED",
            _ => "NEW DRIVER",
        };
        _nameShown.Text = view.Name;
        _nameShown.Visible = view.Step != SignInStep.AskName;
        _nameShown.ForeColor = returning ? Brand.Accent : Brand.Accent2;

        _prompt.Text = view.Step switch
        {
            SignInStep.AskName => "Type your name",
            SignInStep.AskPin => "Type your 4-digit PIN",
            SignInStep.PinRefused => "That PIN does not match. Ask staff to reset your PIN, or try a different name.",
            SignInStep.AskNewPin => "New here? Pick a 4-digit PIN and remember it",
            SignInStep.AskNewPinAgain => "Type the same PIN again",
            _ => "",
        };
        _hint.Text = view.Step switch
        {
            SignInStep.AskName => "Your name goes on the leaderboard. Use the same name and PIN every time, on any rig.",
            SignInStep.AskPin => "Forgotten it? Staff can reset your PIN at the counter.",
            SignInStep.AskNewPin => "Your PIN is how you get back to your own laps next time. Four digits, typed twice.",
            _ => "",
        };
        _hint.Visible = _hint.Text.Length > 0;

        _inputFrame.Parent!.Visible = !refused;
        _back.Visible = view.Step != SignInStep.AskName;
        _back.Text = view.Step switch
        {
            SignInStep.AskPin => "Not you? Pick a different name",
            SignInStep.PinRefused => "Try a different name",
            SignInStep.AskNewPin => "Not your name? Go back",
            _ => "Back",
        };
        _next.Text = view.Step switch
        {
            SignInStep.AskPin => "Sign in",
            SignInStep.AskNewPinAgain => "Sign up",
            _ => "Next",
        };

        if (_renderedStep != view.Step)
        {
            _renderedStep = view.Step;
            _input.Clear();
            _input.UseSystemPasswordChar = pin;
            _input.MaxLength = pin ? 4 : 24;
            _input.TextAlign = pin ? HorizontalAlignment.Center : HorizontalAlignment.Left;
        }
        AcceptButton = _inputFrame.Parent.Visible ? _next : null;
        if (_inputFrame.Parent.Visible) _input.Focus();
        else _back.Focus();
    }

    private void RenderDriving(WalkUpView view)
    {
        if (view.Driver is not { } driver) return;
        _driverName.Text = driver.DisplayName;
        _welcome.Text = WalkUpRules.Welcome(driver);
        RenderStanding(view.Standing);

        // Rebuilt only when a row changed, so a status tick does not flicker the list.
        var signature = string.Join("|", view.Laps.Select(l => $"{l.EventId}:{l.State}"));
        if (signature == _renderedLaps) return;
        _renderedLaps = signature;
        _laps.BeginUpdate();
        _laps.Items.Clear();
        foreach (var lap in view.Laps)
        {
            var item = new ListViewItem(lap.LapNumber?.ToString() ?? "-") { UseItemStyleForSubItems = false, ForeColor = Brand.Muted };
            var time = item.SubItems.Add(LapTime.Format(lap.LapTimeMs));
            time.ForeColor = Brand.Ink;
            time.Font = _bestSub.Font;
            item.SubItems.Add(lap.IncidentDelta?.ToString() ?? "n/a").ForeColor = lap.IncidentDelta > 0 ? Brand.Sunset : Brand.Muted;
            var posted = lap.State == LapRowState.Posted;
            item.SubItems.Add(posted ? "posted" : "queued").ForeColor = posted ? Brand.Valid : Brand.Muted;
            _laps.Items.Add(item);
        }
        _laps.EndUpdate();
        if (_laps.Items.Count > 0) _laps.EnsureVisible(_laps.Items.Count - 1);
    }

    /// <summary>The top of the driving screen: the best lap in the largest
    /// type on the screen, gold when it leads tonight, and the place beside
    /// it. Before the first answer, and for a driver with no valid lap tonight
    /// yet, the slots say so rather than showing a stale or invented number.</summary>
    private void RenderStanding(TonightStanding? standing)
    {
        if (standing is null)
        {
            _bestLap.Text = NoTime;
            _bestLap.ForeColor = Brand.Muted;
            _bestSub.Text = "Reading tonight's leaderboard...";
            _place.Text = "--";
            _place.ForeColor = Brand.Muted;
            _placeSub.Text = "";
            return;
        }
        var drivers = standing.Drivers == 1 ? "1 driver" : $"{standing.Drivers} drivers";
        if (standing.BestLapMs is int best)
        {
            _bestLap.Text = LapTime.Format(best);
            _bestLap.ForeColor = standing.Leading ? Brand.Gold : Brand.Ink;
            _bestSub.Text = standing.Combo ?? "Tonight's leaderboard";
        }
        else
        {
            _bestLap.Text = NoTime;
            _bestLap.ForeColor = Brand.Muted;
            _bestSub.Text = standing.Combo is null
                ? "No valid lap tonight yet - your first clean lap goes up here."
                : $"No valid lap yet in {standing.Combo} - your first clean lap goes up here.";
        }
        if (standing.Place is int place)
        {
            _place.Text = $"P{place}";
            _place.ForeColor = standing.Leading ? Brand.Gold : Brand.Accent2;
            _placeSub.Text = $"of {drivers} tonight";
        }
        else
        {
            _place.Text = "--";
            _place.ForeColor = Brand.Muted;
            _placeSub.Text = standing.Drivers == 0 ? "nobody on the board yet" : $"{drivers} on the board";
        }
    }

    /// <summary>Hand the field to the model and empty it at once, so the PIN
    /// leaves the control the moment Enter is pressed - the console clears its
    /// screen at the same moment.</summary>
    private async Task Submit()
    {
        var typed = _input.Text;
        _input.Clear();
        await _model.SubmitAsync(typed);
    }

    /// <summary>A PIN field takes digits only; the PIN is exactly four.</summary>
    private void OnInputKeyPress(object? sender, KeyPressEventArgs e)
    {
        if (_input.UseSystemPasswordChar && !char.IsControl(e.KeyChar) && !char.IsAsciiDigit(e.KeyChar))
            e.Handled = true;
    }

    /// <summary>Escape is the Back button from the keyboard - "Not you?" at the
    /// PIN - so a driver with a keyboard in reach never has to find the mouse.</summary>
    private async void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.Escape || !_signIn.Visible || _renderedStep is null or SignInStep.AskName) return;
        e.Handled = true;
        await _model.BackAsync();
    }
}
