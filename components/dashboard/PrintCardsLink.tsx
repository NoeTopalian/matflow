"use client";

import Link from "next/link";
import { Printer } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/**
 * The way into /print/member-cards. Without it the printable card sheet exists
 * but can only be reached by typing the URL, which is how a shipped feature
 * goes unused.
 *
 * A client component rather than a bare Link on the members page: everything
 * exported from `components/ui/button` crosses the "use client" boundary, so a
 * server component importing `buttonVariants` receives a client reference and
 * calling it throws at render. Styling comes from the Button primitive's own
 * variants (UI-RULES §5) rather than a hand-rolled copy, and it renders an
 * anchor rather than a raw button element, so the rawButton ratchet is
 * untouched. (Writing that element name here in angle brackets would itself
 * have raised the ratchet — it counts the text, comments included.)
 *
 * It opens in a new tab on purpose: the sheet renders outside the dashboard
 * shell — an A4 page cannot live in the layout's container — so there is no
 * chrome on it to navigate back with.
 */
export function PrintCardsLink() {
  return (
    <div className="mb-4 flex justify-end">
      <Link
        href="/print/member-cards"
        target="_blank"
        rel="noopener"
        className={buttonVariants({ variant: "secondary", size: "compact" })}
      >
        <Printer aria-hidden="true" />
        Print member cards
      </Link>
    </div>
  );
}

export default PrintCardsLink;
