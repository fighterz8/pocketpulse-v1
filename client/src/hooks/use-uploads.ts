import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

export const uploadsQueryKey = ["uploads"] as const;

export type UploadRecord = {
  id: number;
  userId: number;
  accountId: number;
  filename: string;
  rowCount: number;
  status: string;
  errorMessage: string | null;
  uploadedAt: string;
};

export type UploadFileResult = {
  filename: string;
  uploadId: number | null;
  status: string;
  rowCount: number;
  error?: string;
  warnings?: string[];
};

export type UploadInput = {
  files: File[];
  metadata: Record<string, { accountId: number }>;
};

async function readJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    /* ignore */
  }
  return res.statusText || "Upload failed";
}

export function useUploads() {
  const queryClient = useQueryClient();

  const uploadsQuery = useQuery({
    queryKey: uploadsQueryKey,
    queryFn: async (): Promise<{ uploads: UploadRecord[] }> => {
      const res = await fetch("/api/uploads");
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<{ uploads: UploadRecord[] }>;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (
      input: UploadInput,
    ): Promise<{ results: UploadFileResult[] }> => {
      const formData = new FormData();
      for (const file of input.files) {
        formData.append("files", file);
      }
      formData.append("metadata", JSON.stringify(input.metadata));

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      return res.json() as Promise<{ results: UploadFileResult[] }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: uploadsQueryKey });
    },
  });

  return {
    uploads: uploadsQuery.data?.uploads ?? null,
    uploadsLoading: uploadsQuery.isPending,
    uploadsError: uploadsQuery.error as Error | null,
    upload: uploadMutation,
  };
}
