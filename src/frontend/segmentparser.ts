// SPDX-License-Identifier: MPL-2.0

import { createHash } from 'sha1-uint8array';
import * as mod from '../module.ts';
import { type Token } from '../token.ts';
import * as Tokens from '../token.ts';

const ANON_SEGMENT_ATTR_REASONS = new Map<string, string>([
  ['off', `output offset is determined by the position in the file`],
  ['mem', `PC address is determined by the segment value`],
  ['out', `anon ROM segments always goes to the main output file`],
  ['load', ''],
  ['run', ''],
  ['alignload', ''],
  ['optional', ''],
  ['dedupe', ''],
  ['default', `cannot write to a default segment`],
  ['align', `a segment starts where the previous one ended. Use .align instead`],
  ['define', ''],
]);

export interface SegmentParserHost {
  fail(msg: string, at?: {source?: Tokens.SourceInfo}): never;
  parseConst(tokens: Token[], start: number): number;
  parseStr(tokens: Token[], start: number): string;
  parseOptionalStr(tokens: Token[], start: number): string|undefined;
  /** Current statement's source, for naming anonymous segments. */
  source(): Tokens.SourceInfo|undefined;
}

/** Parses `.segment`/`.pushseg` segment lists and their attributes. */
export class SegmentParser {
  /** Prefix to prepend to all segment names. */
  private _segmentPrefix = '';

  /** 
   * When defining segments, this tracks the current offset in the output file
   * That way users don't have to define segment offsets if they are sequential
   */
  private _segmentOffset = 0;

  constructor(private readonly host: SegmentParserHost,
              private readonly moduleName?: string) {}

  setPrefix(prefix: string) {
    this._segmentPrefix = prefix;
  }

  private generateAnonSegmentName(memory: number, size: number): string {
    // reuse _segmentOffset for a count of segments used in this file to help make the hash unique.
    // Prefer the tokenizer's file name over the module name
    // For an `.include`d file that's the file the user actually wrote the `.segment` in.
    const source = this.host.source();
    const file = source?.file ?? this.moduleName ?? '';
    const line = source?.line;
    const input = [file, String(line ?? ''), String(this._segmentOffset++),
                   String(memory), String(size)].join('\0');
    const hash = createHash().update(input).digest('hex').slice(0, 12);
    return mod.anonSegmentName(file, line, hash);
  }

  /**
   * A boolean segment attribute. If a param is not provided, it defaults to true
   * otherwise is uses the value after it (as a const value).
   */
  parseFlag(tokens: Token[], key: string): boolean {
    if (!tokens.length) return true;
    const val = this.host.parseConst(tokens, 0);
    if (val !== 0 && val !== 1) {
      this.host.fail(`Segment attr ${key} must be 0 or 1: ${val}`, tokens[0]);
    }
    return val !== 0;
  }

  /** An alignment segment attribute which must be a positive power of two. */
  parseAlign(tokens: Token[], key: string): number {
    if (!tokens.length) this.host.fail(`Segment attr ${key} needs a value`);
    const val = this.host.parseConst(tokens, 0);
    if (val < 1 || (val & (val - 1)) !== 0) {
      this.host.fail(`Segment attr ${key} must be a power of two: ${val}`, tokens[0]);
    }
    return val;
  }

  parseSegmentList(tokens: Token[], start: number, allowEmptySegmentList: boolean): Array<string|mod.Segment> {
    if (tokens.length < start + 1) {
      if (allowEmptySegmentList) {
        return [];
      }
      this.host.fail(`Expected a segment list`, tokens[start - 1]);
    }
    if (tokens.find(t => t.token == 'op' && t.str == '&')) {
      return this.parseShorthandMirroredSegment(tokens);
    }

    return Tokens.parseArgList(tokens, 1).map((ts, _i, all) => {
      // `.segment $8000 :size $4000` - an address rather than a name.
      if (ts[0]?.token === 'num') return this.parseAnonSegment(ts, all.length);
      const str = this._segmentPrefix + Tokens.expectString(ts[0]);
      // Check the composed name so `.segmentprefix "@"` can't smuggle one in.
      if (str.startsWith(mod.RESERVED_SEGMENT_PREFIX)) {
        this.host.fail(
            `Segment name may not start with '${mod.RESERVED_SEGMENT_PREFIX}', which is reserved: ${str}`,
            ts[0]);
      }
      if (ts.length === 1) return str;
      if (!Tokens.eq(ts[1], Tokens.COLON)) {
        this.host.fail(`Expected comma or colon: ${Tokens.name(ts[1])}`, ts[1]);
      }
      let nonCompositeAttrSeen = false;
      const seg = {name: str} as mod.Segment;
      // TODO - parse expressions...
      const attrs = Tokens.parseAttrList(ts, 1); // : ident [...]
      for (const [key, val] of attrs) {
        if (key !== 'mirror' && key !== 'pool') {
          nonCompositeAttrSeen = true;
        }
        switch (key) {
          case 'bank': seg.bank = this.host.parseConst(val, 0); break;
          case 'size': seg.size = this.host.parseConst(val, 0); break;
          case 'off': seg.offset = this.host.parseConst(val, 0); break;
          case 'mem': seg.memory = this.host.parseConst(val, 0); break;
          // `:fill` with no value fills with zeros, like ld65's `fill = yes`.
          case 'fill': seg.fill = val.length ? this.host.parseConst(val, 0) : 0; break;
          case 'out': seg.out = this.host.parseOptionalStr(val, 0) ?? '%O'; break;
          case 'align': seg.align = this.parseAlign(val, key); break;
          case 'alignload': seg.alignLoad = this.parseAlign(val, key); break;
          case 'load': seg.load = this.host.parseStr(val, 0); break;
          case 'run': seg.run = this.host.parseStr(val, 0); break;
          // ld65's `type = zp` is both an addressing size and a bss segment.
          case 'zp': case 'zeropage': seg.addressing = 1; seg.bss = true; break;
          case 'bss': seg.bss = this.parseFlag(val, key); break;
          case 'define': seg.define = this.parseFlag(val, key); break;
          case 'optional': seg.optional = this.parseFlag(val, key); break;
          case 'dedupe': seg.dedupe = this.parseFlag(val, key); break;
          case 'default': seg.default = this.parseFlag(val, key); break;
          // js65 has no read-only concept, so accept and ignore ld65's types.
          case 'ro': case 'rw': break;
          case 'mirror':
            seg.mirror = this.parseSegmentNameList(val, key, ts[1]);
            break;
          case 'pool':
            seg.pool = this.parseSegmentNameList(val, key, ts[1]);
            break;
          default: this.host.fail(`Unknown segment attr: ${key}`);
        }
      }
      if (seg.mirror && seg.pool) {
        this.host.fail(`A segment may not have both \`:mirror\` and \`:pool\``, ts[1]);
      }
      if (nonCompositeAttrSeen && (seg.mirror || seg.pool)) {
        this.host.fail(`Cannot use other segment attributes when \`:${
            seg.mirror ? 'mirror' : 'pool'}\` is used`, ts[1]);
      }
      // Only auto-assign offset if segment has an output file specified
      // Segments without :out and without :off are RAM segments (no file output)
      if (seg.offset === undefined && seg.size !== undefined && seg.out !== undefined) {
        seg.offset = this._segmentOffset;
        this._segmentOffset += seg.size;
      }
      if (seg.fill !== undefined && seg.size !== undefined) {
        seg.free = [[seg.memory ?? 0, (seg.memory ?? 0) + seg.size]];
      }
      return seg;
    });
  }

  parseSegmentNameList(val: Token[], key: string, at?: Token): string[] {
    const grp = val.length === 1 && val[0].token === 'grp' ? val[0] : undefined;
    if (!grp) {
      this.host.fail(`Segment attr ${key} expects a braced list: :${key} {"A", "B"}`,
                at);
    }
    const names: string[] = [];
    for (const tok of grp.inner) {
      if (Tokens.eq(tok, Tokens.COMMA)) continue;
      if (tok.token !== 'str') {
        this.host.fail(`Segment attr ${key} expects a list of segment name strings`,
                  tok);
      }
      names.push(tok.str);
    }
    return this.checkCompositeMembers(names, key, at);
  }

  private checkCompositeMembers(names: string[], key: string,
                              at?: Token): string[] {
    if (names.length < 2) {
      this.host.fail(`Segment attr ${key} needs at least two segments: ${
          names.length ? names.join(', ') : '(empty)'}`, at);
    }
    const prefixed = names.map(n => this._segmentPrefix + n);
    if (new Set(prefixed).size !== prefixed.length) {
      this.host.fail(`Segment attr ${key} contains a duplicate segment: ${
          prefixed.join(', ')}`, at);
    }
    return prefixed;
  }

  /**
   * Parses an anonymous segment: `.segment $8000 :size $4000 [:fill <$ff>]`.
   *
   * The positional address is the segment's `memory`. There is deliberately no
   * `offset` parameter. Anonymous segments are laid out sequentially by the
   * linker in module-read order.
   */
  parseAnonSegment(ts: Token[], argCount: number): mod.Segment {
    if (argCount > 1) {
      this.host.fail(`An anonymous .segment may not appear in a comma-separated list`,
                ts[0]);
    }
    const colon = Tokens.find(ts, Tokens.COLON, 0);
    if (colon < 0) {
      this.host.fail(`An anonymous .segment requires :size`, ts[0]);
    }
    // allow math expressions in the PC address
    const memory = this.host.parseConst(ts.slice(0, colon), 0);

    let size: number|undefined;
    let fill: number|undefined;
    let bank: number|undefined;
    let bss = false;
    let addressing: number|undefined;
    for (const [key, val] of Tokens.parseAttrList(ts, colon)) {
      const rejected = ANON_SEGMENT_ATTR_REASONS.get(key);
      if (rejected != null) {
        this.host.fail(`Segment attr ${key} is not allowed on an anonymous .segment` +
                  (rejected ? `: ${rejected}` : ''), ts[0]);
      }
      switch (key) {
        case 'size': size = this.host.parseConst(val, 0); break;
        // `:fill` with no value fills with zeros, like ld65's `fill = yes`.
        case 'fill': fill = val.length ? this.host.parseConst(val, 0) : 0; break;
        // Pure metadata, for `^` bank-byte exprs and LinkSegment.bank.
        case 'bank': bank = this.host.parseConst(val, 0); break;
        case 'zp': case 'zeropage': addressing = 1; bss = true; break;
        case 'bss': bss = this.parseFlag(val, key); break;
        // js65 has no read-only concept, so accept and ignore ld65's types.
        case 'ro': case 'rw': break;
        default: this.host.fail(`Unknown segment attr: ${key}`, ts[0]);
      }
    }
    if (size === undefined) {
      this.host.fail(`An anonymous .segment requires :size`, ts[0]);
    }
    if (bss && fill !== undefined) {
      this.host.fail(`Segment attr fill is not allowed on an anonymous ram ` +
                `segment: a ram segment writes nothing to the file`, ts[0]);
    }

    const seg: mod.Segment = {
      name: this.generateAnonSegmentName(memory, size), memory, size,
    };
    if (bss) seg.bss = true;
    if (addressing !== undefined) seg.addressing = addressing;
    if (bank !== undefined) seg.bank = bank;
    if (fill !== undefined) {
      seg.fill = fill;
      seg.free = [[memory, memory + size]];
    }

    return seg;
  }

  /**
   * .segment "A" & "B" & ... "Z" ; is shorthand for
   * .segment "A&B&...&Z" :mirror {"A", "B", ... "Z"}
   * No commas are allowed in this as the data should be mirrored into all segments listed
   * Loads or creates a segment with the `:mirrored` attribute and returns just that one segment
   */
  parseShorthandMirroredSegment(ts: Token[]): Array<string|mod.Segment> {
    // Find the list of named segments and reject if we have any attributes or commas
    // skipping over the first `.segment` token
    const segnames = ts.slice(1).filter(t => !(t.token === 'op' && t.str === '&'))
                                .map( t => Tokens.expectString(t) ).sort();
    const mirror = this.checkCompositeMembers(segnames, 'mirror', ts[0]);
    const seg: mod.Segment = {
      name: mirror.join('&'),
      mirror,
    };
    return [seg];
  }
}
