import { describe, expect, it } from "vitest";

import { readMulterFileArray } from "./uploadRequestValidation.js";

describe("readMulterFileArray", () => {
  it("accepts only Multer's runtime array shape", () => {
    const file = { originalname: "statement.csv" } as Express.Multer.File;

    expect(readMulterFileArray([file])).toEqual([file]);
    expect(readMulterFileArray(undefined)).toBeNull();
    expect(readMulterFileArray(file)).toBeNull();
    expect(readMulterFileArray("statement.csv")).toBeNull();
    expect(readMulterFileArray({ files: [file] })).toBeNull();
  });
});
