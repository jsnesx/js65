import {generateInstructionReference} from './tools/instruction-reference.ts';

// Place the latest "Source" from the nesdev Instruction_reference wiki
// page here, saved as instructionreference.wiki and then bun run website:instructions
// to regenerate the instruction helpers.
const source = await Bun.file(new URL('./instructionreference.wiki', import.meta.url)).text();
await Bun.write(new URL('./app/instructions.generated.ts', import.meta.url),
  generateInstructionReference(source));
