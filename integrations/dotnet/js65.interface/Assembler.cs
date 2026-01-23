
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

public record Js65CompileResult
{
    public byte[] romdata;
    public string debugfile;
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

    public abstract Task<Js65CompileResult?> Apply(byte[] rom);

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
internal partial class Js65JsonContext : JsonSerializerContext
{
}