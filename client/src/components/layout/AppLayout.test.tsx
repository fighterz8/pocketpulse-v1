import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AppLayout } from "./AppLayout";

vi.mock("../../hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: 1,
      email: "nav@example.com",
      displayName: "Nav User",
      companyName: null,
      isDev: false,
      devToolsEnabled: false,
    },
  }),
}));

vi.mock("../../hooks/use-theme", () => ({
  useTheme: () => ({
    isDark: false,
    toggleDark: vi.fn(),
  }),
}));

vi.mock("./BrandPulse", () => ({
  BrandPulse: () => <span>PocketPulse</span>,
}));

function renderLayout(path = "/leaks") {
  const memory = memoryLocation({ path, record: true });
  return render(
    <Router hook={memory.hook}>
      <AppLayout onLogout={vi.fn()}>
        <main>Content</main>
      </AppLayout>
    </Router>,
  );
}

describe("AppLayout", () => {
  it("uses the Leak Hunter name in primary navigation", () => {
    renderLayout();

    const leakLink = screen.getByTestId("nav-link-leaks");
    expect(leakLink).toHaveTextContent("Leak Hunter");
    expect(screen.queryByText("Leak Detection")).not.toBeInTheDocument();
  });
});
