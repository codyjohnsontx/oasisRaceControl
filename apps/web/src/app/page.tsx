import Link from "next/link";

export default function Home() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-10 p-8">
      <div className="text-center">
        <p className="text-accent font-semibold tracking-[0.3em] uppercase text-sm">
          Oasis Sim Racing
        </p>
        <h1 className="text-5xl font-black tracking-tight mt-2">RACE CONTROL</h1>
        <p className="text-muted mt-4 max-w-sm">
          Scan the QR code on your simulator to check in and start setting lap
          times.
        </p>
      </div>
      <nav className="flex flex-col items-center gap-3 text-lg">
        <Link
          href="/me"
          className="px-8 py-3 rounded-lg bg-accent font-bold uppercase tracking-wider"
        >
          My laps
        </Link>
        <Link href="/tv" className="text-muted underline underline-offset-4">
          Live timing board
        </Link>
      </nav>
    </main>
  );
}
