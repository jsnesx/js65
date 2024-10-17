
namespace js65;

public interface IAsmEngine
{
    public Task<byte[]?> Apply(byte[] rom, Assembler asmModule);
}
