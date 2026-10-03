using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Reflection;
using System.Runtime.InteropServices;

namespace OasisRigAgent.Windows;

/// <summary>
/// The venue's look for the sign-in window, so the rig matches the wall and
/// the website: the colours are the tokens in apps/web/src/app/globals.css by
/// their names there, the type is the site's own faces (Orbitron for display,
/// Rajdhani for text, a monospace for lap times as the `.laptime` rule has it)
/// and the mark is the helmet the TV boards and the check-in page draw.
///
/// The faces travel inside the exe as embedded resources (Google Fonts' static
/// TTFs; SIL Open Font License, texts beside them in Windows/Assets) and are
/// registered once, at first use, two ways from the same bytes: into a GDI+
/// <see cref="PrivateFontCollection"/>, which is where <see cref="Font"/>
/// resolves a family, and into GDI with AddFontMemResourceEx, which is what
/// actually draws WinForms text (TextRenderer, and the native TextBox, Button
/// and ListView) and would otherwise not find a face GDI+ alone knows. Both
/// are process-private: nothing is installed on the rig PC. Loading three
/// small files once costs nothing iRacing would notice. If a resource is
/// missing or Windows refuses it, every lookup falls back to Segoe UI (and
/// Consolas for times), which ships with Windows; <see cref="FontsLoaded"/>
/// says which happened, for the window's log line.
/// </summary>
internal static class Brand
{
    // --bg, --surface, --raised, --edge, --ink, --muted, --accent, --accent-2,
    // --purple, --sunset, --valid, --invalid, --gold in globals.css.
    public static readonly Color Bg = Hex(0x0a0a14);
    public static readonly Color Surface = Hex(0x12121f);
    public static readonly Color Raised = Hex(0x1a1a2e);
    public static readonly Color Edge = Hex(0x2a2a44);
    public static readonly Color Ink = Hex(0xf2f2fa);
    public static readonly Color Muted = Hex(0x9494ad);
    public static readonly Color Accent = Hex(0x5ce1e6);
    public static readonly Color Accent2 = Hex(0xff3ec8);
    public static readonly Color Purple = Hex(0x8b5cf6);
    public static readonly Color Sunset = Hex(0xff8a3d);
    public static readonly Color Valid = Hex(0x2bcc6c);
    public static readonly Color Invalid = Hex(0xff453a);
    public static readonly Color Gold = Hex(0xffd60a);

    private const string DisplayFace = "Orbitron";
    private const string BodyFace = "Rajdhani Medium";
    private const string BodyBoldFace = "Rajdhani";
    private const string FallbackFace = "Segoe UI";
    private const string MonoFace = "Consolas";

    private static readonly PrivateFontCollection Collection = new();
    // The font bytes stay pinned for the life of the process: GDI reads them
    // from where they were registered.
    private static readonly List<GCHandle> Pinned = new();
    private static readonly FontFamily? Display;
    private static readonly FontFamily? Body;
    private static readonly FontFamily? BodyBold;

    /// <summary>True when all three brand faces registered.</summary>
    public static bool FontsLoaded => Display is not null && Body is not null && BodyBold is not null;

    /// <summary>The helmet mark, or null when the resource is missing.</summary>
    public static Image? Helmet { get; }

    static Brand()
    {
        foreach (var file in new[] { "Orbitron-Bold.ttf", "Rajdhani-Medium.ttf", "Rajdhani-Bold.ttf" })
            RegisterFont(file);
        Display = Family(DisplayFace);
        Body = Family(BodyFace);
        BodyBold = Family(BodyBoldFace);
        Helmet = LoadImage("oasis-helmet.png");
    }

    /// <summary>Orbitron Bold: headings, the rig number, the driver's name, a
    /// place on the board. The site's `font-display`.</summary>
    public static Font DisplayFont(float points) => Make(Display, FontStyle.Bold, points);

    /// <summary>Rajdhani Medium: prompts, notices, the lap list, the log. The
    /// site's body face.</summary>
    public static Font BodyFont(float points) => Make(Body, FontStyle.Regular, points);

    /// <summary>Rajdhani Bold: the prompt line and button labels.</summary>
    public static Font BodyBoldFont(float points) => Make(BodyBold, FontStyle.Bold, points);

    /// <summary>Tabular digits for lap times, as the site's `.laptime` rule.</summary>
    public static Font MonoFont(float points)
    {
        try { return new Font(MonoFace, points, FontStyle.Bold, GraphicsUnit.Point); }
        catch (ArgumentException) { return new Font(FontFamily.GenericMonospace, points, FontStyle.Bold, GraphicsUnit.Point); }
    }

    /// <summary>The site's `.gradient-rule`: cyan through purple to pink,
    /// left to right across <paramref name="bounds"/>.</summary>
    public static LinearGradientBrush GradientRule(Rectangle bounds)
    {
        var brush = new LinearGradientBrush(bounds, Accent, Accent2, LinearGradientMode.Horizontal);
        brush.InterpolationColors = new ColorBlend
        {
            Colors = new[] { Accent, Purple, Accent2 },
            Positions = new[] { 0f, 0.5f, 1f },
        };
        return brush;
    }

    private static Font Make(FontFamily? family, FontStyle style, float points)
    {
        if (family is not null && family.IsStyleAvailable(style))
            return new Font(family, points, style, GraphicsUnit.Point);
        return new Font(FallbackFace, points, style, GraphicsUnit.Point);
    }

    private static FontFamily? Family(string name) =>
        Collection.Families.FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));

    private static void RegisterFont(string file)
    {
        var bytes = Resource(file);
        if (bytes is null) return;
        var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        Pinned.Add(handle);
        var address = handle.AddrOfPinnedObject();
        try
        {
            Collection.AddMemoryFont(address, bytes.Length);
            AddFontMemResourceEx(address, (uint)bytes.Length, IntPtr.Zero, out _);
        }
        catch (Exception)
        {
            // A face Windows will not take is simply not used: the fallbacks
            // above draw the same screens in Segoe UI.
        }
    }

    private static Image? LoadImage(string file)
    {
        var bytes = Resource(file);
        if (bytes is null) return null;
        try
        {
            // Copied out of the stream so the stream need not outlive it.
            using var stream = new MemoryStream(bytes);
            using var decoded = Image.FromStream(stream);
            return new Bitmap(decoded);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static byte[]? Resource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream is null) return null;
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    private static Color Hex(int rgb) => Color.FromArgb((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);

    [DllImport("gdi32.dll", ExactSpelling = true)]
    private static extern IntPtr AddFontMemResourceEx(IntPtr font, uint length, IntPtr reserved, out uint installed);
}
