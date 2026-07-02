import type { Metadata } from "next";
import { Archivo, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

// TapeScore design system: Archivo = display/brand, Hanken Grotesk = body/UI,
// Spline Sans Mono = log/time/tape readouts.
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"], display: "swap" });
const splineMono = Spline_Sans_Mono({ variable: "--font-spline-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "TapeScore",
  description: "Game film for traders — an AI trading journal to review your trading game and capture your edge.",
  icons: { icon: "/brand/tapescore-favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${hanken.variable} ${splineMono.variable} antialiased`}
    >
      <body className="min-h-screen bg-gray-950 text-white">{children}</body>
    </html>
  );
}
