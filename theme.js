// Dark mode toggle: persists choice, defaults to system preference.
(function () {
  const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const wasReloaded = navigation
    ? navigation.type === "reload"
    : Boolean(performance.navigation && performance.navigation.type === 1);
  const currentFile = window.location.pathname.split("/").pop().toLowerCase();
  const currentPage = currentFile.replace(/\.html?$/, "");
  const homeOnReloadPages = new Set(["about", "contact", "privacy", "terms"]);
  if (wasReloaded && homeOnReloadPages.has(currentPage)) {
    // Content pages return home on refresh; tool pages stay in place so work can continue.
    window.location.replace(new URL("index.html", window.location.href).href);
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem("swiftpdf-theme"); } catch (err) { /* Storage may be disabled. */ }
  const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = t;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = t === "dark" ? "#0d1118" : "#f4f7fc";
  };
  apply(saved || system);

  document.addEventListener("DOMContentLoaded", () => {
    // Give keyboard users a direct route past the shared navigation.
    const main = document.querySelector("main");
    if (main) {
      if (!main.id) main.id = "main-content";
      if (!document.querySelector(".skip-link")) {
        const skip = document.createElement("a");
        skip.className = "skip-link";
        skip.href = `#${main.id}`;
        skip.textContent = "Skip to main content";
        document.body.prepend(skip);
      }
    }

    const button = document.getElementById("themeToggle");
    if (!button) return;
    const updateToggleLabel = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      button.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
      button.setAttribute("aria-pressed", String(dark));
    };
    updateToggleLabel();
    button.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      apply(next);
      updateToggleLabel();
      try { localStorage.setItem("swiftpdf-theme", next); } catch (err) { /* Storage may be disabled. */ }
    });
  });

})();
