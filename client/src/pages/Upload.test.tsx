// Tests for the Upload page + embeddable UploadCore.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

type AccountRow = {
  id: number;
  userId: number;
  label: string;
  lastFour: string;
  accountType: string;
  createdAt: string;
  updatedAt: string;
};

let mockAccounts: AccountRow[] = [];
let mockUploadResponse: {
  status: number;
  body: unknown;
} = {
  status: 200,
  body: { results: [] },
};

function makeAccount(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    userId: 1,
    label: "Checking",
    lastFour: "1234",
    accountType: "checking",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function mockFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input.toString();
  if (url === "/api/auth/me") {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          authenticated: true,
          user: { id: 1, email: "test@test.com", displayName: "Test" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  if (url === "/api/accounts" && (!init || init.method === undefined || init.method === "GET")) {
    return Promise.resolve(
      new Response(JSON.stringify({ accounts: mockAccounts }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (url === "/api/uploads") {
    return Promise.resolve(
      new Response(JSON.stringify({ uploads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (url === "/api/upload" && init?.method === "POST") {
    return Promise.resolve(
      new Response(JSON.stringify(mockUploadResponse.body), {
        status: mockUploadResponse.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return Promise.resolve(
    new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  mockAccounts = [makeAccount()];
  mockUploadResponse = { status: 200, body: { results: [] } };
  vi.stubGlobal("fetch", vi.fn(mockFetch));
});

import { TooltipProvider } from "../components/ui/tooltip";
import { Upload } from "./Upload";

function renderUpload() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>
        <Upload />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function csvFile(name: string, content: string) {
  return new File([content], name, { type: "text/csv" });
}

describe("Upload page basics (existing test ids)", () => {
  it("renders the page title", async () => {
    renderUpload();
    expect(screen.getByText("Upload Statements")).toBeInTheDocument();
    await screen.findByTestId("upload-dropzone");
  });

  it("renders the drop zone (data-testid stable)", async () => {
    renderUpload();
    expect(await screen.findByTestId("upload-dropzone")).toBeInTheDocument();
  });

  it("shows the supported-formats line", async () => {
    renderUpload();
    const formats = await screen.findByTestId("text-supported-formats");
    expect(formats).toHaveTextContent(/Chase, Amex, Bank of America, Citi/i);
  });

  it("has a hidden file input", async () => {
    renderUpload();
    await screen.findByTestId("upload-dropzone");
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("accept", ".csv");
  });

  it("reveals the dropzone tooltip when the dropzone is focused", async () => {
    renderUpload();
    const dropzone = await screen.findByTestId("upload-dropzone");
    fireEvent.focus(dropzone);
    const content = await screen.findByTestId("hint-dropzone");
    expect(content).toHaveTextContent(/bank-statement csvs/i);
  });
});

describe("Bank-account gate", () => {
  it("renders the gate (NOT the dropzone) when the user has zero accounts", async () => {
    mockAccounts = [];
    renderUpload();
    expect(await screen.findByTestId("upload-account-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("upload-dropzone")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("upload-dropzone-disabled"),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByTestId("button-gate-create-account"),
    ).toBeInTheDocument();
  });

  it("renders the dropzone (NOT the gate) when the user already has an account", async () => {
    mockAccounts = [makeAccount()];
    renderUpload();
    await screen.findByTestId("upload-dropzone");
    expect(
      screen.queryByTestId("upload-account-gate"),
    ).not.toBeInTheDocument();
  });
});

describe("Drag-active state on the dropzone", () => {
  it("applies the active class on dragenter and clears it on dragleave", async () => {
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    expect(dz).toHaveAttribute("data-drag-active", "false");

    fireEvent.dragEnter(dz, { dataTransfer: { files: [] } });
    expect(dz).toHaveAttribute("data-drag-active", "true");
    expect(dz.className).toContain("upload-dropzone--active");

    fireEvent.dragLeave(dz, { dataTransfer: { files: [] } });
    expect(dz).toHaveAttribute("data-drag-active", "false");
    expect(dz.className).not.toContain("upload-dropzone--active");
  });
});

describe("Per-file CSV preview", () => {
  it("renders header + data rows when the user toggles the preview", async () => {
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");

    const file = csvFile(
      "chase.csv",
      "Date,Amount,Description\n2025-01-01,12.34,Coffee\n2025-01-02,56.78,Groceries\n",
    );
    fireEvent.drop(dz, { dataTransfer: { files: [file] } });

    // Queue rendered with one row
    const queue = await screen.findByTestId("upload-queue");
    const rows = within(queue).getAllByRole("listitem");
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    const rowKey = row.getAttribute("data-testid")!.replace("row-queue-", "");
    const toggle = within(row).getByTestId(`button-toggle-preview-${rowKey}`);
    fireEvent.click(toggle);

    // FileReader is async — wait for the table to appear.
    const table = await screen.findByTestId(`preview-table-${rowKey}`);
    expect(within(table).getByText("Date")).toBeInTheDocument();
    expect(within(table).getByText("Amount")).toBeInTheDocument();
    expect(within(table).getByText("Description")).toBeInTheDocument();
    expect(within(table).getByText("Coffee")).toBeInTheDocument();
    expect(within(table).getByText("Groceries")).toBeInTheDocument();
    // Known-format header → no warning shown
    expect(
      within(table).queryByTestId(`preview-warning-${rowKey}`),
    ).not.toBeInTheDocument();
  });

  it("shows a 'header doesn't match a known bank format' warning for weird headers", async () => {
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    const file = csvFile(
      "weird.csv",
      "foo,bar,baz\n1,2,3\n4,5,6\n",
    );
    fireEvent.drop(dz, { dataTransfer: { files: [file] } });

    const queue = await screen.findByTestId("upload-queue");
    const rowEl = within(queue).getAllByRole("listitem")[0]!;
    const rowKey = rowEl
      .getAttribute("data-testid")!
      .replace("row-queue-", "");
    fireEvent.click(within(rowEl).getByTestId(`button-toggle-preview-${rowKey}`));

    await screen.findByTestId(`preview-warning-${rowKey}`);
  });
});

describe("Bulk 'Set account for all' bar", () => {
  it("appears only when 2+ files are queued AND the user has 2+ accounts", async () => {
    mockAccounts = [
      makeAccount({ id: 1, label: "Chase" }),
      makeAccount({ id: 2, label: "Amex", lastFour: "9999" }),
    ];
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");

    // Single file → bulk bar should NOT appear
    fireEvent.drop(dz, {
      dataTransfer: { files: [csvFile("a.csv", "Date,Amount\n2025-01-01,1\n")] },
    });
    await screen.findByTestId("upload-queue");
    expect(screen.queryByTestId("upload-bulk-bar")).not.toBeInTheDocument();

    // Add second file → bulk bar appears
    fireEvent.drop(dz, {
      dataTransfer: { files: [csvFile("b.csv", "Date,Amount\n2025-01-02,2\n")] },
    });
    expect(await screen.findByTestId("upload-bulk-bar")).toBeInTheDocument();
  });

  it("applies the chosen account to every pending row when 'Apply to all' is clicked", async () => {
    mockAccounts = [
      makeAccount({ id: 1, label: "Chase" }),
      makeAccount({ id: 2, label: "Amex", lastFour: "9999" }),
    ];
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [
          csvFile("a.csv", "Date,Amount\n2025-01-01,1\n"),
          csvFile("b.csv", "Date,Amount\n2025-01-02,2\n"),
        ],
      },
    });

    await screen.findByTestId("upload-bulk-bar");
    fireEvent.change(screen.getByTestId("select-bulk-account"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("button-apply-bulk-account"));

    // Both per-row selectors should now show account 2.
    const rows = screen
      .getAllByRole("listitem")
      .filter((el) => el.getAttribute("data-testid")?.startsWith("row-queue-"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const rowKey = row.getAttribute("data-testid")!.replace("row-queue-", "");
      const select = within(row).getByTestId(
        `select-account-${rowKey}`,
      ) as HTMLSelectElement;
      expect(select.value).toBe("2");
    }
  });
});

describe("Robustness against bad batches and races", () => {
  it("refuses to import a batch with two same-named files (server keys results by filename)", async () => {
    mockAccounts = [makeAccount({ id: 1 })];
    // We should never reach the network — fail loudly if we do.
    mockUploadResponse = {
      status: 200,
      body: { results: [] },
    };
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [
          csvFile("stmt.csv", "Date,Amount\n2025-01-01,1\n"),
          csvFile("stmt.csv", "Date,Amount\n2025-02-01,2\n"),
        ],
      },
    });

    await screen.findByTestId("upload-queue");
    fireEvent.click(screen.getByTestId("button-import"));

    const errBlock = await screen.findByTestId("upload-validation-errors");
    expect(errBlock).toHaveTextContent(/two files share the same name/i);
    expect(errBlock).toHaveTextContent(/stmt\.csv/);

    // Mutation must NOT have been fired. The fetch mock would have
    // recorded a call to /api/upload otherwise.
    const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>).mock;
    const uploadCalls = fetchMock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url === "/api/upload" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(uploadCalls).toHaveLength(0);

    // No row transitioned to "uploading".
    const rows = screen
      .getAllByRole("listitem")
      .filter((el) => el.getAttribute("data-testid")?.startsWith("row-queue-"));
    for (const row of rows) {
      expect(row.getAttribute("data-status")).toBe("pending");
    }
  });
});

/**
 * Helper: returns a `fetch` mock that holds the /api/upload POST until
 * `resolve()` is called. Use it when we need to observe the in-flight UI.
 */
function makeDeferredUploadFetch(): {
  fetch: ReturnType<typeof vi.fn>;
  resolve: (body: unknown, status?: number) => void;
} {
  let pendingResolve: ((value: Response) => void) | null = null;
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/upload" && init?.method === "POST") {
      return new Promise<Response>((r) => {
        pendingResolve = r;
      });
    }
    return mockFetch(input, init);
  });
  return {
    fetch: fn,
    resolve(body, status = 200) {
      pendingResolve?.(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  };
}

describe("Dropzone is locked while an import is in flight", () => {
  it("disables the dropzone, file input, and removes tab focus while uploading", async () => {
    mockAccounts = [makeAccount({ id: 1 })];
    const deferred = makeDeferredUploadFetch();
    vi.stubGlobal("fetch", deferred.fetch);

    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("a.csv", "Date,Amount\n2025-01-01,1\n")],
      },
    });
    await screen.findByTestId("upload-queue");
    fireEvent.click(screen.getByTestId("button-import"));

    await waitFor(() => {
      expect(dz).toHaveAttribute("aria-disabled", "true");
    });
    expect(dz).toHaveAttribute("data-disabled", "true");
    expect(dz).toHaveAttribute("tabIndex", "-1");
    expect(dz.className).toContain("upload-dropzone--disabled");
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput.disabled).toBe(true);

    deferred.resolve({
      results: [
        { filename: "a.csv", uploadId: 1, status: "complete", rowCount: 1 },
      ],
    });
    await screen.findByTestId("button-upload-more");
  });
});

describe("Parsing-stage status pill", () => {
  it("transitions a row from uploading to parsing while the server is processing", async () => {
    mockAccounts = [makeAccount({ id: 1 })];
    const deferred = makeDeferredUploadFetch();
    vi.stubGlobal("fetch", deferred.fetch);

    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("slow.csv", "Date,Amount\n2025-01-01,1\n")],
      },
    });
    await screen.findByTestId("upload-queue");
    const rowEl = screen
      .getAllByRole("listitem")
      .find((el) =>
        el.getAttribute("data-testid")?.startsWith("row-queue-"),
      )!;
    const rowKey = rowEl.getAttribute("data-testid")!.replace("row-queue-", "");

    fireEvent.click(screen.getByTestId("button-import"));

    // Immediately after click the row is in `uploading`.
    await waitFor(() => {
      expect(
        screen.getByTestId(`row-queue-${rowKey}`).getAttribute("data-status"),
      ).toBe("uploading");
    });
    expect(screen.getByTestId(`status-pill-${rowKey}`)).toHaveTextContent(
      /Uploading/i,
    );

    // After the parsing-after delay (600ms) it flips to `parsing`.
    await waitFor(
      () => {
        expect(
          screen
            .getByTestId(`row-queue-${rowKey}`)
            .getAttribute("data-status"),
        ).toBe("parsing");
      },
      { timeout: 2000 },
    );
    expect(screen.getByTestId(`status-pill-${rowKey}`)).toHaveTextContent(
      /Parsing/i,
    );

    // Resolving the request lands the row on `complete`.
    deferred.resolve({
      results: [
        {
          filename: "slow.csv",
          uploadId: 7,
          status: "complete",
          rowCount: 3,
        },
      ],
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`row-queue-${rowKey}`).getAttribute("data-status"),
      ).toBe("complete");
    });
  });
});

describe("Per-file status pills", () => {
  it("transitions pending → complete and shows the per-row result", async () => {
    mockAccounts = [makeAccount({ id: 1 })];
    mockUploadResponse = {
      status: 200,
      body: {
        results: [
          {
            filename: "stmt.csv",
            uploadId: 99,
            status: "complete",
            rowCount: 7,
            previouslyImported: 2,
          },
        ],
      },
    };
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("stmt.csv", "Date,Amount\n2025-01-01,1\n")],
      },
    });

    const queue = await screen.findByTestId("upload-queue");
    const row = within(queue).getAllByRole("listitem")[0]!;
    const rowKey = row.getAttribute("data-testid")!.replace("row-queue-", "");

    expect(within(row).getByTestId(`status-pill-${rowKey}`)).toHaveTextContent(
      /Pending/i,
    );

    fireEvent.click(screen.getByTestId("button-import"));

    // Wait for the row to land on its complete pill.
    await waitFor(() => {
      expect(
        within(screen.getByTestId(`row-queue-${rowKey}`)).getByTestId(
          `status-pill-${rowKey}`,
        ),
      ).toHaveTextContent(/Done/i);
    });

    expect(
      screen.getByTestId(`text-row-result-${rowKey}`),
    ).toHaveTextContent(/7 new/);
    expect(
      screen.getByTestId(`text-row-result-${rowKey}`),
    ).toHaveTextContent(/2 already in ledger/);
    // After completion the import button is replaced with "Upload more files".
    expect(screen.getByTestId("button-upload-more")).toBeInTheDocument();
    expect(screen.queryByTestId("button-import")).not.toBeInTheDocument();
  });

  it("transitions pending → failed and shows a per-row error", async () => {
    mockAccounts = [makeAccount({ id: 1 })];
    mockUploadResponse = {
      status: 200,
      body: {
        results: [
          {
            filename: "broken.csv",
            uploadId: null,
            status: "failed",
            rowCount: 0,
            error: "Could not detect a date column",
          },
        ],
      },
    };
    renderUpload();
    const dz = await screen.findByTestId("upload-dropzone");
    fireEvent.drop(dz, {
      dataTransfer: {
        files: [csvFile("broken.csv", "foo,bar\n1,2\n")],
      },
    });

    await screen.findByTestId("upload-queue");
    fireEvent.click(screen.getByTestId("button-import"));

    const failedRow = await waitFor(() => {
      const all = screen
        .getAllByRole("listitem")
        .filter((el) =>
          el.getAttribute("data-testid")?.startsWith("row-queue-"),
        );
      const failed = all.find(
        (el) => el.getAttribute("data-status") === "failed",
      );
      if (!failed) throw new Error("not failed yet");
      return failed;
    });

    const rowKey = failedRow
      .getAttribute("data-testid")!
      .replace("row-queue-", "");
    expect(within(failedRow).getByTestId(`status-pill-${rowKey}`)).toHaveTextContent(
      /Error/i,
    );
    expect(
      within(failedRow).getByTestId(`text-row-error-${rowKey}`),
    ).toHaveTextContent(/Could not detect a date column/);
    // Failed rows get the upload-queue-item--failed modifier (red left border).
    expect(failedRow.className).toContain("upload-queue-item--failed");
  });
});
