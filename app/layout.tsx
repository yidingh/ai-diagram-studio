import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Diagram Studio",
  description: "Describe a change, review it, and continue editing in draw.io.",
};
/** Server-rendered page shell; browser workflow state lives in the client components. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
