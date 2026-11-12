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

const I = (p: { d: string; size?: number; fill?: boolean }) => (
  <svg class="glyph" width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" aria-hidden="true"
    fill={p.fill ? "currentColor" : "none"} stroke={p.fill ? "none" : "currentColor"} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d={p.d} />
  </svg>
);
export const EyeIcon = () => <I d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z" />;
export const FullIcon = () => <I d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />;
export const ExitFullIcon = () => <I d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" />;
export const PipIcon = () => <I d="M1.5 3h13v10h-13zM8.5 8h4.5v3.5H8.5z" />;
export const DockIcon = () => <I d="M1.5 3h13v10h-13zM4.5 6l3 3M4.5 9h3V6" />;
export const CloseIcon = () => <I d="M3.5 3.5l9 9M12.5 3.5l-9 9" />;
export const SpeakerIcon = () => <I d="M2 6h2.5L8 3v10L4.5 10H2zM11 5.5a3.5 3.5 0 010 5M12.8 3.5a6.3 6.3 0 010 9" />;
export const BellIcon = () => <I d="M4 11V7a4 4 0 018 0v4l1.2 1.5H2.8zM6.5 14h3" />;
export const BellOffIcon = () => <I d="M4 11V7a4 4 0 016.7-3M12 7v4l1.2 1.5H5M6.5 14h3M2 2l12 12" />;
