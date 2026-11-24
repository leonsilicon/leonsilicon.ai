for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const command = document.getElementById(button.dataset.copy ?? "");
  if (!command || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(command.textContent?.trim() ?? "").then(
      () => {
        button.textContent = "Copied";
        window.setTimeout(() => (button.textContent = "Copy"), 1600);
      },
      () => (button.textContent = "Select and copy"),
    );
  });
}
