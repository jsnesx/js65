
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

/// Assembler frontend backed by the Static Hermes (shermes) native build of js65.
/// If you need a smaller but slower engine for desktop, you can use this instead of ClearScript
///
/// Unlike ClearScriptEngine, which hosts V8 in-process, this engine shells out to a
/// standalone js65-hermes executable. The modules/options are serialized to a single JSON
/// envelope, piped to the process' stdin together with the --json flag, and the base64
/// result is read back from stdout.
public partial class HermesEngine : Assembler, IDisposable
{
    private readonly string _executablePath;
    private readonly string _workingDirectory;

    /// Environment variable that, when set to an existing file, overrides executable discovery.
    /// Useful for development against a locally built js65-hermes
    public const string ExecutablePathEnvVar = "JS65_HERMES_PATH";

    public HermesEngine(Js65Options? options = null, string? executablePath = null, string? workingDirectory = null)
        : base(options)
    {
        _executablePath = executablePath ?? ResolveExecutablePath();
        _workingDirectory = workingDirectory ?? Environment.CurrentDirectory;
    }

    public override async Task<Js65CompileResult> Apply(byte[] rom)
    {
        var envelope = BuildCompileRequest(rom);

        var psi = new ProcessStartInfo
        {
            FileName = _executablePath,
            WorkingDirectory = _workingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add("--json");

        using var process = new Process { StartInfo = psi };
        if (!process.Start())
            throw new InvalidOperationException($"Failed to start hermes executable: {_executablePath}");

        // Write the request envelope as UTF-8 to stdin, then close it so the process can proceed.
        // Read stdout/stderr concurrently to avoid pipe-buffer deadlocks on large ROMs.
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await using (var stdin = process.StandardInput)
        {
            await stdin.BaseStream.WriteAsync(Encoding.UTF8.GetBytes(envelope));
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"js65-hermes exited with code {process.ExitCode}.{(stderr.Length > 0 ? $" stderr: {stderr}" : "")}");

        return DecodeResult(stdout.Trim(), stderr);
    }

    // Serialize the modules and options for js65 in the actions list so we don't need to fiddle with
    // compile flags and such
    private string BuildCompileRequest(byte[] rom)
    {
        using var modules = JsonDocument.Parse(SerializeModulesToJson());
        var request = new HermesRequest
        {
            modules = modules.RootElement,
            assemblerOpts = new HermesAssemblerOpts
            {
                includePaths = Options.includePaths,
                lineContinuations = Options.lineContinuations,
                numberSeparators = Options.numberSeperators,
                generateDebugInfo = Options.generateDebugInfo,
            },
            linkerOpts = new HermesLinkerOpts
            {
                baseRom = Convert.ToBase64String(rom),
                debugLevel = Options.debugLevel,
            },
            outputFormat = "binary",
            useSourceContents = Options.generateDebugInfo,
        };
        return JsonSerializer.Serialize(request, HermesJsonContext.Default.HermesRequest);
    }

    private static Js65CompileResult DecodeResult(string base64Stdout, string stderr)
    {
        byte[] jsonBytes;
        try
        {
            jsonBytes = Convert.FromBase64String(base64Stdout);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException(
                $"js65-hermes produced unexpected (non-base64) output.{(stderr.Length > 0 ? $" stderr: {stderr}" : "")}");
        }

        var result = JsonSerializer.Deserialize(jsonBytes, HermesJsonContext.Default.HermesJsonResult)
                     ?? throw new InvalidOperationException("js65-hermes returned an empty result.");

        return new Js65CompileResult
        {
            success = result.success,
            romdata = result.romdata.Length > 0 ? Convert.FromBase64String(result.romdata) : [],
            debugfile = result.debugfile,
            messages = result.messages,
        };
    }

    // Locate the js65 executable in the current path. The user can provide an override with JS65_HERMES_PATH
    // but the default behavior is to check in the current folder.
    private static string ResolveExecutablePath()
    {
        var exeName = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "js65-hermes.exe" : "js65-hermes";

        var overridePath = Environment.GetEnvironmentVariable(ExecutablePathEnvVar);
        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath))
            return overridePath;

        var baseDir = AppContext.BaseDirectory;
        var rid = RuntimeInformation.RuntimeIdentifier;
        var candidates = new[]
        {
            Path.Combine(baseDir, exeName),
            Path.Combine(baseDir, "runtimes", rid, "native", exeName),
        };
        foreach (var candidate in candidates)
            if (File.Exists(candidate))
                return EnsureExecutable(candidate);

        throw new FileNotFoundException(
            $"Could not locate the '{exeName}' native executable for runtime '{rid}'. " +
            $"Searched: {string.Join(", ", candidates)}. " +
            $"Set the {ExecutablePathEnvVar} environment variable to override.");
    }

    // Its possible that the js65-hermes exe is missing the executable bit on Unix. If so, try and make it executable.
    private static string EnsureExecutable(string path)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return path;
        try
        {
            var mode = File.GetUnixFileMode(path);
            File.SetUnixFileMode(path, mode | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute);
        }
        catch
        {
            // Non-fatal error: the file may already be executable, or the FS may not support mode bits.
            // Either way, just try to continue.
        }
        return path;
    }

    public override void Dispose()
    {
        GC.SuppressFinalize(this);
    }

    /// <summary>The request envelope written to the hermes process' stdin in <c>--json</c> mode.</summary>
    private record HermesRequest
    {
        // Pre-serialized action modules (see BuildCompileRequest).
        public JsonElement modules { get; init; }
        public HermesAssemblerOpts assemblerOpts { get; init; } = new();
        public HermesLinkerOpts linkerOpts { get; init; } = new();
        public string outputFormat { get; init; } = "binary";
        public bool useSourceContents { get; init; }
    }

    private record HermesAssemblerOpts
    {
        public IEnumerable<string> includePaths { get; init; } = [];
        public bool lineContinuations { get; init; }
        public bool numberSeparators { get; init; }
        public bool generateDebugInfo { get; init; }
    }

    private record HermesLinkerOpts
    {
        public string baseRom { get; init; } = "";
        public int debugLevel { get; init; }
    }

    private record HermesJsonResult
    {
        public bool success { get; init; }
        public string romdata { get; init; } = "";
        public string debugfile { get; init; } = "";
        public Js65AssemblerMessage[] messages { get; init; } = [];
    }

    [JsonSourceGenerationOptions(WriteIndented = false)]
    [JsonSerializable(typeof(HermesRequest))]
    [JsonSerializable(typeof(HermesJsonResult))]
    private partial class HermesJsonContext : JsonSerializerContext
    {
    }
}
