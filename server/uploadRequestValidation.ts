export function readMulterFileArray(
  value: unknown,
): Express.Multer.File[] | null {
  return Array.isArray(value) ? (value as Express.Multer.File[]) : null;
}
