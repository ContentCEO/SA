/**
 * Check 32 P12: the first thing Tab reaches on every screen. Hidden until it has focus, then
 * shown top-left, 44px tall, with the normal focus ring; Enter moves focus to the screen's
 * <main id="main" tabIndex={-1}>. A plain anchor: the browser's own jump moves focus there.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-tap focus:items-center focus:rounded-md focus:border-2 focus:border-foreground focus:bg-background focus:px-4 focus:font-semibold focus:text-foreground"
    >
      Skip to content
    </a>
  );
}
