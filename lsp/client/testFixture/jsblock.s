; Fixture for the .jsbegin block tests.
; Line/column positions are asserted in test/jsBlocks.test.ts - edit with care.
.jsbegin
const pattern = [1, 2, 3];
a.byte(pattern);
a.
.jsend

main:
  rts
