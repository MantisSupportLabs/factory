/**
 * Geometric line-icon set for the tactical UI. Single source for both React
 * rendering (<Icon/>) and raw markup (iconMarkup) used by map DOM markers.
 * Stroke-based, square caps, 24px grid.
 */

export type IconName =
  | 'pin' | 'dozer' | 'toolbox' | 'truck' | 'camera' | 'antenna' | 'spark'
  | 'file' | 'clock' | 'shield' | 'plug' | 'cog' | 'trailer' | 'layers'
  | 'chevron-left' | 'chevron-right' | 'x' | 'printer' | 'check' | 'warning'
  | 'crosshair' | 'globe' | 'cube' | 'mountain';

const P: Record<IconName, string> = {
  pin: '<path d="M12 21c-4.2-4.6-6.3-7.9-6.3-10.6C5.7 6.9 8.5 4.2 12 4.2s6.3 2.7 6.3 6.2C18.3 13.1 16.2 16.4 12 21z"/><circle cx="12" cy="10.3" r="2.2"/>',
  dozer: '<rect x="3" y="15.5" width="10.5" height="4"/><rect x="5" y="10.5" width="5.5" height="5"/><path d="M10.5 12.5 15.5 7.5l4.5 3-1.8 4"/><path d="M18.2 14.5l2.8 1"/>',
  toolbox: '<rect x="3.5" y="9" width="17" height="10"/><path d="M9 9V6h6v3M3.5 13.5h17M12 12.2v2.6"/>',
  truck: '<rect x="2.5" y="7" width="12" height="8"/><path d="M14.5 10h3.8l3.2 3.2V15h-2.3"/><circle cx="7" cy="17" r="1.8"/><circle cx="17" cy="17" r="1.8"/>',
  camera: '<rect x="3" y="7.5" width="18" height="11.5"/><circle cx="12" cy="13.2" r="3.4"/><path d="M8.5 7.5 10 5h4l1.5 2.5"/>',
  antenna: '<path d="M12 21V10.5M8.3 21h7.4"/><path d="M8.4 8.6a5.1 5.1 0 0 1 7.2 0M6 6.2a8.5 8.5 0 0 1 12 0"/><circle cx="12" cy="10" r="1.4"/>',
  spark: '<path d="M12 3l1.8 7.2L21 12l-7.2 1.8L12 21l-1.8-7.2L3 12l7.2-1.8z"/>',
  file: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.7 12.5h4.6M9.7 15.5h4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.4 2"/>',
  shield: '<path d="M12 3.3 19 6v5.6c0 4.4-2.9 7.4-7 8.9-4.1-1.5-7-4.5-7-8.9V6z"/><path d="M9 11.6l2 2 4-4"/>',
  plug: '<path d="M9 7V3.5M15 7V3.5"/><path d="M7.5 7h9v3.8a4.5 4.5 0 0 1-9 0z"/><path d="M12 15.3v5.2"/>',
  cog: '<circle cx="12" cy="12" r="3.6"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>',
  trailer: '<rect x="3" y="7.5" width="13" height="7.5"/><circle cx="7.5" cy="17.6" r="1.7"/><circle cx="11.8" cy="17.6" r="1.7"/><path d="M16 11.3h5.5"/>',
  layers: '<path d="M12 3.5 21 8.5l-9 5-9-5z"/><path d="M4.6 12.4 12 16.5l7.4-4.1M4.6 16.1 12 20.2l7.4-4.1"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  printer: '<path d="M7 8V3.5h10V8"/><path d="M5 8h14v7h-3.5M8.5 15H5V8"/><rect x="8.5" y="12.5" width="7" height="8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warning: '<path d="M12 3.8 21.4 20H2.6z"/><path d="M12 9.5v4.7M12 16.8v.2"/>',
  crosshair: '<circle cx="12" cy="12" r="6.8"/><path d="M12 2.6v4M12 17.4v4M2.6 12h4M17.4 12h4"/>',
  globe: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c3.1 2.6 3.1 14.2 0 16.8-3.1-2.6-3.1-14.2 0-16.8z"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  mountain: '<path d="M2.8 19.5 9.8 6l4.3 7.6 2.4-3.6 4.7 9.5z"/>',
};

export function iconMarkup(name: IconName, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter">${P[name]}</svg>`;
}

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: P[name] }}
    />
  );
}
