import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSetup } from "./AccountSetup";

const { mockCreateAccount } = vi.hoisted(() => ({
  mockCreateAccount: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
}));

vi.mock("../hooks/use-auth", () => ({
  useAuth: () => ({ createAccount: mockCreateAccount }),
}));

function setup() {
  const onCreated = vi.fn();
  const onSkip = vi.fn();
  render(<AccountSetup onCreated={onCreated} onSkip={onSkip} />);
  return { onCreated, onSkip };
}

describe("AccountSetup", () => {
  beforeEach(() => {
    mockCreateAccount.mutateAsync.mockReset();
    mockCreateAccount.reset.mockReset();
    mockCreateAccount.isPending = false;
    mockCreateAccount.error = null;
  });

  it("renders the Step 1 of 2 chrome and the new bank-account heading", () => {
    setup();
    expect(screen.getByTestId("text-onboarding-step")).toHaveTextContent(
      /step 1 of 2/i,
    );
    expect(screen.getByTestId("text-account-setup-title")).toHaveTextContent(
      /add your first bank account/i,
    );
    // Subhead explains why we need an account.
    expect(
      screen.getByText(/PocketPulse organizes transactions/i),
    ).toBeInTheDocument();
  });

  it("renders the bank-card preview and updates as the user types", () => {
    setup();
    const preview = screen.getByTestId("account-preview");
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId("text-preview-label")).toHaveTextContent(
      "Your account",
    );
    expect(screen.getByTestId("text-preview-digits")).toHaveTextContent(
      "•••• ••••",
    );

    fireEvent.change(screen.getByTestId("input-account-label"), {
      target: { value: "Chase Checking" },
    });
    fireEvent.change(screen.getByTestId("input-account-last-four"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByTestId("input-account-type"), {
      target: { value: "checking" },
    });

    expect(screen.getByTestId("text-preview-label")).toHaveTextContent(
      "Chase Checking",
    );
    expect(screen.getByTestId("text-preview-digits")).toHaveTextContent(
      "•••• 1234",
    );
    expect(screen.getByTestId("text-preview-type")).toHaveTextContent(
      "checking",
    );
  });

  it("submits the form and calls onCreated with the created account on success", async () => {
    const created = {
      id: 7,
      userId: 1,
      label: "Chase",
      lastFour: null,
      accountType: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockCreateAccount.mutateAsync.mockResolvedValueOnce({ account: created });
    const { onCreated, onSkip } = setup();

    fireEvent.change(screen.getByTestId("input-account-label"), {
      target: { value: "Chase" },
    });
    fireEvent.click(screen.getByTestId("button-create-account"));

    await waitFor(() => {
      expect(mockCreateAccount.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Chase" }),
      );
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(created);
    });
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("does NOT call onCreated when createAccount fails", async () => {
    mockCreateAccount.mutateAsync.mockRejectedValueOnce(
      new Error("Network down"),
    );
    mockCreateAccount.error = new Error("Network down");
    const { onCreated } = setup();
    fireEvent.change(screen.getByTestId("input-account-label"), {
      target: { value: "Chase" },
    });
    fireEvent.click(screen.getByTestId("button-create-account"));
    await waitFor(() => {
      expect(mockCreateAccount.mutateAsync).toHaveBeenCalled();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("calls onSkip when the user clicks Skip for now", () => {
    const { onSkip, onCreated } = setup();
    const link = screen.getByTestId("link-skip-onboarding-step-1");
    expect(link).toHaveTextContent(/skip for now/i);
    fireEvent.click(link);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(mockCreateAccount.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks empty submission with an inline validation error", async () => {
    setup();
    const form = screen.getByTestId("input-account-label").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByTestId("error-account-setup")).toHaveTextContent(
        /account name is required/i,
      );
    });
    expect(mockCreateAccount.mutateAsync).not.toHaveBeenCalled();
  });
});
