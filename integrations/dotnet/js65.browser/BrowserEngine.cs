using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace js65;

internal class BrowserAssemblerOptions
{
    [JsonPropertyName("includePaths")]
    public string[] IncludePaths { get; set; } = [];

    [JsonPropertyName("lineContinuations")]
    public bool LineContinuations { get; set; }

    [JsonPropertyName("numberSeparators")]
    public bool NumberSeparators { get; set; }

    [JsonPropertyName("generateDebugInfo")]
    public bool GenerateDebugInfo { get; set; }
}

internal class BrowserLinkerOptions
{
    [JsonPropertyName("baseRom")]
    public string BaseRom { get; set; } = "";

    [JsonPropertyName("debugLevel")]
    public int DebugLevel { get; set; }
}

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

// Browser-specific result class that matches the JS output (base64 strings)
internal class BrowserCompileResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("romdata")]
    public string Romdata { get; set; } = "";

    [JsonPropertyName("debugfile")]
    public string Debugfile { get; set; } = "";

    [JsonPropertyName("messages")]
    public BrowserAssemblerMessage[] Messages { get; set; } = [];
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(Js65Options))]
[JsonSerializable(typeof(Js65Callbacks))]
[JsonSerializable(typeof(Js65CompileResult))]
[JsonSerializable(typeof(BrowserAssemblerOptions))]
[JsonSerializable(typeof(BrowserLinkerOptions))]
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
    [JSImport("compileActionsBrowser", "js65.interop.libassembler.js")]
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

    public override async Task<Js65CompileResult> Apply(byte[] rom)
    {
        // Import required modules
        _ = await _module;
        _ = await _interopModule;

        // If file callback config is provided, import that module too
        if (_fileCallbackConfig != null && _fileCallbackModule == null)
        {
            _fileCallbackModule = await ImportModule(_fileCallbackConfig.ModulePath);
        }

        var modulesJson = SerializeModulesToJson();

        // Construct assembler options
        var assemblerOpts = new BrowserAssemblerOptions
        {
            IncludePaths = Options.includePaths.ToArray(),
            LineContinuations = Options.lineContinuations,
            NumberSeparators = Options.numberSeperators,
            GenerateDebugInfo = Options.generateDebugInfo
        };
        var assemblerOptsJson = JsonSerializer.Serialize(assemblerOpts, AssmeblerContext.Default.BrowserAssemblerOptions);

        // Construct linker options
        var linkerOpts = new BrowserLinkerOptions
        {
            BaseRom = Convert.ToBase64String(rom),
            DebugLevel = Options.debugLevel
        };
        var linkerOptsJson = JsonSerializer.Serialize(linkerOpts, AssmeblerContext.Default.BrowserLinkerOptions);

        var output = await CompileActionsBrowser(
            modulesJson,
            assemblerOptsJson,
            linkerOptsJson,
            "binary",
            LoadTextFileCallback,
            LoadBinaryFileCallback,
            Options.generateDebugInfo
        );

        // Deserialize to browser-specific format (base64 strings) and convert to Js65CompileResult
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
            romdata = Convert.FromBase64String(browserResult.Romdata),
            debugfile = browserResult.Debugfile,
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

    private string LoadBinaryFileCallback(string basePath, string filePath)
    {
        // C# callbacks take precedence
        if (Callbacks?.OnFileReadBinary != null)
        {
            return Convert.ToBase64String(Callbacks.OnFileReadBinary.Invoke(basePath, filePath));
        }

        // Fall back to JS module callback if configured
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
