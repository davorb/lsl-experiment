// The AGI text parser: lowercase, strip punctuation, match the longest vocabulary phrase at each position.
import type { Vocabulary } from '../../../shared/agi/logic';

export interface ParsedLine {
  /** Word ids in order (ignored filler words, id 0, are dropped). */
  ids: number[];
  /** The source text of each id, for %wN codes. */
  texts: string[];
  /** 1-based index of the first unknown word, or 0 if every word was understood. */
  unknown: number;
}

export function parseLine(line: string, vocab: Vocabulary): ParsedLine {
  const tokens = line
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const ids: number[] = [];
  const texts: string[] = [];
  let unknown = 0;
  let i = 0;
  let wordNo = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let n = Math.min(vocab.maxWordLen, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      const id = vocab.words.get(phrase);
      if (id !== undefined) {
        wordNo++;
        if (id !== 0) { ids.push(id); texts.push(phrase); }
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      wordNo++;
      if (!unknown) unknown = wordNo;
      i++;
    }
  }
  return { ids, texts, unknown };
}

/** said(pattern): id 1 matches any single word, 9999 matches the rest of the line. */
export function matchSaid(pattern: number[], input: number[]): boolean {
  let i = 0;
  for (const id of pattern) {
    if (id === 9999) return true;
    if (i >= input.length) return false;
    if (id !== 1 && id !== input[i]) return false;
    i++;
  }
  return i === input.length;
}
