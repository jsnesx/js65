
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

public record Js65Callbacks
{
    public const string STDIN = "//stdin";
    public const string STDOUT = "//stdout";
    public delegate string FileReadText(string basePath, string file);
    public delegate byte[] FileReadBinary(string basePath, string file);
    public FileReadText? OnFileReadText { get; set; }
    public FileReadBinary? OnFileReadBinary { get; set; }
}

public record Js65Options
{
    public IEnumerable<string> includePaths = new List<string>();
    public bool lineContinuations = false;
    public bool numberSeperators = false;
    public bool generateDebugInfo = true;
    public int debugLevel = 0;
}

/// <summary>
/// Source location information for error messages
/// </summary>
public record Js65SourceInfo
{
    public string? ident { get; init; }
    public string file { get; init; } = "";
    public int line { get; init; }
    public int column { get; init; }
    public Js65SourceInfo? parent { get; init; }
}

/// <summary>
/// An assembler message (error, warning, or info)
/// </summary>
public record Js65AssemblerMessage
{
    /// <summary>
    /// Severity level: "error", "warning", or "info"
    /// </summary>
    public string level { get; init; } = "error";

    /// <summary>
    /// Human-readable message
    /// </summary>
    public string message { get; init; } = "";

    /// <summary>
    /// Source location where message originated (may be null)
    /// </summary>
    public Js65SourceInfo? source { get; init; }

    /// <summary>
    /// JS stack trace when captured (may be null)
    /// </summary>
    public string? stack { get; init; }
}

/// <summary>
/// One named output produced by a compile. <c>type</c> tags the artifact kind:
/// "binary" (linked ROM / IPS), "object" (serialized .o), "debug" (debug info such as
/// MLB labels), "source", and more in future (e.g. "listing").
/// </summary>
public record Js65OutputFile
{
    public string name { get; init; } = "";
    public string type { get; init; } = "binary";
    public byte[] data { get; init; } = [];
}

public record Js65CompileResult
{
    /// <summary>
    /// Whether compilation succeeded (no errors)
    /// </summary>
    public bool success { get; init; }

    /// <summary>
    /// Named outputs produced by the compile. The linked ROM/IPS is a "binary" entry;
    /// debug info ("debug") and serialized .o modules ("object") ride in the same list.
    /// </summary>
    public Js65OutputFile[] outputs { get; init; } = [];

    /// <summary>
    /// Binary output data. Back-compat convenience for the common single-output case;
    /// the first non-debug output's bytes.
    /// </summary>
    public byte[] romdata =>
        Array.Find(outputs, o => o.type != "debug")?.data ?? (outputs.Length > 0 ? outputs[0].data : []);

    /// <summary>
    /// Debug file contents (the "debug"-typed output decoded as UTF-8 text), or "" if none.
    /// </summary>
    public string debugfile =>
        Array.Find(outputs, o => o.type == "debug") is { } d ? System.Text.Encoding.UTF8.GetString(d.data) : "";

    /// <summary>
    /// All messages (errors, warnings, info) from compilation
    /// </summary>
    public Js65AssemblerMessage[] messages { get; init; } = [];
}

/// <summary>
/// One input in the Js65Request. Engines only ever send action-list modules.
/// </summary>
public record Js65ActionsInput
{
    public string type { get; init; } = "actions";
    public List<Dictionary<string, object>> actions { get; init; } = [];
}

public record Js65RequestOptions
{
    public IEnumerable<string> includePaths { get; init; } = [];
    public bool lineContinuations { get; init; }
    public bool numberSeparators { get; init; }
    public bool generateDebugInfo { get; init; }
    public int debugLevel { get; init; }
    public string outputFormat { get; init; } = "binary";
}

/// <summary>
/// The Js65Request data ({ inputs, options })
/// These are the untrusted inputs that are validated before being passed to the
/// js65 compile task.
/// </summary>
public record Js65RequestData
{
    public List<Js65ActionsInput> inputs { get; init; } = [];
    public Js65RequestOptions options { get; init; } = new();
}

public abstract class Assembler(Js65Options? options = null, Js65Callbacks? callbacks = null) : IDisposable
{
    public Js65Options Options = options ?? new Js65Options();
    public Js65Callbacks? Callbacks = callbacks;
    public List<AsmModule> Modules { get; } = new();

    public void Add(AsmModule asmModule)
    {
        Modules.Add(asmModule);
    }

    public AsmModule Module()
    {
        var mod = new AsmModule();
        Add(mod);
        return mod;
    }

    /// <summary>
    /// Assemble and link the added modules against the given base ROM. Pass a
    /// <paramref name="ct"/> to cancel a long compile: cancellation is cooperative (observed at
    /// the assembler's per-line / linker per-chunk boundaries) and surfaces as an
    /// <see cref="OperationCanceledException"/>.
    /// </summary>
    public abstract Task<Js65CompileResult> Apply(byte[] rom, CancellationToken ct = default);

    protected string SerializeModulesToJson()
    {
        var modules = Modules.Select(module => module.Actions).ToList();
        return JsonSerializer.Serialize(modules, Js65JsonContext.Default.ListListDictionaryStringObject);
    }

    protected string BuildRequest()
    {
        var request = new Js65RequestData
        {
            inputs = Modules.Select(module => new Js65ActionsInput { actions = module.Actions }).ToList(),
            options = new Js65RequestOptions
            {
                includePaths = Options.includePaths,
                lineContinuations = Options.lineContinuations,
                numberSeparators = Options.numberSeperators,
                generateDebugInfo = Options.generateDebugInfo,
                debugLevel = Options.debugLevel,
                outputFormat = "binary",
            },
        };
        return JsonSerializer.Serialize(request, Js65JsonContext.Default.Js65RequestData);
    }

    public abstract void Dispose();
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(List<List<Dictionary<string, object>>>))]
[JsonSerializable(typeof(Dictionary<string, object>))]
[JsonSerializable(typeof(Dictionary<string, object>[]))]
[JsonSerializable(typeof(string[]))]
[JsonSerializable(typeof(byte[]))]
[JsonSerializable(typeof(ushort[]))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(ushort))]
[JsonSerializable(typeof(byte))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(Js65SourceInfo))]
[JsonSerializable(typeof(Js65AssemblerMessage))]
[JsonSerializable(typeof(Js65AssemblerMessage[]))]
[JsonSerializable(typeof(Js65OutputFile))]
[JsonSerializable(typeof(Js65OutputFile[]))]
[JsonSerializable(typeof(Js65RequestData))]
public partial class Js65JsonContext : JsonSerializerContext
{
}