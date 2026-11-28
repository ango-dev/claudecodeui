type AntigravityLogoProps = {
  className?: string;
};

/**
 * Rendered by the shared LLMProviderLogo when the provider is Antigravity.
 *
 * An original monochrome mark in the house style of the other agent logos
 * (OpenCode's tile): a theme-coloured tile holding a chevron that hovers above
 * its own short ground line, the gap between them reading as "lifting off".
 * It is drawn only with theme classes, so it follows light and dark mode and
 * borrows nothing from Google's own artwork or colours.
 */
const AntigravityLogo = ({ className = 'w-5 h-5' }: AntigravityLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Antigravity"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="4" className="fill-foreground" />
    <path
      d="M6.9 13.6 12 8.2l5.1 5.4M9 17.4h6"
      className="stroke-background"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default AntigravityLogo;
