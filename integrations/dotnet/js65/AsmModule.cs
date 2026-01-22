
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
