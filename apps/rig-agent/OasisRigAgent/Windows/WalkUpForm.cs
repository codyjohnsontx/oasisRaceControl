using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;

namespace OasisRigAgent.Windows;

/// <summary>
/// The rig's sign-in and driving screens as one window, drawn from
/// <see cref="WalkUpViewModel.Snapshot"/> and nothing else: every button and
/// field hands its answer to the model, the model raises Changed on whatever
/// thread, and the window redraws on its own thread. The rules all live in
/// Core; this file is layout and marshalling. Sized to be read from the seat:
/// one prompt at a time in large type, the error on its own line above it,
/// the rig number in the header.
///
/// Light on the rig on purpose: plain WinForms controls, no timer, no
/// animation, a redraw only when the model changes, and the process already
/// runs below normal priority - iRacing keeps the CPU and the frame rate.
/// </summary>
internal sealed class WalkUpForm : Form
{
    private static readonly Color Background = Color.FromArgb(16, 20, 24);
    private static readonly Color Panel = Color.FromArgb(28, 34, 40);
    private static readonly Color Ink = Color.FromArgb(240, 243, 245);
    private static readonly Color Muted = Color.FromArgb(150, 160, 170);
    private static readonly Color Amber = Color.FromArgb(255, 190, 60);
    private static readonly Color Red = Color.FromArgb(255, 110, 100);
    private static readonly Color Green = Color.FromArgb(110, 220, 140);
    private static readonly Color Accent = Color.FromArgb(0, 122, 204);

    private readonly WalkUpViewModel _model;

    private readonly Label _header = new();
    private readonly Label _warnings = new();
    private readonly Label _recent = new();

    private readonly TableLayoutPanel _signIn = new();
    private readonly Label _notice = new();
    private readonly Label _nameShown = new();
    private readonly Label _prompt = new();
    private readonly TextBox _input = new();
    private readonly Button _next = new();
    private readonly Button _yes = new();
    private readonly Button _no = new();
    private readonly Button _back = new();

    private readonly Label _busy = new();

    private readonly TableLayoutPanel _driving = new();
    private readonly Label _driverName = new();
    private readonly Label _welcome = new();
    private readonly ListView _laps = new();
    private readonly Button _logOut = new();

    private SignInStep? _renderedStep;
    private string _renderedLaps = "";

    public WalkUpForm(WalkUpViewModel model)
    {
        _model = model;
        var view = model.Snapshot();

        Text = $"Oasis Race Control - Rig {view.RigNumber:D2}";
        BackColor = Background;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 14f);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(960, 720);
        MinimumSize = new Size(720, 560);
        AutoScaleMode = AutoScaleMode.Dpi;
        KeyPreview = true;

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(24) };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(root);

        Style(_header, 20f, Muted, bold: true);
        _header.Text = $"OASIS RACE CONTROL  -  RIG {view.RigNumber:D2}";
        root.Controls.Add(_header, 0, 0);

        Style(_warnings, 14f, Amber);
        _warnings.Margin = new Padding(0, 12, 0, 0);
        root.Controls.Add(_warnings, 0, 1);

        var content = new Panel { Dock = DockStyle.Fill };
        root.Controls.Add(content, 0, 2);
        content.Controls.Add(BuildSignIn());
        content.Controls.Add(BuildBusy());
        content.Controls.Add(BuildDriving());

        Style(_recent, 11f, Muted);
        _recent.Margin = new Padding(0, 12, 0, 0);
        root.Controls.Add(_recent, 0, 3);

        _model.Changed += OnModelChanged;
        Load += (_, _) => Render();
        FormClosed += (_, _) => _model.Changed -= OnModelChanged;
        KeyDown += OnKeyDown;
    }

    private Control BuildSignIn()
    {
        _signIn.Dock = DockStyle.Fill;
        _signIn.ColumnCount = 1;
        _signIn.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        _signIn.Padding = new Padding(0, 24, 0, 0);
        for (var i = 0; i < 5; i++) _signIn.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Style(_notice, 16f, Red);
        _notice.Margin = new Padding(0, 0, 0, 16);
        _signIn.Controls.Add(_notice, 0, 0);

        Style(_nameShown, 18f, Muted);
        _signIn.Controls.Add(_nameShown, 0, 1);

        Style(_prompt, 24f, Ink, bold: true);
        _prompt.Margin = new Padding(0, 8, 0, 16);
        _signIn.Controls.Add(_prompt, 0, 2);

        var inputRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        _input.Font = new Font("Segoe UI", 28f);
        _input.BackColor = Panel;
        _input.ForeColor = Ink;
        _input.BorderStyle = BorderStyle.FixedSingle;
        _input.Width = 440;
        _input.Margin = new Padding(0, 0, 16, 0);
        _input.KeyPress += OnInputKeyPress;
        inputRow.Controls.Add(_input);
        StyleButton(_next, "Next", Accent);
        _next.Click += async (_, _) => await Submit();
        inputRow.Controls.Add(_next);
        _signIn.Controls.Add(inputRow, 0, 3);

        var choices = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 0) };
        StyleButton(_yes, "Yes, I have raced here", Accent);
        _yes.Click += async (_, _) => await _model.ChooseReturningAsync(true);
        choices.Controls.Add(_yes);
        StyleButton(_no, "No, I am new", Panel);
        _no.Click += async (_, _) => await _model.ChooseReturningAsync(false);
        choices.Controls.Add(_no);
        StyleButton(_back, "Back", Panel);
        _back.Click += async (_, _) => await _model.BackAsync();
        choices.Controls.Add(_back);
        _signIn.Controls.Add(choices, 0, 4);
        return _signIn;
    }

    private Control BuildBusy()
    {
        Style(_busy, 24f, Muted);
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
        _driving.Padding = new Padding(0, 24, 0, 0);
        _driving.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _driving.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _driving.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
        _driving.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Style(_driverName, 40f, Green, bold: true);
        _driving.Controls.Add(_driverName, 0, 0);

        Style(_welcome, 16f, Ink);
        _welcome.Margin = new Padding(0, 4, 0, 16);
        _driving.Controls.Add(_welcome, 0, 1);

        _laps.Dock = DockStyle.Fill;
        _laps.View = View.Details;
        _laps.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        _laps.FullRowSelect = false;
        _laps.MultiSelect = false;
        _laps.BackColor = Panel;
        _laps.ForeColor = Ink;
        _laps.BorderStyle = BorderStyle.None;
        _laps.Font = new Font("Segoe UI", 16f);
        _laps.Columns.Add("Lap", 110);
        _laps.Columns.Add("Time", 220);
        _laps.Columns.Add("Incidents", 170);
        _laps.Columns.Add("Status", 220);
        _driving.Controls.Add(_laps, 0, 2);

        StyleButton(_logOut, "Log out", Accent);
        _logOut.Margin = new Padding(0, 16, 0, 0);
        _logOut.Click += async (_, _) => await _model.LogOutAsync();
        _driving.Controls.Add(_logOut, 0, 3);
        return _driving;
    }

    /// <summary>A label that wraps at the window's edge and grows downward:
    /// auto-sized, docked across its 100% column.</summary>
    private static void Style(Label label, float points, Color color, bool bold = false)
    {
        label.AutoSize = true;
        label.Dock = DockStyle.Fill;
        label.Font = new Font("Segoe UI", points, bold ? FontStyle.Bold : FontStyle.Regular);
        label.ForeColor = color;
        label.Margin = new Padding(0);
    }

    private static void StyleButton(Button button, string text, Color back)
    {
        button.Text = text;
        button.AutoSize = true;
        button.Font = new Font("Segoe UI", 18f, FontStyle.Bold);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = back;
        button.ForeColor = Ink;
        button.Padding = new Padding(24, 12, 24, 12);
        button.Margin = new Padding(0, 0, 16, 0);
        button.Cursor = Cursors.Hand;
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
        _notice.Visible = view.Notice is not null;
        _nameShown.Text = $"Name: {view.Name}";
        _nameShown.Visible = view.Step is SignInStep.AskPin or SignInStep.PinRefused or SignInStep.AskNewPin or SignInStep.AskNewPinAgain;

        var choosing = view.Step == SignInStep.AskRacedBefore;
        var refused = view.Step == SignInStep.PinRefused;
        var pin = view.Step is SignInStep.AskPin or SignInStep.AskNewPin or SignInStep.AskNewPinAgain;

        _prompt.Text = view.Step switch
        {
            SignInStep.AskRacedBefore => "Raced here before?",
            SignInStep.AskName => view.Returning ? "Type the name you raced under" : "Type a name for the leaderboard",
            SignInStep.AskPin => "Type your 4-digit PIN",
            SignInStep.PinRefused => "That PIN does not match. Ask staff to reset your PIN, or try a different name.",
            SignInStep.AskNewPin => "Pick a 4-digit PIN and remember it",
            SignInStep.AskNewPinAgain => "Type the same PIN again",
            _ => "",
        };

        _yes.Visible = _no.Visible = choosing;
        _back.Visible = !choosing;
        _back.Text = refused ? "Try a different name" : "Back";
        _input.Parent!.Visible = !choosing && !refused;
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
        }
        AcceptButton = _input.Parent.Visible ? _next : null;
        if (_input.Parent.Visible) _input.Focus();
        else if (choosing) _yes.Focus();
        else _back.Focus();
    }

    private void RenderDriving(WalkUpView view)
    {
        if (view.Driver is not { } driver) return;
        _driverName.Text = driver.DisplayName;
        _welcome.Text = WalkUpRules.Welcome(driver);

        // Rebuilt only when a row changed, so a status tick does not flicker the list.
        var signature = string.Join("|", view.Laps.Select(l => $"{l.EventId}:{l.State}"));
        if (signature == _renderedLaps) return;
        _renderedLaps = signature;
        _laps.BeginUpdate();
        _laps.Items.Clear();
        foreach (var lap in view.Laps)
        {
            var item = new ListViewItem(lap.LapNumber?.ToString() ?? "-");
            item.SubItems.Add(LapTime.Format(lap.LapTimeMs));
            item.SubItems.Add(lap.IncidentDelta?.ToString() ?? "n/a");
            item.SubItems.Add(lap.State == LapRowState.Posted ? "posted" : "queued");
            item.ForeColor = lap.State == LapRowState.Posted ? Green : Muted;
            _laps.Items.Add(item);
        }
        _laps.EndUpdate();
        if (_laps.Items.Count > 0) _laps.EnsureVisible(_laps.Items.Count - 1);
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

    /// <summary>y and n answer "Raced here before?" from the keyboard too, so a
    /// driver with a keyboard in reach never has to find the mouse.</summary>
    private async void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (_renderedStep != SignInStep.AskRacedBefore) return;
        if (e.KeyCode == Keys.Y) { e.Handled = true; await _model.ChooseReturningAsync(true); }
        else if (e.KeyCode == Keys.N) { e.Handled = true; await _model.ChooseReturningAsync(false); }
    }
}
