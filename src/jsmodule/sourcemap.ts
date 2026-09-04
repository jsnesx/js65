// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal js sourceMap parser for error reporting
 */

export interface MappedPosition {
  /** Path as it appears in the map's `sources`. */
  source: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
}

/** One decoded mapping: where a generated column came from. */
interface Mapping {
  genColumn: number;
  sourceIndex: number;
  sourceLine: number;
  sourceColumn: number;
}

export interface SourceMap {
  sources: string[];
  sourcesContent: (string | undefined)[];
  /** Decoded mappings, indexed by 0-based generated line. */
  lines: Mapping[][];
}

const B64 = new Map<string, number>(
    [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/']
        .map((c, i) => [c, i]));

/** Reads one base64 VLQ value, advancing `at.i` past it. */
function readVlq(text: string, at: {i: number}): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const digit = B64.get(text[at.i++]);
    if (digit === undefined) return NaN;
    result += (digit & 31) << shift;
    if (!(digit & 32)) break;
    shift += 5;
  }
  // Bit 0 is the sign, so a decoded -0 means the most negative value.
  const value = result >>> 1;
  return result & 1 ? -value : value;
}

export function parseSourceMap(json: string | undefined): SourceMap | undefined {
  if (!json) return undefined;
  let raw;
  try {
    raw = JSON.parse(json) as {
      sources?: unknown, sourcesContent?: unknown, mappings?: unknown};
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw.sources) || typeof raw.mappings !== 'string') return undefined;
  const lines: Mapping[][] = [];
  // Source index, line and column carry across lines; the column resets.
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const group of raw.mappings.split(';')) {
    const mappings: Mapping[] = [];
    let genColumn = 0;
    for (const segment of group.split(',')) {
      if (!segment) continue;
      const at = {i: 0};
      genColumn += readVlq(segment, at);
      // A one-field segment marks generated code with no original position.
      if (at.i >= segment.length) continue;
      sourceIndex += readVlq(segment, at);
      sourceLine += readVlq(segment, at);
      sourceColumn += readVlq(segment, at);
      if (!Number.isFinite(genColumn + sourceIndex + sourceLine + sourceColumn)) {
        return undefined;
      }
      mappings.push({genColumn, sourceIndex, sourceLine, sourceColumn});
    }
    // Segments are usually sorted already, but a map is not required to sort them.
    mappings.sort((a, b) => a.genColumn - b.genColumn);
    lines.push(mappings);
  }
  const contents = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [];
  return {
    sources: raw.sources.map(s => String(s)),
    sourcesContent: raw.sources.map((_, i) => {
      const c = contents[i];
      return typeof c === 'string' ? c : undefined;
    }),
    lines,
  };
}

export function mapPosition(map: SourceMap | undefined, line: number,
                            column: number): MappedPosition | undefined {
  const mappings = map?.lines[line - 1];
  if (!map || !mappings?.length) return undefined;
  // The mapping that starts at or before the column owns it.
  let found: Mapping | undefined;
  for (const m of mappings) {
    if (m.genColumn > column) break;
    found = m;
  }
  // A column before the first mapping still belongs to that line's first entry.
  const hit = found ?? mappings[0];
  const source = map.sources[hit.sourceIndex];
  if (source == null) return undefined;
  return {source, line: hit.sourceLine + 1, column: hit.sourceColumn};
}

/** The original text of one of the map's sources. */
export function sourceContent(map: SourceMap | undefined,
                              source: string): string | undefined {
  const index = map?.sources.indexOf(source) ?? -1;
  return index < 0 ? undefined : map!.sourcesContent[index];
}
