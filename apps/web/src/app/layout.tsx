import type { Metadata, Viewport } from "next";
import { Orbitron, Rajdhani, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { NavMenu } from "@/components/nav-menu";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Lap times keep Geist Mono: tabular numerals so timing columns line up.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Oasis Race Control",
  description: "Driver check-in, live timing, and leaderboards for Oasis Sim Racing",
};

export const viewport: Viewport = {
  themeColor: "#0a0a14",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${orbitron.variable} ${rajdhani.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-bg text-ink">
        {children}
        {/* NavMenu reads the query string to leave itself off the /tv event
            view. A prerendered page only knows its query in the browser, so
            the boundary lets those pages render without the menu and add it
            on the client. */}
        <Suspense fallback={null}>
          <NavMenu />
        </Suspense>
      </body>
    </html>
  );
}
