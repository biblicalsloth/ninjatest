import type { Metadata } from "next";
import PricingClient from "./pricing-client";

export const metadata: Metadata = {
  title: "Pricing — Ninjatest",
  description: "Free ranked battles, or go unlimited with Challenger and Grandmaster.",
};

export default function PricingPage() {
  return <PricingClient />;
}
