// theme boots before first paint: stored choice, else the system's
(function () {
  try {
    var t = localStorage.getItem("concord-theme");
    if (t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch {
    /* storage unavailable — stay on paper */
  }
})();
