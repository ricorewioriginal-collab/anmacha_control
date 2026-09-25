// Verbindung zur AirDeck-Engine (airdeck-engine.exe im selben Ordner): Adresse erfragen, starten, beenden.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;

namespace AirDeck
{
    sealed class EngineInfo
    {
        public string Url;
        public string Health;
        public string Log;
        public bool Running;
    }

    static class Engine
    {
        public static readonly string Dir = AppDomain.CurrentDomain.BaseDirectory;
        public static readonly string Exe = Path.Combine(Dir, "airdeck-engine.exe");

        public static bool Installed => File.Exists(Exe);

        /// <summary>Programm unsichtbar ausführen und die Ausgabe einsammeln.</summary>
        static int Run(string args, int timeoutMs, out string stdout)
        {
            var psi = new ProcessStartInfo(Exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Dir,
            };
            using (var p = Process.Start(psi))
            {
                var err = p.StandardError.ReadToEndAsync();
                var outTask = p.StandardOutput.ReadToEndAsync();
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    stdout = "";
                    return -1;
                }
                stdout = outTask.Result;
                return p.ExitCode;
            }
        }

        /// <summary>Adresse (mit Zugangstoken für diesen PC), Protokolldatei und ob die Engine läuft.</summary>
        public static EngineInfo Query()
        {
            Run("--print-url", 20000, out var text);
            var line = text.Trim();
            return new EngineInfo
            {
                Url = Field(line, "url"),
                Health = Field(line, "health"),
                Log = Field(line, "log"),
                Running = Regex.IsMatch(line, "\"running\"\\s*:\\s*true"),
            };
        }

        /// <summary>Einfaches Auslesen eines Textfelds aus der einzeiligen JSON-Antwort der Engine.</summary>
        static string Field(string json, string name)
        {
            var m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : "";
        }

        /// <summary>Engine im Hintergrund starten (ohne eigenes Fenster und ohne eigenes Tray-Symbol).</summary>
        public static void Start()
        {
            var psi = new ProcessStartInfo(Exe, "--shell")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Dir,
            };
            Process.Start(psi)?.Dispose();
        }

        /// <summary>Antwortet die Engine? (Gesundheitsabfrage ohne Anmeldung)</summary>
        public static bool Alive(string healthUrl)
        {
            if (string.IsNullOrEmpty(healthUrl)) return false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(healthUrl);
                req.Timeout = 2500;
                req.Proxy = null;
                using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode < 500;
            }
            catch (WebException e) when (e.Response is HttpWebResponse r)
            {
                // erreichbar, aber z. B. Datenbank noch nicht bereit
                return (int)r.StatusCode < 500;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Warten, bis die Engine antwortet.</summary>
        public static bool WaitAlive(string healthUrl, int timeoutMs)
        {
            var end = Environment.TickCount + timeoutMs;
            while (Environment.TickCount < end)
            {
                if (Alive(healthUrl)) return true;
                Thread.Sleep(300);
            }
            return false;
        }

        /// <summary>Engine sauber beenden (Automation und Streams stoppen).</summary>
        public static void Stop()
        {
            try { Run("--stop", 15000, out _); } catch { }
        }
    }
}
