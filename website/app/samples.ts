export const samples = [
  {name: 'Basic example', files: new Map([
    ['/workspace/main.s', '.org $0600\n.include "values.inc"\nstart:\n  lda #color\n  sta $0200\n'],
    ['/workspace/values.inc', 'color = $01\n'],
  ])},
  {name: 'Counter loop', files: new Map([
    ['/workspace/main.s', '.org $0600\n  ldx #0\nloop:\n  inx\n  stx $0200\n  bne loop\n'],
  ])},
];
