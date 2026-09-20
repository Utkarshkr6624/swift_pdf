// Dark mode toggle: persists choice, defaults to system preference.
(function () {
  const saved = localStorage.getItem("swiftpdf-theme");
  const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = t;
  };
  apply(saved || system);

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      apply(next);
      localStorage.setItem("swiftpdf-theme", next);
    });
  });
})();