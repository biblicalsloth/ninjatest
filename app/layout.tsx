import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { GeistPixelSquare } from "geist/font/pixel";
import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "@/components/side-nav";
import { AuthListener } from "@/components/auth-listener";
import { NinjaCoachMount } from "@/components/ninja-coach-mount";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ninjatest — 1v1 CAT Battles",
  description: "Chess.com for CAT prep. Challenge a friend to a real-time, ELO-rated aptitude battle.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${GeistPixelSquare.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AuthListener />
        <SideNav />
        {children}
        <NinjaCoachMount />
        <Toaster richColors theme="dark" />
      </body>
    </html>
  );
}
