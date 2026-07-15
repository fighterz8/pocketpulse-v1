import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Landing } from "./Landing";

describe("Landing", () => {
  it("leads with the product promise and a clear free-beta action", () => {
    const { container } = render(<Landing />);

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Your bank statements should tell you more.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/without connecting your bank account/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a free account" })).toHaveAttribute(
      "href",
      "/auth",
    );
    expect(screen.getByText("No bank password required")).toBeInTheDocument();
    expect(screen.getByText("Every finding stays reviewable")).toBeInTheDocument();
  });

  it("presents connected product proof and plain-language outcomes", () => {
    render(<Landing />);

    expect(
      screen.getByRole("figure", {
        name: /dashboard showing monthly cash flow, recurring expenses, a leak hunter finding/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where did the money go?" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What keeps charging me?" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What deserves a closer look?" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/open the exact matching transactions/i)).toBeInTheDocument();
  });

  it("keeps navigation, privacy, and legal routes explicit", () => {
    render(<Landing />);

    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Product" })).toHaveAttribute("href", "#product");
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "#how");
    expect(screen.getAllByRole("link", { name: "Privacy" })[0]).toHaveAttribute(
      "href",
      "#privacy",
    );
    expect(screen.getByRole("link", { name: "Read the privacy policy →" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });
});
