import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Realizah",
  description:
    "Paste the AI tool you already pay for and the task you use it for. Realizah runs real calls and shows dollars per successful outcome.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <Link href="/" className="brand">Realizah</Link>
            <nav>
              <Link href="/">Compare</Link>
              <Link href="/pricing">Pricing</Link>
            </nav>
          </header>
          {children}
          <footer className="foot">
            <span>Realizah. Original work for Galuxium Nexus V2.</span>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/pricing">Pricing</Link>
          </footer>
        </div>
      </body>
    </html>
  );
}
