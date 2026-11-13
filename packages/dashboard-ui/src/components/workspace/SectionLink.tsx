import type { AnchorHTMLAttributes } from "react";

/**
 * Scroll to an in-page section and move focus into it. Hash routing owns
 * `location.hash`, so in-page links must never navigate.
 */
export function scrollToSection(id: string): void {
  const section = document.getElementById(id);
  section?.scrollIntoView({ block: "start" });
  // Move focus too, so keyboard and screen-reader users land in the section.
  section?.focus({ preventScroll: true });
}

/** An anchor to a section on this page (`id` without the `#`). */
export function SectionLink({
  to,
  onClick,
  ...props
}: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      {...props}
      href={`#${to}`}
      data-section-link=""
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        scrollToSection(to);
      }}
    />
  );
}
