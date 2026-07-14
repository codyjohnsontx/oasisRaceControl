"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Every surface, so you can jump between them without typing URLs.
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/r/demo-rig-1", label: "Check-in" },
  { href: "/me", label: "My laps" },
  { href: "/leaderboards", label: "Leaderboards" },
  { href: "/tv", label: "TV board" },
  { href: "/staff", label: "Staff" },
  { href: "/staff/login", label: "Staff login" },
];

/**
 * Dev-only quick-nav. Gated to development builds — it early-returns in
 * production, so a driver never sees a "Staff" link and it isn't part of the
 * real UI. Collapsed to a small corner pill so it stays out of the way.
 */
export function DevNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-3 right-3 z-50 font-sans">
      {open ? (
        <nav className="flex flex-col gap-1 rounded-xl border border-edge bg-surface/95 backdrop-blur p-2 shadow-xl">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-muted text-[10px] font-bold uppercase tracking-wider">
              Dev nav
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted text-sm leading-none px-1"
              aria-label="Collapse dev nav"
            >
              ×
            </button>
          </div>
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
                pathname === l.href ? "bg-accent text-bg" : "text-ink hover:bg-raised"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-edge bg-surface/95 backdrop-blur px-3 py-2 text-xs font-bold uppercase tracking-wider text-muted shadow-lg"
        >
          ⚑ dev
        </button>
      )}
    </div>
  );
}
