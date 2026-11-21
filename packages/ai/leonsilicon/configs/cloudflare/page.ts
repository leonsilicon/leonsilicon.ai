/// <reference types="vite-plus/client" />
import "#page.css";

/**
 * Sets up a service page: fills its `[data-health]` element from the service's own `/healthz`
 * (same origin, so the page shows whether the service behind it answers). Pages for services with
 * no health check leave that element out.
 */
export async function mountServicePage(root: ParentNode = document): Promise<void> {
  const status = root.querySelector<HTMLElement>("[data-health]");
  if (!status) return;
  let state: "up" | "down";
  let text: string;
  try {
    const response = await fetch("/healthz", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    state = response.ok ? "up" : "down";
    text = response.ok ? "Up" : `Down (HTTP ${response.status})`;
  } catch {
    state = "down";
    text = "Unreachable";
  }
  status.dataset.health = state;
  status.textContent = text;
}
