"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type ScreenLink = {
  href: string;
  label: string;
  description: string;
  match: (pathname: string) => boolean;
};

type ScreenGroup = {
  label: string;
  links: ScreenLink[];
};

const SCREEN_GROUPS: ScreenGroup[] = [
  {
    label: "Driver journey",
    links: [
      {
        href: "/",
        label: "Welcome",
        description: "Public entry point",
        match: (pathname) => pathname === "/",
      },
      {
        href: "/r/demo-rig-1",
        label: "Rig check-in",
        description: "QR arrival flow",
        match: (pathname) => pathname.startsWith("/r/"),
      },
      {
        href: "/me",
        label: "My laps",
        description: "Driver results and profile",
        match: (pathname) => pathname === "/me",
      },
    ],
  },
  {
    label: "Venue surfaces",
    links: [
      {
        href: "/leaderboards",
        label: "Leaderboards",
        description: "Public result browser",
        match: (pathname) => pathname === "/leaderboards",
      },
      {
        href: "/tv",
        label: "Live timing",
        description: "Front-of-store display",
        match: (pathname) => pathname === "/tv",
      },
    ],
  },
  {
    label: "Operations",
    links: [
      {
        href: "/staff",
        label: "Staff dashboard",
        description: "Rig and lap controls",
        match: (pathname) => pathname === "/staff",
      },
      {
        href: "/staff/login",
        label: "Staff sign-in",
        description: "Protected access",
        match: (pathname) => pathname === "/staff/login",
      },
    ],
  },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Interview-ready screen index shared by every route in the application. */
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={open ? "Close screen menu" : "Open screen menu"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={titleId}
        onClick={() => setOpen(true)}
        className={`group fixed right-3 top-3 z-[70] flex h-11 items-center gap-2 rounded-full border px-3.5 text-xs font-bold uppercase tracking-[0.14em] shadow-xl backdrop-blur-md transition duration-200 sm:right-5 sm:top-5 ${
          open
            ? "pointer-events-none translate-x-2 opacity-0"
            : "border-edge bg-surface/90 text-ink hover:border-accent hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        }`}
      >
        <span
          aria-hidden="true"
          className="grid grid-cols-2 gap-0.5 transition-transform duration-200 group-hover:rotate-90"
        >
          <span className="h-1.5 w-1.5 rounded-[2px] bg-accent" />
          <span className="h-1.5 w-1.5 rounded-[2px] bg-ink" />
          <span className="h-1.5 w-1.5 rounded-[2px] bg-ink" />
          <span className="h-1.5 w-1.5 rounded-[2px] bg-accent-2" />
        </span>
        Screens
      </button>

      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-[60] bg-bg/75 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        ref={panelRef}
        id={titleId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        aria-hidden={!open}
        inert={!open}
        className={`fixed inset-y-0 right-0 z-[70] flex w-full max-w-sm flex-col border-l border-edge bg-surface/98 shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-start justify-between border-b border-edge px-6 py-6">
          <div>
            <p className="font-display text-[10px] font-bold uppercase tracking-[0.28em] text-accent">
              Oasis Race Control
            </p>
            <h2
              id={`${titleId}-heading`}
              className="mt-2 text-2xl font-bold tracking-tight text-ink"
            >
              Screen index
            </h2>
            <p className="mt-1 text-sm text-muted">
              Jump between interview demo surfaces.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close screen menu"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-edge text-xl text-muted transition hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <nav aria-label="Application screens" className="flex-1 overflow-y-auto px-6 py-5">
          {SCREEN_GROUPS.map((group) => (
            <section key={group.label} className="mb-6 last:mb-0">
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
                {group.label}
              </h3>
              <div className="border-t border-edge">
                {group.links.map((link, index) => {
                  const active = link.match(pathname);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      onNavigate={() => setOpen(false)}
                      className={`group/link flex items-center gap-4 border-b border-edge py-3.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        active ? "text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      <span
                        className={`laptime w-6 text-xs ${
                          active ? "text-accent" : "text-muted"
                        }`}
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 font-display text-sm font-bold">
                          {link.label}
                          {active && (
                            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {link.description}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={`text-lg transition-transform duration-200 group-hover/link:translate-x-1 ${
                          active ? "text-accent" : "text-muted"
                        }`}
                      >
                        →
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>

        <footer className="border-t border-edge px-6 py-4">
          <p className="text-xs text-muted">
            <kbd className="rounded border border-edge bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink">
              Esc
            </kbd>{" "}
            closes this menu
          </p>
        </footer>
      </aside>
    </>
  );
}
