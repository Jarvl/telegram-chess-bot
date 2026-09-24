import { signal } from '@preact/signals';

const toasts = signal<{ id: number; text: string }[]>([]);
let next = 1;

/** Test-only: clears any toast left showing by a previous test's fresh mount. */
export function resetToasts(): void {
  toasts.value = [];
}

export function toast(text: string, ms = 2_000): void {
  const id = next++;
  toasts.value = [...toasts.value, { id, text }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((entry) => entry.id !== id);
  }, ms);
}

export function Toasts() {
  const last = toasts.value.at(-1);
  return last ? (
    <div class="toast" role="status">
      {last.text}
    </div>
  ) : null;
}
