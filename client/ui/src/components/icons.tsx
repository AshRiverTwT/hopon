// Inline SVG only: emoji render as colour glyphs on Windows.
export function VoiceGlyph() {
  return (
    <svg class="glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="4" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="5" y="1.5" width="2" height="9" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="2" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}
