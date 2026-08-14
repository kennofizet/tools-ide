async function forgetPageData(page, appendLog, logPath) {
  const activeUrl = page.url() || "";
  if (!/^https?:\/\//i.test(activeUrl)) {
    appendLog(logPath, "Forget mode skipped (non-http page)");
    return;
  }

  const url = new URL(activeUrl);
  const origin = `${url.protocol}//${url.host}`;
  appendLog(logPath, `Forget mode: clearing page data for ${origin}`);

  await page.evaluate(async () => {
    try {
      window.localStorage?.clear?.();
    } catch {}
    try {
      window.sessionStorage?.clear?.();
    } catch {}

    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch {}

    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((reg) => reg.unregister()));
      }
    } catch {}

    try {
      if (window.indexedDB && typeof window.indexedDB.databases === "function") {
        const dbs = await window.indexedDB.databases();
        await Promise.all(
          dbs
            .map((item) => item && item.name)
            .filter(Boolean)
            .map(
              (name) =>
                new Promise((resolve) => {
                  const req = window.indexedDB.deleteDatabase(name);
                  req.onsuccess = () => resolve();
                  req.onerror = () => resolve();
                  req.onblocked = () => resolve();
                })
            )
        );
      }
    } catch {}
  });

  try {
    const context = page.context();
    const cookies = await context.cookies([origin]);
    for (const cookie of cookies) {
      await context.clearCookies({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path
      });
    }
    appendLog(logPath, `Forget mode: cleared ${cookies.length} cookie(s)`);
  } catch {
    appendLog(logPath, "Forget mode: cookie cleanup skipped");
  }
}

module.exports = {
  forgetPageData
};

