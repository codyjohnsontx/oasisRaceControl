import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <main className="grid-bg flex-1 flex flex-col items-center justify-center gap-10 p-8">
      <div className="text-center flex flex-col items-center">
        <Image
          src="/Oasis_Logo_Vector.png"
          alt="Oasis Sim Racing"
          width={388}
          height={243}
          priority
          className="w-72 sm:w-96 h-auto"
        />
        <h1 className="font-display gradient-text text-4xl sm:text-5xl font-black tracking-tight mt-4">
          RACE CONTROL
        </h1>
        <p className="text-muted mt-4 max-w-sm">
          Scan the QR code on your simulator to check in and start setting lap
          times.
        </p>
      </div>
      <nav className="flex flex-col items-center gap-4 text-lg">
        <Link
          href="/me"
          className="px-10 py-3 rounded-full bg-accent text-bg glow-cyan font-display font-bold uppercase tracking-wider"
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
