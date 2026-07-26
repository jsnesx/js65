
// SPDX-License-Identifier: MPL-2.0

export class IdGenerator {
  private id = 1;
  next(): number {
    return this.id++;
  }
}
