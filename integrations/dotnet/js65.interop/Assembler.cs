
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

public record Js65CompileResult
{
    /// <summary>
    /// Whether compilation succeeded (no errors)
    /// </summary>
    public bool success { get; init; }

    /// <summary>
    /// Binary output data
    /// </summary>
    public byte[] romdata { get; init; } = [];

    /// <summary>
    /// Debug file contents
    /// </summary>
    public string debugfile { get; init; } = "";

    /// <summary>
    /// All messages (errors, warnings, info) from compilation
    /// </summary>
    public Js65AssemblerMessage[] messages { get; init; } = [];
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

    public abstract Task<Js65CompileResult> Apply(byte[] rom);

    protected string SerializeModulesToJson()
    {
        var modules = Modules.Select(module => module.Actions).ToList();
        return JsonSerializer.Serialize(modules, Js65JsonContext.Default.ListListDictionaryStringObject);
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
public partial class Js65JsonContext : JsonSerializerContext
{
}