import { vi } from 'vitest';

// Pure/unit tests must not open or rotate the operator's production logs.
vi.mock('@/lib/logger', () => {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: vi.fn((): unknown => logger),
  };
  return { createLogger: () => logger };
});
