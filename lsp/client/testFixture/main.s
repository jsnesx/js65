; Fixture for the js65 extension end-to-end tests.
; Line/column positions are asserted in test/*.test.ts — edit with care.
.include "macros.inc"

counter = $10

.proc reset
  lda #$00
  sta counter
  setpal $12
  jmp reset
.endproc
