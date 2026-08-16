export interface ToolContext {
  signal?: AbortSignal;
  progress?: (progress: number, total: number, message: string) => Promise<void>;
}
