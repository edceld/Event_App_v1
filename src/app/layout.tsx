import type { Metadata } from "next";
import "./globals.css";
import { RELEASE_LABEL } from "@/lib/release";
export const metadata: Metadata = {
  title: `Event Gate — ${RELEASE_LABEL}`,
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
