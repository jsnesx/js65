using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

// Browser-specific source info for JSON deserialization
internal class BrowserSourceInfo
{
    [JsonPropertyName("ident")]
    public string? Ident { get; set; }

    [JsonPropertyName("file")]
    public string File { get; set; } = "";

    [JsonPropertyName("line")]
    public int Line { get; set; }

    [JsonPropertyName("column")]
    public int Column { get; set; }

    [JsonPropertyName("parent")]
    public BrowserSourceInfo? Parent { get; set; }
}

// Browser-specific assembler message for JSON deserialization
internal class BrowserAssemblerMessage
{
    [JsonPropertyName("level")]
    public string Level { get; set; } = "error";

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("source")]
    public BrowserSourceInfo? Source { get; set; }

    [JsonPropertyName("stack")]
    public string? Stack { get; set; }
}

// Browser-specific output file for JSON deserialization (data is base64-encoded: the
// result is an async JSImport return, where binary can only marshal as a boxed number
// array, so a base64 blob is the pragmatic transport).
internal class BrowserOutputFile
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "binary";

    [JsonPropertyName("data")]
    public string Data { get; set; } = "";
}

// Browser-specific result class that matches compileBrowser's JSON output (base64 strings).
internal class BrowserCompileResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("outputs")]
    public BrowserOutputFile[] Outputs { get; set; } = [];

    [JsonPropertyName("messages")]
    public BrowserAssemblerMessage[] Messages { get; set; } = [];
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(Js65Options))]
[JsonSerializable(typeof(Js65Callbacks))]
[JsonSerializable(typeof(Js65CompileResult))]
[JsonSerializable(typeof(BrowserOutputFile))]
[JsonSerializable(typeof(BrowserCompileResult))]
[JsonSerializable(typeof(BrowserSourceInfo))]
[JsonSerializable(typeof(BrowserAssemblerMessage))]
[JsonSerializable(typeof(BrowserAssemblerMessage[]))]
internal partial class AssmeblerContext : JsonSerializerContext;

/// <summary>
/// Configuration for JavaScript file reading callbacks.
/// Used to dynamically import a JS module and call its functions for file loading.
/// </summary>
public class JsFileCallbackConfig
{
    /// <summary>
    /// The path to the JavaScript module (e.g., "./main.js" or "my-module")
    /// </summary>
    public required string ModulePath { get; init; }

    /// <summary>
    /// Name of the function to call for reading text files.
    /// Function signature: (path: string) => string
    /// </summary>
    public string ReadTextFuncName { get; init; } = "readFileAsTextSync";

    /// <summary>
    /// Name of the function to call for reading binary files.
    /// Function signature: (path: string) => string (base64 encoded)
    /// </summary>
    public string ReadBinaryFuncName { get; init; } = "readFileAsBinarySync";
}

[SupportedOSPlatform("browser")]
public partial class BrowserJsEngine : Assembler
{
    // Calls libassembler's compileBrowser. We have this strange entrypoint because of the JsInterop
    // restrictions which prevent us from marshalling a raw list of bytes, so we work around it
    // by stringifying pretty much everything.
    [JSImport("compileBrowser", "js65.interop.libassembler.js")]
    [return: JSMarshalAs<JSType.Promise<JSType.String>>]
    private static partial Task<string> CompileBrowser(
        string requestJson,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> textCallback,
        [JSMarshalAs<JSType.Function<JSType.String,JSType.String,JSType.String>>]
        Func<string, string, string> binaryCallback,
        [JSMarshalAs<JSType.Array<JSType.Number>>]
        byte[] baseRom,
        // Polled by the core for cooperative cancellation. Best-effort under single-threaded
        // WASM: the token only flips while .NET runs, so cancellation is observed at the
        // file-callback await boundaries rather than mid pure-compute.
        [JSMarshalAs<JSType.Function<JSType.Boolean>>]
        Func<bool> shouldCancel
    );

    // Interop helper for dynamic module imports
    [JSImport("importModule", "js65.interop.js")]
    [return: JSMarshalAs<JSType.Promise<JSType.Object>>]
    private static partial Task<JSObject> ImportModule(string modulePath);

    [JSImport("callModuleFunction", "js65.interop.js")]
    private static partial string CallModuleFunction(JSObject module, string funcName, string arg1, string arg2);

    private readonly Task<JSObject> _module;
    private readonly Task<JSObject> _interopModule;
    private readonly JsFileCallbackConfig? _fileCallbackConfig;
    private JSObject? _fileCallbackModule;

    /// <summary>
    /// Creates a new BrowserJsEngine with optional file callback configuration.
    /// </summary>
    /// <param name="options">Assembler options</param>
    /// <param name="callbacks">C# callbacks for file reading (takes precedence over JS callbacks)</param>
    /// <param name="fileCallbackConfig">Configuration for JavaScript file reading callbacks</param>
    public BrowserJsEngine(
        Js65Options? options = null,
        Js65Callbacks? callbacks = null,
        JsFileCallbackConfig? fileCallbackConfig = null)
        : base(options, callbacks)
    {
        _fileCallbackConfig = fileCallbackConfig;
        // Paths are relative to _framework directory, so use ../ to reach the app root
        _module = JSHost.ImportAsync("js65.interop.libassembler.js", "../js65/libassembler.js");
        _interopModule = JSHost.ImportAsync("js65.interop.js", "../js65/interop.js");
    }

    public override async Task<Js65CompileResult> Apply(byte[] rom, CancellationToken ct = default)
    {
        // Import required modules
        _ = await _module;
        _ = await _interopModule;

        // If file callback config is provided, import that module too
        if (_fileCallbackConfig != null && _fileCallbackModule == null)
        {
            _fileCallbackModule = await ImportModule(_fileCallbackConfig.ModulePath);
        }

        var requestJson = BuildRequest();

        // The base ROM crosses as a proper binary byte[] param; the result returns as a
        // base64-encoded JSON string (see CompileBrowser for why these two differ).
        var output = await CompileBrowser(
            requestJson,
            LoadTextFileCallback,
            LoadBinaryFileCallback,
            rom,
            () => ct.IsCancellationRequested
        );

        // A cancelled compile returns a clean failure result; surface the .NET cancellation
        // signal to the caller instead.
        ct.ThrowIfCancellationRequested();

        var browserResult = JsonSerializer.Deserialize(Convert.FromBase64String(output), AssmeblerContext.Default.BrowserCompileResult);
        if (browserResult == null)
        {
            return new Js65CompileResult
            {
                success = false
            };
        }

        return new Js65CompileResult
        {
            success = browserResult.Success,
            outputs = browserResult.Outputs.Select(o => new Js65OutputFile
            {
                name = o.Name,
                type = o.Type,
                data = Convert.FromBase64String(o.Data),
            }).ToArray(),
            messages = ConvertMessages(browserResult.Messages)
        };
    }

    private static Js65AssemblerMessage[] ConvertMessages(BrowserAssemblerMessage[] browserMessages)
    {
        return browserMessages.Select(m => new Js65AssemblerMessage
        {
            level = m.Level,
            message = m.Message,
            source = ConvertSourceInfo(m.Source),
            stack = m.Stack
        }).ToArray();
    }

    private static Js65SourceInfo? ConvertSourceInfo(BrowserSourceInfo? source)
    {
        if (source == null) return null;
        return new Js65SourceInfo
        {
            ident = source.Ident,
            file = source.File,
            line = source.Line,
            column = source.Column,
            parent = ConvertSourceInfo(source.Parent)
        };
    }

    private string LoadTextFileCallback(string basePath, string filePath)
    {
        // C# callbacks take precedence
        if (Callbacks?.OnFileReadText != null)
        {
            return Callbacks.OnFileReadText.Invoke(basePath, filePath);
        }

        // Fall back to JS module callback if configured
        if (_fileCallbackModule != null && _fileCallbackConfig != null)
        {
            var fullPath = CombinePath(basePath, filePath);
            return CallModuleFunction(_fileCallbackModule, _fileCallbackConfig.ReadTextFuncName, fullPath, "");
        }

        return "";
    }

    // Returns base64: this is a JSImport delegate callback, and .NET WASM cannot marshal
    // arrays through callbacks, so include bytes have to cross as a string.
    private string LoadBinaryFileCallback(string basePath, string filePath)
    {
        // C# callbacks take precedence
        if (Callbacks?.OnFileReadBinary != null)
        {
            return Convert.ToBase64String(Callbacks.OnFileReadBinary.Invoke(basePath, filePath));
        }

        // Fall back to JS module callback if configured (also returns base64).
        if (_fileCallbackModule != null && _fileCallbackConfig != null)
        {
            var fullPath = CombinePath(basePath, filePath);
            return CallModuleFunction(_fileCallbackModule, _fileCallbackConfig.ReadBinaryFuncName, fullPath, "");
        }

        return "";
    }

    private static string CombinePath(string basePath, string filePath)
    {
        if (string.IsNullOrEmpty(basePath) || basePath == "./")
        {
            return filePath;
        }
        return $"{basePath.TrimEnd('/')}/{filePath}";
    }

    public override void Dispose()
    {
        _fileCallbackModule?.Dispose();
    }
}
