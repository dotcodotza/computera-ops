using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace ComputeraOpsInstaller
{
    class Program
    {
        static int Main(string[] args)
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string psScript = Path.Combine(exeDir, "install-computera.ps1");

            if (!File.Exists(psScript))
            {
                Console.Error.WriteLine("Error: install-computera.ps1 not found next to this executable.");
                Console.Error.WriteLine("Expected: " + psScript);
                return 1;
            }

            string psArgs = "-ExecutionPolicy Bypass -File \"" + psScript + "\"";
            if (args.Length > 0)
            {
                psArgs += " " + string.Join(" ", args);
            }

            Console.WriteLine("Computera Ops Installer");
            Console.WriteLine("========================");
            Console.WriteLine("Launching: powershell.exe " + psArgs);
            Console.WriteLine();

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = psArgs,
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = exeDir,
                CreateNoWindow = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false
            };

            try
            {
                using (var process = Process.Start(psi))
                {
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Error launching installer: " + ex.Message);
                return 1;
            }
        }
    }
}
