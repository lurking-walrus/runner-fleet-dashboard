/**
 * The Runner Fleet mark: a stack of three server units with status LEDs, on a dark rounded badge.
 * Adapted from the Lucide "server" icon (two outlined units, ISC; Lucide derives it from Feather,
 * MIT; see THIRD_PARTY_NOTICES.md): a third unit for the fleet, solid units and larger LEDs so the
 * status colours (online green, busy blue, as on the page) survive at 16 px. The badge stays dark in light
 * mode too, like an app icon, so one file serves the tab and the header.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Runner Fleet"><rect width="32" height="32" rx="7" fill="#12151d"/><rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#2c3346"/><g fill="#dfe3ec"><rect x="5" y="5" width="22" height="6" rx="1.6"/><rect x="5" y="13" width="22" height="6" rx="1.6"/><rect x="5" y="21" width="22" height="6" rx="1.6"/></g><g stroke="#8a92a6" stroke-width="1.5" stroke-linecap="round"><path d="M16.5 8h6.5M16.5 16h6.5M16.5 24h6.5"/></g><g stroke="#12151d" stroke-width="0.9"><circle cx="10" cy="8" r="2.2" fill="#2fbf7f"/><circle cx="10" cy="16" r="2.2" fill="#2fbf7f"/><circle cx="10" cy="24" r="2.2" fill="#4a7ff0"/></g></svg>`;

/** `<link rel="icon">` with the mark inline, so the icon needs no route and no session. */
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}" />`;

/** The page title with the mark in front of it. */
export function brandTitle(text: string): string {
  return `<span class="brand-logo" aria-hidden="true">${LOGO_SVG.replace('role="img" aria-label="Runner Fleet"', 'focusable="false"')}</span>${text}`;
}

/** Shared by every page's <style>: the header mark sits on the h1's line, sized to it. */
export const BRAND_CSS = `h1 { display: flex; align-items: center; gap: 10px; } .brand-logo { display: inline-flex; width: 28px; height: 28px; flex-shrink: 0; } .brand-logo svg { width: 100%; height: 100%; }`;
