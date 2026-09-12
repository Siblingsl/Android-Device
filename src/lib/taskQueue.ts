import type {
  QueueHandle,
  QueueItemResult,
  QueueResult,
} from "../types";

export interface TaskQueueOptions<TItem = unknown, TValue = unknown> {
  concurrency?: number;
  onProgress?: (progress: QueueProgress<TItem, TValue>) => void;
}

export interface QueueProgress<TItem, TValue> {
  total: number;
  completed: number;
  active: number;
  item?: TItem;
  result?: QueueItemResult<TItem, TValue>;
}

function toReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function runTaskQueue<TItem, TValue>(
  items: TItem[],
  worker: (item: TItem, index: number) => Promise<TValue>,
  options: TaskQueueOptions<TItem, TValue> = {},
): QueueHandle<TItem, TValue> {
  const results: Array<QueueItemResult<TItem, TValue> | undefined> = Array.from({
    length: items.length,
  });
  const limit = Math.max(1, Math.floor(options.concurrency ?? 1));
  let nextIndex = 0;
  let active = 0;
  let cancelled = false;
  let resolveDone!: (result: QueueResult<TItem, TValue>) => void;
  const done = new Promise<QueueResult<TItem, TValue>>((resolve) => {
    resolveDone = resolve;
  });

  const finishIfReady = () => {
    if (active !== 0 || results.some((result) => result === undefined)) return;
    resolveDone({
      results: results as Array<QueueItemResult<TItem, TValue>>,
      cancelled,
    });
  };

  const markPendingCancelled = () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = { item: items[index], status: "cancelled" };
    }
    options.onProgress?.({
      total: items.length,
      completed: results.filter((result) => result !== undefined).length,
      active,
    });
  };

  const pump = () => {
    if (cancelled) markPendingCancelled();
    while (!cancelled && active < limit && nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      active += 1;
      options.onProgress?.({ total: items.length, completed: results.filter((result) => result !== undefined).length, active, item });
      void worker(item, index)
        .then((value) => {
          results[index] = { item, status: "fulfilled", value };
        })
        .catch((error: unknown) => {
          results[index] = { item, status: "rejected", reason: toReason(error) };
        })
        .finally(() => {
          active -= 1;
          options.onProgress?.({ total: items.length, completed: results.filter((result) => result !== undefined).length, active, item, result: results[index] });
          pump();
          finishIfReady();
        });
    }
    finishIfReady();
  };

  const handle: QueueHandle<TItem, TValue> = {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      markPendingCancelled();
      finishIfReady();
    },
  };

  pump();
  return handle;
}
