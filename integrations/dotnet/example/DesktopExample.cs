
using js65;


// Lets start by setting up a fake rom. In the real world you will likely use the rom bytes provided by the user
// So just pretend this is your game that you are patching.
List<byte> vanillaRom = [
    // ines Header for a game with 128kb PRG and 8kb CHR ROM
    0x4E, 0x45, 0x53, 0x1A, 0x04, 0x01, 0x53, 0x08, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00,
];

// Add 128kb for the fake rom PRG and 8kb for the fake CHR
vanillaRom.AddRange(new byte[0x20000]);
vanillaRom.AddRange(new byte[0x2000]);

// Lets pretend the game has the following code in the fixed bank
// .org $e000
// lda #$40
// sta a:$0000
// rts
vanillaRom[0x10 + 0x1e000 + 0] = 0xa9; // lda imm
vanillaRom[0x10 + 0x1e000 + 1] = 0x40; // #$40
vanillaRom[0x10 + 0x1e000 + 2] = 0x8d; // sta abs
vanillaRom[0x10 + 0x1e000 + 3] = 0x00; // $00
vanillaRom[0x10 + 0x1e000 + 4] = 0x00; // $00
vanillaRom[0x10 + 0x1e000 + 5] = 0x60; // rts


// Okay our fake rom is setup, now we demonstrate how to edit it using js65 library

// The assembler is a C# container for the command list that will be passed to the assembler.
// You can have as many of these as you want, and apply them to the rom in whatever order you want.
var asm = new Assembler();


// Lets pretend the game is using the MMC5 mapper with 16kb banking

// We'll create a new ASM module and add it to the list of modules
// A module is a file that will be linked together with other files. As each module is independent from all the others,
// if you need to access data in a different module, then you need to export and import that data.
// Or just compile everything into a single module. Its really your choice.
var initmod = asm.Module();

// First off, we need to create a header for the ROM so that we can edit it.
// One difference between ca65 and js65 is in lieu of a linker script, memory sections and segments are defined
// directly in the code through a special segment syntax.
// Additionally since we will be overwriting 
initmod.Code("""
; js65 has some of the macpacks from ca65 included, but also a few js65 specific helpers in the common pack
.macpack common

; .segment has a special optional parameter mode in js65 to provide the same data that a ca65 linker script normally provides
; parameters prefixed with `:` are a named parameter, and the value is the parameter after then name.
; As you would expect, named parametes are allowed to be passed in any order.
; Most parameters are the same as ca65, :off is a little different as it sets the file offset for the output segment.
.segment "HEADER" :bank $00 :size $0010 :mem $0000 :off $00000
.segment "PRG0"   :bank $00 :size $4000 :mem $8000 :off $00010
.segment "PRG1"   :bank $01 :size $4000 :mem $8000 :off $04010
.segment "PRG2"   :bank $02 :size $4000 :mem $8000 :off $08010
.segment "PRG3"   :bank $03 :size $4000 :mem $8000 :off $0c010
.segment "PRG4"   :bank $04 :size $4000 :mem $8000 :off $10010
.segment "PRG5"   :bank $05 :size $4000 :mem $8000 :off $14010
.segment "PRG6"   :bank $06 :size $4000 :mem $8000 :off $18010
.segment "PRG7"   :bank $07 :size $4000 :mem $c000 :off $1c010
.segment "CHR"    :size $20000 :off $20010 :out

; Now define the free space. One of js65's most unique features is tracking free space and allowing the linker to pack
; the data into whatever free space is available. The allows you to write relocatable patch code and let the linker
; place that code wherever there is free space

; FREE is a macro that sets a custom range where [ ] means inclusive and ( ) means exclusive
FREE "PRG0" [$AB00, $c000) ; Lets pretend this bank is mostly full
; and all the other banks are full
""", "init.s"); // the name field is just useful for giving this a "source code" filename. its not required

// Now that we have the segments defined for the rom and the free space setup, we can use js65 to patch the rom

// Lets change the code that was in the fixed bank to load from a different location
asm.Module().Code("""

.macpack common

; Start by selecting what bank(s) we are working with. You can pass a comma separated list of banks here
; as long as the memory region for the banks don't overlap. We'll use that later.
.segment "PRG7"

; Set the address to start overwriting the code. This is in the "Memory" space for the bank, IE: the CPU address
.org $e000
PatchToLoadFromRAM:
  ; Uh oh, the original lda #imm instruction is two bytes and this new one is 3 bytes.
  lda $6789
  ; In this case, the sta function afterwards is originally 3 bytes, but it could've been 2 if we used a zp addressing mode
  ; so all we need to do is update it to use sta ZP and we are good.
  sta $00
  rts
  ; To make sure that we didn't spill into the next function, we can use FREE_UNTIL $addr which both marks everything
  ; from here till that address as free space AND asserts that we are not spilling past this address.
  ; In this case the current PC will be exactly $e006, so no space free-d up but also we didn't go past the bounds, so its fine.
FREE_UNTIL $e006

; Here's a different example, how do we handle adding new code to a function when there's not enough room.
; Lets pretend such a function looks like this in the original rom

;.segment "PRG0"
;.org $8000
; lda $600 ; Load player HP
; sec
; sbc $700,x ; Subtract enemy atk in slot X from player HP
; bcc PlayerDied ; if the player HP underflows jump to PlayerDied
;  sta $600 ; otherwise store their HP and returnrts
;  rts

; What if we want to add armor to the game and reduce the damage that the player will take? This is where you can get creative.
; Since armor should reduce the damage taken, we can patch the `sbc $700,x` line so that it calls our new patch function

; Start off by making a few defines for these variables to make it easier to read
PlayerHP = $600
EnemyAtk = $700
PlayerArmor = $6000
Temp = $00

; Next lets declare what segments this code is in. Since its in PRG0, we know the fixed bank in PRG7 is always available
; so if we run outta room in PRG0 the linker can put the function in either bank
.segment "PRG0", "PRG7"

PlayerSubtractDamage = $8005
.org PlayerSubtractDamage ; set the address to patch the sbc instruction
  jsr CalculateArmorReduction ; and rewrite it to jump to our patch function

; reloc sets the current mode to allow the rest of the code (until the next org) to be placed by the linker at any address
; The linker will search for free memory in the segments listed above to place this

.reloc
CalculateArmorReduction:
  ; load the enemy attack value here so we can subtract the armor value from it
  lda EnemyAtk,x
  ; we don't need to set the carry since the original code already did that
  sbc PlayerArmor
  bcc Underflowed ; if the subtraction underflows, then we want to apply 1 damage as a damage floor
    bne ApplyDamage; if resulting damage is 0, round up to 1 as well
Underflowed:
    lda #1
ApplyDamage:
  sta Temp
  ; Now actually perform the subtraction
  lda PlayerHP
  sec
  sbc Temp
  rts ;and return

""", "custom_patches.s");


// And thats all for this demo for now! lets patch the rom and see that our custom code appears where we expect it.

// The engine is what provides our javascript implementation used to run the assembler.
// ClearScript provides a cross platform desktop JS engine powered by V8, so its pretty fast and cross platform.
var engine = new ClearScriptEngine();
// Apply all the modules in this assembler to the ROM. This will compile and link all of the modules together and
// overwrite the data in the rom provided

var romBytes = await engine.Apply(vanillaRom.ToArray(), asm);

Console.WriteLine("Test patch to call the new armor subtract function");
Console.WriteLine($"sbc,x instruction should be patched to jsr ($20): ${romBytes[0x10 + 0x0005]:x2}");
  

