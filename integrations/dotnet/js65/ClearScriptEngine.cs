
using System.Reflection;
using System.Runtime.Versioning;
using js65;
using Microsoft.ClearScript;
using Microsoft.ClearScript.JavaScript;
using Microsoft.ClearScript.V8;

namespace js65;

[SupportedOSPlatform("windows")]
[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public class ClearScriptEngine : Assembler
{
    private readonly V8ScriptEngine _engine;

    public ClearScriptEngine(Js65Options? options = null, bool useFileSystemCallbacks = true, bool debugJavascript = false) : base(options)
    {
        // If you need to debug the javascript, add these flags and connect to the debugger through vscode.
        // follow this tutorial for how https://microsoft.github.io/ClearScript/Details/Build.html#_Debugging_with_ClearScript_2
        var debugFlags = debugJavascript
            ? V8ScriptEngineFlags.EnableDebugging | V8ScriptEngineFlags.EnableRemoteDebugging |
              V8ScriptEngineFlags.AwaitDebuggerAndPauseOnStart
            : 0;
        _engine = new V8ScriptEngine(debugFlags);

        _engine.DocumentSettings.AccessFlags = DocumentAccessFlags.EnableAllLoading;
        
        // Load the js65 code from the embedded resources
        var libassembler = ReadResource(Assembly.Load("js65"), "js65.libassembler.js");
        _engine.DocumentSettings.AddSystemDocument("@system/libassembler", ModuleCategory.Standard,libassembler);

        // Setup the filesystem callbacks
        if (!useFileSystemCallbacks) return;
        Callbacks = new();
        Callbacks.OnFileReadText = LoadTextFileCallback;
        Callbacks.OnFileReadBinary = LoadBinaryFileCallback;
    }
    
    public override async Task<byte[]?> Apply(byte[] rom)
    {
        var data = (ITypedArray<byte>) _engine.Evaluate($"new Uint8Array({rom.Length});");
        data.WriteBytes(rom, 0, data.Length, 0);
        _engine.AddHostTypes(typeof(Task), typeof(Console), typeof(JavaScriptExtensions), typeof(Js65Callbacks), typeof(Js65Options));
        _engine.AddHostObject("Options", Options);
        _engine.AddHostObject("FileCallbacks", Callbacks);
        _engine.Script.romdata = data;
        _engine.Script.modules = IntoExpandoObject();
        await Task.Run(() => {
            _engine.Execute(new DocumentInfo { Category = ModuleCategory.Standard },  /* language=javascript */ """
import { compile } from '@system/libassembler'

let opts = {
    includePaths: [...Options.includePaths],
    lineContinuations: !!Options.lineContinuations,
    numberSeparators: !!Options.numberSeparators,
    skipSourceAnnotations: !!Options.skipSourceAnnotations
};

compile(modules, romdata, opts, FileCallbacks.OnFileReadText, FileCallbacks.OnFileReadBinary);
""");
        });
        var outdata = new byte[rom.Length];
        data.ReadBytes(0, (ulong)outdata.Length, outdata, 0);
        return outdata;
    }

    private static string ReadResource(Assembly assembly, string name)
    {
        // Format: "{Namespace}.{Folder}.{filename}.{Extension}"
        using var stream = assembly.GetManifestResourceStream(name)!;
        using StreamReader reader = new(stream);
        return reader.ReadToEnd();
    }

    private static string? ExeBasePath => Path.GetDirectoryName(Assembly.GetEntryAssembly()!.Location);

    private static string LoadTextFileCallback(string basePath, string relPath)
    {
        var fullPath = Path.GetFullPath(Path.Combine(ExeBasePath!, basePath, relPath));
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = File.ReadAllText(fullPath);
        return data;
    }
    private static byte[] LoadBinaryFileCallback(string basePath, string relPath)
    {
        var fullPath = Path.GetFullPath(Path.Combine(ExeBasePath!, basePath, relPath));
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = File.ReadAllBytes(fullPath);
        return data;
    }
}
