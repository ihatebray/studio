import React from 'react';

/**
 * Custom rounded icon set.
 * All transport icons use stroke with round linecap/linejoin for a softer feel.
 * Sized for inline use at their default width/height.
 */
const Icons = {
  Library: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 22V2h2v20H3zm4 0V2h2v20H7zm4-7V2h2v13h-2zm4 7V2h2v20h-2zm4-5V2h2v15h-2z"/></svg>
  ),
  Search: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
    </svg>
  ),
  LibrarySidebar: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  ),
  PlaylistSidebar: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M14 7.5v7a2.5 2.5 0 11-2-2.45V7.5h2z" fill="currentColor" stroke="none" />
    </svg>
  ),
  HeartSidebar: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s-7-5.3-8.5-9C2 8.5 4 5 7.5 5c2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3 3.5 0 5.5 3.5 4 7-1.5 3.7-8.5 9-8.5 9z" />
    </svg>
  ),
  AlbumSidebar: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  NewReleases: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  Stats: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      {/* Bold filled bar chart. Same 20×20 / 0 0 24 24 frame as every other
          dock icon; bars span the box (≈4–20 vertically, 3→21 horizontally)
          so the filled weight reads at the same scale as the stroked siblings. */}
      <rect x="3" y="11" width="4.6" height="9" rx="1.4" />
      <rect x="9.7" y="4" width="4.6" height="16" rx="1.4" />
      <rect x="16.4" y="8" width="4.6" height="12" rx="1.4" />
    </svg>
  ),
  Play: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 4.5a1 1 0 0 1 1.5-.86l10 7a1 1 0 0 1 0 1.72l-10 7A1 1 0 0 1 7.5 18.5v-14z" fill="currentColor" />
    </svg>
  ),
  Pause: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4.5" width="4" height="15" rx="1.5" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.5" />
    </svg>
  ),
  SkipBack: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 20L9 12l10-8v16z" fill="currentColor" stroke="none" />
      <line x1="6" y1="5" x2="6" y2="19" />
    </svg>
  ),
  SkipForward: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4l10 8-10 8V4z" fill="currentColor" stroke="none" />
      <line x1="18" y1="5" x2="18" y2="19" />
    </svg>
  ),
  Shuffle: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5" />
      <path d="M4 20L21 3" />
      <path d="M21 16v5h-5" />
      <path d="M15 15l6 6" />
      <path d="M4 4l5 5" />
    </svg>
  ),
  Repeat: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  RepeatOne: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      <text x="12" y="14.5" textAnchor="middle" fontSize="7.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="system-ui, sans-serif">1</text>
    </svg>
  ),
  Volume: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a9.5 9.5 0 0 1 0 14" />
    </svg>
  ),
  Settings: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.81 1.02 1.51 1.08H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  ChevronRight: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  Trash: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  ),
  Edit: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  ),
  /** Immersive / atmosphere (sparkles). */
  Immersive: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.4 4.3h4.5l-3.6 2.6 1.4 4.3L12 11.2 8.3 13.2l1.4-4.3-3.6-2.6h4.5L12 2zM4 14l.9 2.8h3l-2.4 1.7.9 2.8-2.4-1.8-2.4 1.8.9-2.8-2.4-1.7h3L4 14zm16 0l.9 2.8h3l-2.4 1.7.9 2.8-2.4-1.8-2.4 1.8.9-2.8-2.4-1.7h3L20 14z" />
    </svg>
  ),
};

export default Icons;
