import type { Metadata } from "next";

import { RecordProvider } from "@/lib/ui/record";

import "./globals.css";

export const metadata: Metadata = {
  title: "Datum — proof before payment for a build",
  description:
    "Milestone escrow for construction payments. Pay in by M-Pesa, funds are held in a contract on Avalanche Fuji, and each stage is paid after its photographs pass four checks and two of three attesters sign.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap"
          rel="stylesheet"
        />
        <meta name="theme-color" content="#0A4A35" />
      </head>
      <body>
        <RecordProvider>{children}</RecordProvider>
      </body>
    </html>
  );
}
