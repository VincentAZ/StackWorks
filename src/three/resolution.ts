// Scale in quarter steps to avoid reallocating buffers on every small change
// in the visible area. The budget limits extra samples above display resolution.
export function highQualityScale(width: number, height: number, maxScale: number) {
  const scale = Math.min(maxScale, Math.sqrt(12_000_000 / (width * height)));
  return Math.max(1, Math.floor(scale * 4) / 4);
}
