/** 极简提示条：全局只有一个，后到的覆盖前一个 */
import { ref } from "vue";

export const toastMessage = ref("");

let timer: number | undefined;

export function toast(message: string): void {
  toastMessage.value = message;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    toastMessage.value = "";
  }, 2600);
}

export function humanBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function humanTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function humanDuration(ms: number): string {
  if (!ms) return "—";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
