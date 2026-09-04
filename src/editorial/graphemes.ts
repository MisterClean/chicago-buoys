const segmenter = new Intl.Segmenter("en-US", { granularity: "grapheme" });

export function graphemeLength(value: string): number {
  return [...segmenter.segment(value)].length;
}

export function assertPostLength(value: string, maximum = 300): void {
  const length = graphemeLength(value);
  if (length > maximum) {
    throw new Error(`Post is ${length} graphemes; maximum is ${maximum}`);
  }
}
