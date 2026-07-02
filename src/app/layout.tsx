import type { Metadata, Viewport } from "next";
import { Archivo, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

// TapeScore design system: Archivo = display/brand, Hanken Grotesk = body/UI,
// Spline Sans Mono = log/time/tape readouts.
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"], display: "swap" });
const splineMono = Spline_Sans_Mono({ variable: "--font-spline-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "TapeScore",
  description: "Game film for traders — an AI trading journal that reviews your game and captures more edge.",
  applicationName: "TapeScore",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/brand/tapescore-favicon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
  // iOS standalone (Add to Home Screen) behavior.
  appleWebApp: {
    capable: true,
    title: "TapeScore",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#1B1D21",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // draw under the notch on standalone iOS
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${hanken.variable} ${splineMono.variable} antialiased`}
    >
      <body className="min-h-screen bg-gray-950 text-white">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
