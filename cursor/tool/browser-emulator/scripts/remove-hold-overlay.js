(() => {
  [
    "__emu-hold-root",
    "emu-phone-hold-root",
    "phone-preview-hold-root",
    "__browser-emulator-hold-root"
  ].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.remove();
  });
  document.querySelectorAll('[id*="browser-emulator"], [id*="emu-hold"], [id*="emu-phone"]').forEach((el) => {
    if (el && el.parentNode) el.remove();
  });
})();
