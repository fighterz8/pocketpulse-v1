import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import {
  ONBOARDING_UPLOAD_SUCCESS_FLAG,
  OnboardingUpload,
} from "./OnboardingUpload";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  apiFetch: mockApiFetch,
}));

vi.mock("../hooks/use-auth", () => ({
  useAuth: () => ({
    createAccount: {
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
      reset: vi.fn(),
    },
  }),
}));

const account = {
  id: 7,
  userId: 1,
  label: "Chase Sapphire",
  lastFour: "9911",
  accountType: "credit card",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function csvFile(name: string, body: string): File {
  return new File([body], name, { type: "text/csv" });
}

function renderOnboardingUpload(props: Partial<{
  onDone: () => void;
  onSkip: () => void;
}> = {}) {
  const onDone = props.onDone ?? vi.fn();
  const onSkip = props.onSkip ?? vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={0}>
        <OnboardingUpload
          account={account}
          onDone={onDone}
          onSkip={onSkip}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onDone, onSkip };
}

describe("OnboardingUpload tooltips", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    localStorage.removeItem(ONBOARDING_UPLOAD_SUCCESS_FLAG);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ uploads: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  it("reveals the skip-step-2 tooltip when the skip link is focused", async () => {
    renderOnboardingUpload();
    const skip = await screen.findByTestId("link-skip-onboarding-step-2");
    fireEvent.focus(skip);
    const content = await screen.findByTestId("hint-skip-step-2");
    expect(content).toHaveTextContent(/upload anytime/i);
  });
});

describe("OnboardingUpload", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    localStorage.removeItem(ONBOARDING_UPLOAD_SUCCESS_FLAG);
    // Stub the global fetch used by useUploads' useQuery so it doesn't
    // hit the network when the component mounts.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/uploads") {
          return new Response(JSON.stringify({ uploads: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Step 2 of 2 chrome and references the just-created account", () => {
    renderOnboardingUpload();
    expect(screen.getByTestId("text-onboarding-step")).toHaveTextContent(
      /step 2 of 2/i,
    );
    expect(
      screen.getByTestId("text-onboarding-upload-title"),
    ).toHaveTextContent(/now bring in your transactions/i);
    expect(screen.getByText(/Chase Sapphire/)).toBeInTheDocument();
  });

  it("calls onSkip when the user clicks Skip for now", () => {
    const { onSkip, onDone } = renderOnboardingUpload();
    fireEvent.click(screen.getByTestId("link-skip-onboarding-step-2"));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("uses 'Continue to dashboard' as the post-import dismiss label and writes the success flag", async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/upload") {
        return new Response(
          JSON.stringify({
            results: [
              {
                filename: "first.csv",
                uploadId: 1,
                status: "complete",
                rowCount: 12,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected apiFetch call: ${url}`);
    });

    const { onDone } = renderOnboardingUpload();
    const dz = screen.getByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("first.csv", "Date,Amount\n2025-01-01,1\n")],
      },
    });
    await screen.findByTestId("upload-queue");
    fireEvent.click(screen.getByTestId("button-import"));

    // The dismiss button reads "Continue to dashboard" (overrides the
    // default "Upload more files" label).
    const dismissBtn = await screen.findByTestId("button-upload-more");
    expect(dismissBtn).toHaveTextContent(/continue to dashboard/i);

    // Success flag is written once the response merges in.
    await waitFor(() => {
      expect(
        localStorage.getItem(ONBOARDING_UPLOAD_SUCCESS_FLAG),
      ).toBe("12");
    });

    fireEvent.click(dismissBtn);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not write the success flag when the import response yields zero new rows", async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/upload") {
        return new Response(
          JSON.stringify({
            results: [
              {
                filename: "first.csv",
                uploadId: 1,
                status: "complete",
                rowCount: 0,
                previouslyImported: 5,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected apiFetch call: ${url}`);
    });
    renderOnboardingUpload();
    const dz = screen.getByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("first.csv", "Date,Amount\n2025-01-01,1\n")],
      },
    });
    await screen.findByTestId("upload-queue");
    fireEvent.click(screen.getByTestId("button-import"));
    await screen.findByTestId("button-upload-more");
    expect(localStorage.getItem(ONBOARDING_UPLOAD_SUCCESS_FLAG)).toBeNull();
  });
});
