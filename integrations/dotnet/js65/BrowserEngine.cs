
using System.Dynamic;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(List<List<ExpandoObject>>))]
[JsonSerializable(typeof(List<object>))]
[JsonSerializable(typeof(string[]))]
[JsonSerializable(typeof(byte[]))]
[JsonSerializable(typeof(byte))]
[JsonSerializable(typeof(ushort))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(Dictionary<string, object>[]))]
[JsonSerializable(typeof(Js65Options))]
[JsonSerializable(typeof(Js65Callbacks))]
internal partial class AssmeblerContext : JsonSerializerContext;

[SupportedOSPlatform("browser")]
public partial class BrowserJsEngine(Js65Options? options = null, Js65Callbacks? callbacks = null)
    : Assembler(options, callbacks)
{
    [JSImport("compile", "js65.libassembler.js")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> Compile(string asm, string rom, string options,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> textCallback,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> binaryCallback
    );

    private readonly Task<JSObject> _module = JSHost.ImportAsync("js65.libassembler.js", "js65/libassembler.js");

    public override async Task<byte[]?> Apply(byte[] rom)
    {
        // Import the module and wait for it to finish
        _ = await _module;
        var expando = IntoExpandoObject();
        var modulesJson = JsonSerializer.Serialize(expando, AssmeblerContext.Default.ListListExpandoObject);
        var optsJson = JsonSerializer.Serialize(Options, AssmeblerContext.Default.Js65Options);
        var b64Bytes = Convert.ToBase64String(rom);
        var output = await Compile(modulesJson, b64Bytes, optsJson, 
            (basePath, filePath) => Callbacks?.OnFileReadText?.Invoke(basePath, filePath) ?? "",
            (basePath, filePath) => Convert.ToBase64String(Callbacks?.OnFileReadBinary?.Invoke(basePath, filePath) ?? []));
        return Convert.FromBase64String(output);
    }
}
