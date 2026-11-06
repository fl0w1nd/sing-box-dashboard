export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // HTTP dashboards do not expose the Clipboard API.
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  input.setAttribute("aria-hidden", "true");
  // Keep the selection inside an open modal; the rest of the page is inert.
  const container = focused?.closest("dialog[open]") ?? document.body;
  container.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) {
      throw new Error("Failed to copy text to clipboard");
    }
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) {
      focused.focus({ preventScroll: true });
    }
  }
}
