"use client";

import { Component, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; message: string; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="min-h-screen bg-[#001e2b] flex flex-col items-center justify-center gap-4 px-4">
          <AlertTriangle className="text-red-400" size={36} />
          <h2 className="text-white text-lg font-semibold">Something went wrong</h2>
          <p className="text-[#5c6c7a] text-sm text-center max-w-sm">{this.state.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, message: "" })}
            className="mt-2 px-4 py-2 bg-[#1c2d38] text-white rounded-lg text-sm hover:bg-[#003d4f] transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
