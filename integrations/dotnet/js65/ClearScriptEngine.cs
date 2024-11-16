
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
    private bool _initializedLibAsm;

    public ClearScriptEngine(Js65Options? options = null, bool useFileSystemCallbacks = true) : base(options)
    {
        _initializedLibAsm = false;
        _engine = new V8ScriptEngine();
        // If you need to debug the javascript, add these flags and connect to the debugger through vscode.
        // follow this tutorial for how https://microsoft.github.io/ClearScript/Details/Build.html#_Debugging_with_ClearScript_2
        // _engine = new V8ScriptEngine(V8ScriptEngineFlags.EnableDebugging | V8ScriptEngineFlags.EnableRemoteDebugging | V8ScriptEngineFlags.AwaitDebuggerAndPauseOnStart);

        _engine.DocumentSettings.AccessFlags = DocumentAccessFlags.EnableAllLoading;

        // Setup the filesystem callbacks
        if (!useFileSystemCallbacks) return;
        Callbacks = new();
        Callbacks.FileResolve = (basePath, relPath) =>
            Task.FromResult(Path.GetFullPath(Path.Combine(basePath, relPath)));
        Callbacks.FileReadText = LoadTextFileCallback;
        Callbacks.FileReadBinary = LoadBinaryFileCallback;
    }
    
    public override async Task<byte[]?> Apply(byte[] rom)
    {
        // This initialization code needs to happen Async so it can't happen in the constructor
        if (!_initializedLibAsm)
        {
            var libassembler = await ReadResourceAsync(Assembly.Load("js65"), "js65.libassembler.js");
            _engine.DocumentSettings.AddSystemDocument("@system/libassembler", ModuleCategory.Standard,libassembler);
            _initializedLibAsm = true;
        }
        
        var data = (ITypedArray<byte>) _engine.Evaluate($"new Uint8Array({rom.Length});");
        data.WriteBytes(rom, 0, data.Length, 0);
        _engine.AddHostTypes(typeof(Task), typeof(Console), typeof(JavaScriptExtensions), typeof(Js65Callbacks), typeof(Js65Options));
        _engine.AddHostObject("Options", Options);
        _engine.AddHostObject("FileCallbacks", Callbacks);
        _engine.Script.romdata = data;
        _engine.Script.modules = IntoExpandoObject();

        _engine.Execute(new DocumentInfo { Category = ModuleCategory.Standard },  /* language=javascript */ """
import { compile } from '@system/libassembler'

debugger;
let opts = {
    includePaths: [...Options.includePaths],
    lineContinuations: !!Options.lineContinuations,
    numberSeparators: !!Options.numberSeparators,
    skipSourceAnnotations: !!Options.skipSourceAnnotations
};

async function ReadString(filename) {
    if (FileCallbacks !== null && FileCallbacks.FileReadText !== null) {
        let cb = FileCallbacks.FileReadText(filename);
        return await cb.ToPromise();
    }
    return Promise.reject();
}

async function ReadBytes(filename) {
    if (FileCallbacks !== null && FileCallbacks.FileReadText !== null) {
        let cb = FileCallbacks.FileReadText(filename);
        return await cb.ToPromise();
    }
    return Promise.reject();
}

async function Resolve(path, filename) {
    if (FileCallbacks !== null && FileCallbacks.FileResolve !== null) {
        let cb = FileCallbacks.FileResolve(path, filename);
        return await cb.ToPromise();
    }
    return Promise.reject();
}

let callbacks = {
    fsReadString: ReadString,
    fsReadBytes: ReadBytes,
    fsResolve: Resolve
};

compile(modules, romdata, opts, callbacks);
""");
        var outdata = new byte[rom.Length];
        data.ReadBytes(0, (ulong)outdata.Length, outdata, 0);
        return outdata;
    }

    private static async Task<string> ReadResourceAsync(Assembly assembly, string name)
    {
        // Format: "{Namespace}.{Folder}.{filename}.{Extension}"
        await using var stream = assembly.GetManifestResourceStream(name)!;
        using StreamReader reader = new(stream);
        return await reader.ReadToEndAsync();
    }

    private static async Task<string> LoadTextFileCallback(string fullPath)
    {
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = await File.ReadAllTextAsync(fullPath);
        return data;
    }
    private static async Task<byte[]> LoadBinaryFileCallback(string fullPath)
    {
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = await File.ReadAllBytesAsync(fullPath);
        return data;
    }
}
