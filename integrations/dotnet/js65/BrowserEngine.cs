
using System.Dynamic;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(Js65Options))]
[JsonSerializable(typeof(Js65Callbacks))]
[JsonSerializable(typeof(Js65CompileResult))]
internal partial class AssmeblerContext : JsonSerializerContext;

[SupportedOSPlatform("browser")]
public partial class BrowserJsEngine(Js65Options? options = null, Js65Callbacks? callbacks = null)
    : Assembler(options, callbacks)
{
    [JSImport("compileActionsBrowser", "js65.libassembler.js")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> CompileActionsBrowser(
        string modulesJson,
        string assemblerOptsJson,
        string linkerOptsJson,
        string outputFormat,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> textCallback,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> binaryCallback,
        bool useSourceContents
    );

    private readonly Task<JSObject> _module = JSHost.ImportAsync("js65.libassembler.js", "js65/libassembler.js");

    public override async Task<Js65CompileResult?> Apply(byte[] rom)
    {
        // Import the module and wait for it to finish
        _ = await _module;

        var modulesJson = SerializeModulesToJson();

        // Construct assembler options
        var assemblerOpts = new
        {
            includePaths = Options.includePaths,
            lineContinuations = Options.lineContinuations,
            numberSeparators = Options.numberSeperators,
            generateDebugInfo = Options.generateDebugInfo
        };
        var assemblerOptsJson = JsonSerializer.Serialize(assemblerOpts);

        // Construct linker options
        var linkerOpts = new
        {
            baseRom = Convert.ToBase64String(rom),
            debugLevel = Options.debugLevel
        };
        var linkerOptsJson = JsonSerializer.Serialize(linkerOpts);

        var output = await CompileActionsBrowser(
            modulesJson,
            assemblerOptsJson,
            linkerOptsJson,
            "binary",
            (basePath, filePath) => Callbacks?.OnFileReadText?.Invoke(basePath, filePath) ?? "",
            (basePath, filePath) => Convert.ToBase64String(Callbacks?.OnFileReadBinary?.Invoke(basePath, filePath) ?? []),
            Options.generateDebugInfo
        );

        return JsonSerializer.Deserialize(Convert.FromBase64String(output), AssmeblerContext.Default.Js65CompileResult);
    }

    public override void Dispose()
    {
        // Unused
    }
}
