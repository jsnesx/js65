
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;

namespace js65;

[DebuggerDisplay("{" + nameof(GetDebuggerDisplay) + "(),nq}")]
public class AsmModule
{
    public List<Dictionary<string, object>> Actions { get; } = [];
    
    public void Code(string asm, string name = "",
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "code" },
            { "code", asm },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Label(string lb,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "label" },
            { "label", lb },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Byt(byte bytes,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Byt([bytes], sourceFilePath, sourceLineNumber);

    public void Byt(byte[] bytes,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "byte" },
            { "bytes", bytes },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Byt(Dictionary<string, object>[] bytes,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "byte" },
            { "bytes", bytes },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Byt(string str,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "byte" },
            { "bytes", new string[] { str } },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Word(ushort words,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Word([words], sourceFilePath, sourceLineNumber);

    public void Word(ushort[] words,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "word" },
            { "words", words },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Word(Dictionary<string, object> words,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Word([words], sourceFilePath, sourceLineNumber);

    public void Word(Dictionary<string, object>[] words,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "word" },
            { "words", words },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void HiBytes(ushort[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "hibytes" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void HiBytes(Dictionary<string, object>[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "hibytes" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void LoBytes(ushort[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "lobytes" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void LoBytes(Dictionary<string, object>[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "lobytes" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Literal(byte[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "literal" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Literal(string str,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "literal" },
            { "values", new string[] { str } },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Literal(Dictionary<string, object>[] values,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "literal" },
            { "values", values },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Org(ushort addr, string name = "",
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "org" },
            { "addr", addr },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    // Converts from file address space to CPU address space, just a helper function
    // since all the current addresses in the randomizer are in file address space
    public void RomOrg(int addr, string name = "",
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        // adjustment for the ines header
        int romaddr = addr - 0x10;
        byte segment = (byte)(romaddr / 0x4000);
        ushort cpuoffset = (ushort)(segment == 7 ? 0xc000 : 0x8000);
        ushort cpuaddr = (ushort)((romaddr % 0x4000) + cpuoffset);

        Actions.Add(new() {
            { "action", "org" },
            { "addr", cpuaddr },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Segment(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Segment([name], sourceFilePath, sourceLineNumber);

    public void Segment(string[] name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "segment" },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Reloc(string name = "",
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "reloc" },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public Dictionary<string, object> Symbol(string name)
    {
        // kinda jank, but instead of eating the overhead for creating this token,
        // just hardcode the symbol token
        return new Dictionary<string, object>
        {
            { "op", "sym" },
            { "sym", name },
        };
    }

    public void Export(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "export" },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void ExportZp(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => ExportZp([name], sourceFilePath, sourceLineNumber);

    public void ExportZp(string[] names,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "exportzp" },
            { "names", names },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Import(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Import([name], sourceFilePath, sourceLineNumber);

    public void Import(string[] names,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "import" },
            { "names", names },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void ImportZp(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => ImportZp([name], sourceFilePath, sourceLineNumber);

    public void ImportZp(string[] names,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "importzp" },
            { "names", names },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Global(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => Global([name], sourceFilePath, sourceLineNumber);

    public void Global(string[] names,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "global" },
            { "names", names },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void GlobalZp(string name,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => GlobalZp([name], sourceFilePath, sourceLineNumber);

    public void GlobalZp(string[] names,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new()
        {
            { "action", "globalzp" },
            { "names", names },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void RelocExportLabel(string name, string[] segments,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        if (segments.Length > 0)
        {
            Segment(segments, sourceFilePath, sourceLineNumber);
        }
        Reloc("", sourceFilePath, sourceLineNumber);
        Label(name, sourceFilePath, sourceLineNumber);
        Export(name, sourceFilePath, sourceLineNumber);
    }

    // Assign defines a constant value or expression
    public void Assign(string name, int value,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "assign" },
            { "value", value },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    // Set defines a non-constant value (which can be redefined with a second set)
    public void Set(string name, int value,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "set" },
            { "value", value },
            { "name", name },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Free(string segment, ushort startorg, ushort endorg,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) {
        if (endorg <= startorg) {
            throw new Exception($"Free called with bad range: Start {startorg:04X} End {endorg:04X}");
        }
        Segment([segment], sourceFilePath, sourceLineNumber);
        Org(startorg, "", sourceFilePath, sourceLineNumber);
        Actions.Add(new() {
            { "action", "free" },
            { "size", endorg - startorg },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void Align(int boundary, int? fill = null,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        var dict = new Dictionary<string, object> {
            { "action", "align" },
            { "boundary", boundary },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        };
        if (fill.HasValue) dict["fill"] = fill.Value;
        Actions.Add(dict);
    }

    public void Res(int count, int? value = null,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        var dict = new Dictionary<string, object> {
            { "action", "res" },
            { "count", count },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        };
        if (value.HasValue) dict["value"] = value.Value;
        Actions.Add(dict);
    }

    public void CharMap(int code, int target,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "charmap" },
            { "code", code },
            { "target", target },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    // Maps a whole string key to one or more output bytes, i.e. `.strmap`.
    public void StrMap(string key, byte value,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0) => StrMap(key, [value], sourceFilePath, sourceLineNumber);

    public void StrMap(string key, byte[] bytes,
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "strmap" },
            { "key", key },
            { "bytes", bytes },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void PushCharmap(
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "pushcharmap" },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public void PopCharmap(
        [CallerFilePath] string sourceFilePath = "",
        [CallerLineNumber] int sourceLineNumber = 0)
    {
        Actions.Add(new() {
            { "action", "popcharmap" },
            { "source", new Dictionary<string, object> { { "file", sourceFilePath }, { "line", sourceLineNumber } } }
        });
    }

    public string GetDebuggerDisplay()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append('[');
        int count = 0;
        foreach (var dict in Actions) 
        {
            count++;
            sb.Append('{');
            int count2 = 0;
            foreach(KeyValuePair<string, object> property in dict)
            {
                sb.Append(property.Key + " : " + property.Value + ",");
                count2++;
            }
            if(count2 > 0)
            {
                sb.Remove(sb.Length - 1, 1);
            }
            sb.Append("},");
        }
        if (count > 0)
        {
            sb.Remove(sb.Length - 1, 1);
        }
        sb.Append(']');

        return sb.ToString();
    }
}
