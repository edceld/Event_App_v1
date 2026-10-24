import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Event Gate — Tickets & Check-in",
  description: "Event tickets and secure check-in for your team.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
