// AirDeck für Windows: ein Programm, ein Fenster. Ein zweiter Start holt nur das vorhandene Fenster nach vorn.
//   AirDeck.exe              Studio öffnen (startet die Engine bei Bedarf)
//   AirDeck.exe --minimized  nur im Infobereich starten (Autostart bei der Anmeldung)
using System;
using System.Threading;
using System.Windows.Forms;

namespace AirDeck
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // AirDeck.exe --quit: laufendes Fenster schließen, Engine weiterlaufen lassen (z. B. vor einem Update)
            if (Array.Exists(args, a => a.Equals("--quit", StringComparison.OrdinalIgnoreCase)))
            {
                if (EventWaitHandle.TryOpenExisting("AirDeck.Studio.Quit", out var quit)) using (quit) quit.Set();
                return;
            }
            using (var mutex = new Mutex(true, "AirDeck.Studio.Window", out var first))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "AirDeck.Studio.Show"))
            {
                if (!first)
                {
                    show.Set();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (!Engine.Installed)
                {
                    MessageBox.Show("Die AirDeck-Engine (airdeck-engine.exe) fehlt im Programmordner. Bitte AirDeck neu installieren.", "AirDeck", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                var minimized = Array.Exists(args, a => a.Equals("--minimized", StringComparison.OrdinalIgnoreCase));
                Application.Run(new MainForm(show, minimized));
                GC.KeepAlive(mutex);
            }
        }
    }
}
