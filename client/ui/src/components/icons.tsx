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
export const CameraIcon = () => <I d="M2 4.5h8v7H2zM10 7l4-2v6l-4-2" />;
export const MicIcon = () => <I d="M6 4a2 2 0 014 0v4a2 2 0 01-4 0zM3.5 7.5a4.5 4.5 0 009 0M8 12v2m-2 0h4" />;
export const ScreenIcon = () => <I d="M2 3h12v8H2zM8 11v2m-3 0h6" />;
export const BellIcon = () => <I d="M4 11V7a4 4 0 018 0v4l1.2 1.5H2.8zM6.5 14h3" />;
export const BellOffIcon = () => <I d="M4 11V7a4 4 0 016.7-3M12 7v4l1.2 1.5H5M6.5 14h3M2 2l12 12" />;
export const SearchIcon = () => <I d="M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6L14 14" />;
export const BookmarkIcon = () => <I d="M4 2h8v12l-4-3-4 3z" />;
export const ListIcon = () => <I d="M2.5 4h11M2.5 8h11M2.5 12h11" />;
export const TilesIcon = () => <I d="M2 2.5h5v5H2zM9 2.5h5v5H9zM2 9.5h5v4H2zM9 9.5h5v4H9z" />;
export const MicOffIcon = () => <I d="M6 4a2 2 0 014 0v4a2 2 0 01-4 0zM3.5 7.5a4.5 4.5 0 009 0M8 12v2m-2 0h4M2.5 2.5l11 11" />;
export const PollIcon = () => <I d="M3 13.5V8M8 13.5V3M13 13.5V6M1.5 13.5h13" />;
export const StarIcon = (p: { filled?: boolean }) => <I fill={p.filled} d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />;
// Emoji picker categories, drawn like the rest of the UI instead of colour emoji.
export const EMOJI_TAB_ICONS: Record<string, () => ReturnType<typeof I>> = {
  Recent: () => <I d="M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM8 4.5V8l2.5 1.5" />,
  Smileys: () => <I d="M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM5.5 9.5s.9 1.5 2.5 1.5 2.5-1.5 2.5-1.5M6 6.3v.2M10 6.3v.2" />,
  People: () => <I d="M8 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 14c.6-2.8 2.6-4.5 5-4.5s4.4 1.7 5 4.5" />,
  Hearts: () => <I d="M8 13.5S2 10 2 6a3 3 0 015.5-1.7h1A3 3 0 0114 6c0 4-6 7.5-6 7.5z" />,
  Animals: () => <I d="M5 6.3a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zM11 6.3a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zM3 9.5a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2zM13 9.5a1.1 1.1 0 100-2.2 1.1 1.1 0 000 2.2zM8 8c2 0 3.5 2.3 3.5 3.8 0 1.2-1 1.7-2 1.7-.6 0-1-.3-1.5-.3s-.9.3-1.5.3c-1 0-2-.5-2-1.7C4.5 10.3 6 8 8 8z" />,
  Food: () => <I d="M8 4.5c-1-1-4.5-1.2-5 2.2-.4 3 1.6 6.8 3.5 6.8.6 0 1-.4 1.5-.4s.9.4 1.5.4c1.9 0 3.9-3.8 3.5-6.8-.5-3.4-4-3.2-5-2.2zM8 4.5c0-1.3.7-2.5 2-3" />,
  Activity: () => <I d="M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM1.8 6.5c2 .8 4 .8 6.2-.5s4.2-1.3 6.2-.5M2 10c2-.9 4.1-.7 6 .5s4 1.4 6 .5" />,
  Objects: () => <I d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 00-2.5 8.2c.3.3.5.7.5 1.1v.2h4v-.2c0-.4.2-.8.5-1.1A4.5 4.5 0 008 1.5z" />,
  Symbols: () => <I d="M6 2L4.5 14M11.5 2L10 14M2.5 5.5h11M2 10.5h11" />,
};
export const FocusIcon = () => <I d="M1.5 2.5h13v8h-13zM2 13.5h3M6.5 13.5h3M11 13.5h3" />;
export const PhoneOffIcon = () => <I d="M2 9.5c3.6-3.3 8.4-3.3 12 0l-1.6 2.1-2.4-1v-1.9a7 7 0 00-4 0v1.9l-2.4 1z" />;
export const GrowIcon = () => <I d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />;
export const ShrinkIcon = () => <I d="M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5" />;
export const PeopleIcon = () => <I d="M6 7a2.3 2.3 0 100-4.6A2.3 2.3 0 006 7zM1.8 13.5c.5-2.5 2.2-4 4.2-4s3.7 1.5 4.2 4M10.5 2.6a2.3 2.3 0 010 4.3M12.2 9.8c1 .6 1.7 1.9 2 3.7" />;
export const InviteIcon = () => <I d="M6.5 7a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6zM2.2 13.5c.5-2.5 2.2-4 4.3-4 1 0 1.9.3 2.6 1M12.5 8.5v5M10 11h5" />;
export const GamesIcon = () => <I d="M4.5 4.5h7a3 3 0 013 3v1.5a2.5 2.5 0 01-4.3 1.7L9.5 10h-3l-.7.7A2.5 2.5 0 011.5 9V7.5a3 3 0 013-3zM5 6.5v2.5M3.8 7.8h2.4M10.5 7.3v.1M11.8 8.6v.1" />;
export const SlidersIcon = () => <I d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7M11 3v3M5 10v3" />;
export const GearIcon = () => <I d="M6.9 1.5h2.2l.4 1.8 1.4.6 1.6-1 1.6 1.6-1 1.6.6 1.4 1.8.4v2.2l-1.8.4-.6 1.4 1 1.6-1.6 1.6-1.6-1-1.4.6-.4 1.8H6.9l-.4-1.8-1.4-.6-1.6 1-1.6-1.6 1-1.6-.6-1.4-1.8-.4V6.9l1.8-.4.6-1.4-1-1.6 1.6-1.6 1.6 1 1.4-.6zM8 10.3a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6z" />;
