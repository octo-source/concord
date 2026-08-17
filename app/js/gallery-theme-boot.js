// honor ?theme=light|dark (used by the side-by-side frames) else stored/system
(function () {
  var q = new URLSearchParams(location.search);
  var t = q.get("theme");
  try {
    if (!t) t = localStorage.getItem("concord-theme");
  } catch {
    /* storage unavailable */
  }
  if (t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  if (q.get("embed")) document.documentElement.setAttribute("data-embed", "1");
})();
