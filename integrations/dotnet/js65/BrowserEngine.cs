
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
internal partial class AssmeblerContext : JsonSerializerContext;

[SupportedOSPlatform("browser")]
public partial class BrowserJsEngine : IAsmEngine
{
    [JSImport("compile", "libassembler.js")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> Compile(string asm, string rom);

    private readonly Task<JSObject> module;

    public BrowserJsEngine()
    {
        module = JSHost.ImportAsync("js65.libassembler.js", "js65/libassembler.js");
    }
    
    public async Task<byte[]?> Apply(byte[] rom, Assembler asmModule)
    {
        _ = await module;
        var expando = asmModule.AsExpando();
        var json = JsonSerializer.Serialize(expando, AssmeblerContext.Default.ListListExpandoObject);
        var b64Bytes = Convert.ToBase64String(rom);
        var output = await Compile(json, b64Bytes);
        return Convert.FromBase64String(output);
    }
}
