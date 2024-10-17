
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
public class ClearScriptEngine : IAsmEngine
{
    private readonly V8ScriptEngine engine;
    private bool initializedLibAsm;

    public ClearScriptEngine()
    {
        initializedLibAsm = false;
        engine = new();
        // If you need to debug the javascript, add these flags and connect to the debugger through vscode.
        // follow this tutorial for how https://microsoft.github.io/ClearScript/Details/Build.html#_Debugging_with_ClearScript_2
        //scriptEngine = new V8ScriptEngine(V8ScriptEngineFlags.EnableDebugging | V8ScriptEngineFlags.EnableRemoteDebugging | V8ScriptEngineFlags.AwaitDebuggerAndPauseOnStart);

        engine.DocumentSettings.AccessFlags = DocumentAccessFlags.EnableAllLoading;
    }
    
    public async Task<byte[]?> Apply(byte[] rom, Assembler asm)
    {
        if (!initializedLibAsm)
        {
            var assembly = Assembly.Load("js65");
            var libassembly = await ReadResourceAsync(assembly, "js65.libassembler.js");
            engine.DocumentSettings.AddSystemDocument("@system/libassembler", ModuleCategory.Standard,libassembly);
        }
        
        var data = (ITypedArray<byte>) engine.Evaluate($"new Uint8Array({rom.Length});");
        data.WriteBytes(rom, 0, data.Length, 0);
        engine.Script.romdata = data;
        engine.Script.modules = asm.AsExpando();

        engine.Execute(new DocumentInfo { Category = ModuleCategory.Standard },  /* language=javascript */ """
import { compile } from '@system/libassembler'
compile(modules,romdata);
""");
        byte[] outdata = new byte[rom.Length];
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
}
