import type { Metadata, Viewport } from "next";
import { Archivo, Hanken_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ThemeKeeper from "@/components/ThemeKeeper";

// TapeScore design system: Archivo = display/brand, Hanken Grotesk = body/UI,
// Spline Sans Mono = log/time/tape readouts.
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], display: "swap" });
const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"], display: "swap" });
const splineMono = Spline_Sans_Mono({ variable: "--font-spline-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://tapescore.app"),
  title: "TapeScore",
  description: "Game film for traders — an AI trading journal that reviews your game and captures more edge.",
  applicationName: "TapeScore",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/brand/tapescore-favicon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
  // og:image / twitter:image are supplied by src/app/opengraph-image.png +
  // twitter-image.png (Next auto-injects those). These add the title/description
  // so the shared card reads as a branded preview, not just an image.
  openGraph: {
    type: "website",
    siteName: "TapeScore",
    title: "TapeScore — Game film for traders",
    description: "An AI trading journal that reviews your game and captures more edge.",
    url: "https://tapescore.app",
  },
  twitter: {
    card: "summary_large_image",
    title: "TapeScore — Game film for traders",
    description: "An AI trading journal that reviews your game and captures more edge.",
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
      suppressHydrationWarning
    >
      <head>
        {/*
          Apply the saved theme BEFORE first paint. Without this, a light-mode
          user gets a carbon flash on every navigation: the server can't know
          their choice, and React only runs after hydration. Deliberately inline
          and blocking — it has to win the race with the first paint.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('ts-theme')==='light'){document.documentElement.setAttribute('data-theme','light')}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-gray-950 text-white">
        {/* Re-asserts the saved theme on every route change. The head script
            above covers first paint; this covers client-side navigation, where
            an imperatively-set <html> attribute isn't guaranteed to survive
            reconciliation. See ThemeKeeper. */}
        <ThemeKeeper />
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
