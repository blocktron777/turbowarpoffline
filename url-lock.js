<script id="url-lock">
  /* URL lock: stops this page from changing the address bar.
     Runs first in <head>, before any app code can capture the original APIs. */
  (function () {
    "use strict";

    // History API: make pushState and replaceState permanent no-ops.
    // The setter ignores writes so strict-mode code won't throw when
    // it tries to wrap or replace these methods.
    function noop() {}

    ["pushState", "replaceState"].forEach(function (name) {
      try {
        Object.defineProperty(History.prototype, name, {
          configurable: false,
          enumerable: true,
          get: function () {
            return noop;
          },
          set: function () {}
        });
      } catch (e) {}
    });

    // Cancel script-initiated location changes through the Navigation API,
    // where available. Location itself cannot be overridden from JavaScript.
    // Allowed: user-initiated navigation, reloads, downloads, and navigation
    // to the URL already shown.
    try {
      if (
        window.navigation &&
        typeof window.navigation.addEventListener === "function"
      ) {
        window.navigation.addEventListener("navigate", function (e) {
          if (!e.cancelable) return;
          if (e.userInitiated) return;
          if (e.downloadRequest !== null && e.downloadRequest !== undefined) {
            return;
          }
          if (e.navigationType === "traverse" || e.navigationType === "reload") {
            return;
          }
          if (e.destination && e.destination.url === location.href) return;

          e.preventDefault();
        });
      }
    } catch (e) {}
  })();
</script>
