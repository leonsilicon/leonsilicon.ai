/// <reference types="vite-plus/client" />
import "#page.css";

/** Enables the page's copy buttons and reads the service's same-origin health check. */
export async function mountServicePage(root: ParentNode = document): Promise<void> {
  if (navigator.clipboard) {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
      const snippet = button.parentElement?.querySelector("code")?.textContent;
      if (!snippet) continue;

      button.hidden = false;
      let reset: ReturnType<typeof setTimeout>;
      button.addEventListener("click", async () => {
        clearTimeout(reset);
        try {
          await navigator.clipboard.writeText(snippet);
          button.textContent = "Copied";
        } catch {
          button.textContent = "Copy failed";
        }
        reset = setTimeout(() => {
          button.textContent = "Copy";
        }, 2000);
      });
    }
  }

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
