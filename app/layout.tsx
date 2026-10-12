import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-Assisted Draw.io Architect",
  description: "Generate, review, and edit validated draw.io architecture diagrams.",
};
/** Server-rendered page shell; browser workflow state lives in the client components. */
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
