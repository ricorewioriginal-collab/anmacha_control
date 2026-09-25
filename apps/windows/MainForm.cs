// Hauptfenster: Studio in eingebettetem WebView2, Symbol im Infobereich, Überwachung der Engine.
// Schließen versteckt das Fenster nur – die Engine sendet weiter. Beenden gibt es im Menü des Symbols.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AirDeck
{
    sealed class MainForm : Form
    {
        static readonly Color Back = Color.FromArgb(11, 18, 32);
        static readonly string LocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AirDeck");
        static readonly string BoundsFile = Path.Combine(LocalDir, "fenster.txt");

        readonly EventWaitHandle showSignal;
        readonly EventWaitHandle quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "AirDeck.Studio.Quit");
        readonly bool startHidden;
        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Back };
        readonly Label splash = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.FromArgb(160, 180, 210), BackColor = Back, Font = new Font("Segoe UI", 13f), Text = "AirDeck startet …" };
        readonly NotifyIcon tray = new NotifyIcon();
        readonly System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer { Interval = 3000 };
        EngineInfo engine;
        Uri origin;
        bool quitting;
        bool hintShown;
        int downChecks;

        public MainForm(EventWaitHandle show, bool minimized)
        {
            showSignal = show;
            startHidden = minimized;
            Text = "AirDeck";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Back;
            MinimumSize = new Size(960, 600);
            StartPosition = FormStartPosition.Manual;
            LoadBounds();
            Controls.Add(web);
            Controls.Add(splash);
            splash.BringToFront();

            tray.Icon = Icon;
            tray.Text = "AirDeck";
            var menu = new ContextMenuStrip();
            menu.Items.Add("Studio öffnen", null, (s, e) => ShowStudio());
            menu.Items.Add("Protokoll anzeigen", null, (s, e) => OpenLog());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("AirDeck beenden", null, (s, e) => Quit(true));
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => ShowStudio();
            tray.Visible = true;

            watch.Tick += (s, e) => CheckEngine();

            // zweiter Programmstart: vorhandenes Fenster nach vorn holen
            var t = new Thread(() =>
            {
                while (true)
                {
                    showSignal.WaitOne();
                    try { BeginInvoke((Action)ShowStudio); } catch (InvalidOperationException) { return; }
                }
            }) { IsBackground = true, Name = "AirDeck.Show" };
            t.Start();
            // AirDeck.exe --quit (Update): nur das Fenster schließen, die Engine sendet weiter
            new Thread(() =>
            {
                quitSignal.WaitOne();
                try { BeginInvoke((Action)(() => CloseWindowOnly())); } catch (InvalidOperationException) { }
            }) { IsBackground = true, Name = "AirDeck.Quit" }.Start();
        }

        protected override void SetVisibleCore(bool value)
        {
            // Autostart: nur Symbol im Infobereich, Fenster erst auf Wunsch
            if (startHidden && !IsHandleCreated)
            {
                CreateHandle();
                value = false;
                _ = Connect();
            }
            base.SetVisibleCore(value);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            await Connect();
        }

        Task connecting;

        Task Connect() => connecting ?? (connecting = ConnectCore());

        async Task ConnectCore()
        {
            engine = await Task.Run(() =>
            {
                var info = Engine.Query();
                if (info.Running && Engine.Alive(info.Health)) return info;
                Engine.Start();
                // die Engine legt beim ersten Start Datenbank und Zugang an – etwas Geduld
                Engine.WaitAlive(info.Health, 90000);
                return Engine.Query();
            });
            if (string.IsNullOrEmpty(engine.Url) || !Engine.Alive(engine.Health))
            {
                var r = MessageBox.Show(this, "Die AirDeck-Engine startet nicht.\n\nProtokoll öffnen?", "AirDeck", MessageBoxButtons.YesNo, MessageBoxIcon.Error);
                if (r == DialogResult.Yes) OpenLog();
                Quit(false);
                return;
            }
            origin = new Uri(engine.Url);
            tray.Text = "AirDeck läuft";
            try
            {
                Directory.CreateDirectory(LocalDir);
                var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(LocalDir, "WebView2"), options);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                var r = MessageBox.Show(this, "Für das AirDeck-Fenster fehlt die Microsoft-WebView2-Laufzeit (bei Windows 11 vorinstalliert).\n\nJetzt herunterladen?", "AirDeck", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Quit(false);
                return;
            }
            Setup(web.CoreWebView2);
            web.CoreWebView2.Navigate(engine.Url);
            watch.Start();
        }

        void Setup(CoreWebView2 core)
        {
            var s = core.Settings;
            // fühlt sich wie ein Programm an, nicht wie ein Browser
            s.AreDevToolsEnabled = Environment.GetEnvironmentVariable("AIRDECK_DEVTOOLS") == "1";
            s.IsStatusBarEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;

            core.NavigationCompleted += (o, e) =>
            {
                if (splash.Visible) splash.Visible = false;
            };
            // Mikrofon, Autoplay und Benachrichtigungen für das eigene Studio ohne Nachfrage
            core.PermissionRequested += (o, e) =>
            {
                if (Own(e.Uri)) e.State = CoreWebView2PermissionState.Allow;
            };
            // Links nach draußen im Standardbrowser, laut.fm-Anmeldung im Fenster (kommt danach zurück)
            core.NavigationStarting += (o, e) =>
            {
                if (Own(e.Uri) || LautFm(e.Uri) || e.Uri.StartsWith("about:", StringComparison.Ordinal)) return;
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
            core.NewWindowRequested += (o, e) =>
            {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            // Kontextmenü nur dort, wo man Text bearbeitet (Kopieren/Einfügen)
            core.ContextMenuRequested += (o, e) =>
            {
                if (!e.ContextMenuTarget.IsEditable) e.Handled = true;
            };
            // Befehle aus dem Studio (z. B. „AirDeck beenden“)
            core.WebMessageReceived += (o, e) =>
            {
                string msg;
                try { msg = e.TryGetWebMessageAsString(); } catch { return; }
                if (msg == "quit") Quit(false);
                else if (msg == "hide") Hide();
            };
            core.ProcessFailed += (o, e) =>
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) return;
                core.Reload();
            };
        }

        bool Own(string uri)
        {
            return origin != null && Uri.TryCreate(uri, UriKind.Absolute, out var u)
                && u.Scheme == origin.Scheme && u.Host == origin.Host && u.Port == origin.Port;
        }

        static bool LautFm(string uri)
        {
            return Uri.TryCreate(uri, UriKind.Absolute, out var u) && u.Scheme == "https"
                && (u.Host == "laut.fm" || u.Host.EndsWith(".laut.fm", StringComparison.OrdinalIgnoreCase));
        }

        static void OpenExternal(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "mailto")) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }

        void OpenLog()
        {
            var log = engine?.Log;
            if (string.IsNullOrEmpty(log) || !File.Exists(log)) log = Engine.Query().Log;
            if (!string.IsNullOrEmpty(log) && File.Exists(log)) Process.Start(new ProcessStartInfo("notepad.exe", "\"" + log + "\"") { UseShellExecute = true });
        }

        /// <summary>Engine überwachen: nach einem Neustart (z. B. Setup-Assistent) neu verbinden, bei Ausfall nachfragen.</summary>
        async void CheckEngine()
        {
            if (quitting || engine == null) return;
            var alive = await Task.Run(() => Engine.Alive(engine.Health));
            if (alive)
            {
                downChecks = 0;
                return;
            }
            // ein Neustart der Engine dauert ein paar Sekunden
            if (++downChecks < 8) return;
            watch.Stop();
            ShowStudio();
            var r = MessageBox.Show(this, "Die AirDeck-Engine läuft nicht mehr.\n\nJetzt neu starten?", "AirDeck", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r != DialogResult.Yes)
            {
                Quit(false);
                return;
            }
            downChecks = 0;
            await Task.Run(() =>
            {
                Engine.Start();
                Engine.WaitAlive(engine.Health, 90000);
            });
            engine = await Task.Run(() => Engine.Query());
            web.CoreWebView2?.Navigate(engine.Url);
            watch.Start();
        }

        void ShowStudio()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            _ = Connect();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveBounds();
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                // Fenster zu, Sendung läuft weiter
                e.Cancel = true;
                Hide();
                if (!hintShown)
                {
                    hintShown = true;
                    tray.ShowBalloonTip(4000, "AirDeck läuft weiter", "Automation und Streams laufen im Hintergrund. Beenden über das Symbol im Infobereich.", ToolTipIcon.Info);
                }
                return;
            }
            base.OnFormClosing(e);
        }

        /// <summary>Programm beenden. stopEngine: auch die Engine (Automation, Streams) anhalten.</summary>
        void Quit(bool ask)
        {
            if (quitting) return;
            if (ask && MessageBox.Show(this, "AirDeck komplett beenden? Automation und alle Streams stoppen.", "AirDeck", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            quitting = true;
            watch.Stop();
            SaveBounds();
            tray.Text = "AirDeck wird beendet …";
            Task.Run(() => Engine.Stop()).ContinueWith(_ => BeginInvoke((Action)(() =>
            {
                tray.Visible = false;
                tray.Dispose();
                Application.Exit();
            })));
        }

        void CloseWindowOnly()
        {
            quitting = true;
            watch.Stop();
            SaveBounds();
            tray.Visible = false;
            tray.Dispose();
            Application.Exit();
        }

        void LoadBounds()
        {
            Size = new Size(1440, 900);
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Left + Math.Max(0, (wa.Width - Width) / 2), wa.Top + Math.Max(0, (wa.Height - Height) / 2));
            try
            {
                var p = File.ReadAllText(BoundsFile).Split(',');
                var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                // nur übernehmen, wenn das Fenster auf einem vorhandenen Bildschirm liegt
                if (Array.Exists(Screen.AllScreens, sc => sc.WorkingArea.IntersectsWith(r)))
                {
                    Bounds = r;
                    if (p.Length > 4 && p[4] == "max") WindowState = FormWindowState.Maximized;
                }
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                Directory.CreateDirectory(LocalDir);
                File.WriteAllText(BoundsFile, $"{r.X},{r.Y},{r.Width},{r.Height},{(WindowState == FormWindowState.Maximized ? "max" : "normal")}");
            }
            catch { }
        }
    }
}
