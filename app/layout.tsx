import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Datum — escrow for construction that has to be proven",
  description:
    "Deposits held in escrow on Avalanche and released only against geotagged, verified site photographs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <meta name="theme-color" content="#0A4A35" />
      </head>
      <body>{children}</body>
    </html>
  );
}
