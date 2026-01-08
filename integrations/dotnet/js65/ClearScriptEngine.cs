
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
    
    public override async Task<Js65CompileResult?> Apply(byte[] rom)
    {
        var data = (ITypedArray<byte>) _engine.Evaluate($"new Uint8Array({rom.Length});");
        data.WriteBytes(rom, 0, data.Length, 0);
        _engine.AddHostTypes(typeof(Task), typeof(Console), typeof(JavaScriptExtensions), typeof(Js65Callbacks), typeof(Js65Options));
        _engine.AddHostObject("Options", Options);
        _engine.AddHostObject("FileCallbacks", Callbacks);
        _engine.Script.romdata = data;
        _engine.Script.debugFile = "";
        _engine.Script.modules = IntoExpandoObject();
        await Task.Run(() => {
            _engine.Execute(new DocumentInfo { Category = ModuleCategory.Standard },  /* language=javascript */ """
import { compile } from '@system/libassembler'

// Convert action-based modules to source inputs
const module_list = Object.values(modules);
const inputs = module_list.map((module_expando, idx) => {
    // Convert actions to assembly source code
    const lines = [];

    const module = Object.values(module_expando);
    for (const action of module) {
        switch (action.action) {
            case 'code':
                if (action.code) {
                    lines.push(action.code);
                }
                break;

            case 'label':
                lines.push(`${action.label}:`);
                break;

            case 'byte':
                if (Array.isArray(action.bytes)) {
                    const values = action.bytes.map(b => {
                        if (typeof b === 'object' && b.op === 'sym') {
                            return b.sym; // Symbol reference
                        }
                        return `$${b.toString(16).padStart(2, '0')}`;
                    }).join(', ');
                    lines.push(`.byte ${values}`);
                }
                break;

            case 'word':
                if (Array.isArray(action.words)) {
                    const values = action.words.map(w => {
                        if (typeof w === 'object' && w.op === 'sym') {
                            return w.sym; // Symbol reference
                        }
                        return `$${w.toString(16).padStart(4, '0')}`;
                    }).join(', ');
                    lines.push(`.word ${values}`);
                }
                break;

            case 'org':
                const addr = `$${action.addr.toString(16).padStart(4, '0')}`;
                lines.push(`.org ${addr}`);
                break;

            case 'segment':
                if (Array.isArray(action.name)) {
                    const segments = action.name.map(s => `"${s}"`).join(', ');
                    lines.push(`.segment ${segments}`);
                } else if (action.name) {
                    lines.push(`.segment "${action.name}"`);
                }
                break;

            case 'reloc':
                lines.push('.reloc');
                break;

            case 'export':
                lines.push(`.export ${action.name}`);
                break;

            case 'assign':
                lines.push(`${action.name} = ${action.value}`);
                break;

            case 'set':
                lines.push(`.set ${action.name}, ${action.value}`);
                break;

            case 'free':
                if (action.size) {
                    lines.push(`.res ${action.size}, $ff`);
                }
                break;

            default:
                console.warn(`Unknown action type: ${action.action}`);
        }
    }

    const source = lines.join('\n');
    return {
        type: 'source',
        code: source,
        name: `module_${idx}.s`
    };
});

const assemblerOpts = {
    includePaths: [...Options.includePaths],
    lineContinuations: !!Options.lineContinuations,
    numberSeparators: !!Options.numberSeparators,
    generateDebugInfo: !!Options.generateDebugInfo
};

const linkerOpts = {
    baseRom: romdata
};

const callbacks = {
    readText: FileCallbacks.OnFileReadText,
    readBinary: FileCallbacks.OnFileReadBinary
};

compile(inputs, assemblerOpts, linkerOpts, 'binary', callbacks).then(result => {
    // Copy result back to romdata
    for (let i = 0; i < result.length; i++) {
        romdata[i] = result[i];
    }
});
""");
        });
        var outdata = new byte[rom.Length];
        data.ReadBytes(0, (ulong)outdata.Length, outdata, 0);
        var debugFileContents = (string)_engine.Script.debugFile;
        return new Js65CompileResult
        {
            romdata = outdata,
            debugfile = debugFileContents
        };
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
