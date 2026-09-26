/* Lucide icons, ISC license: https://lucide.dev/license. Only the used paths are bundled. */
var editorIconPaths = {
  fields: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  applications: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sites: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  assistant: '<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M10 11v6M14 11v6"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>'
};

function editorIcon(name) {
  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.75");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = editorIconPaths[name] || "";
  return icon;
}

function decorateEditorControl(control, icon, label, iconOnly) {
  control.prepend(editorIcon(icon));
  control.title = label;
  control.setAttribute("aria-label", label);
  if (iconOnly) {
    Array.from(control.childNodes).forEach(function (node) {
      if (node.nodeType === 3) node.remove();
    });
    control.classList.add("iconButton");
  }
}

document.querySelectorAll(".tabBtn").forEach(function (button) {
  button.prepend(editorIcon(button.dataset.tab));
});
decorateEditorControl(document.getElementById("addFieldBtn"), "plus", "Add field", false);
decorateEditorControl(document.getElementById("resumeInput").parentElement, "upload", "Add resume", false);
decorateEditorControl(document.getElementById("exportBtn"), "download", "Export profile JSON", true);
decorateEditorControl(document.getElementById("importInput").parentElement, "upload", "Import profile JSON", true);
decorateEditorControl(document.getElementById("exportApplicationsBtn"), "download", "Export applications CSV", true);
document.querySelectorAll(".fileBtn").forEach(function (label) {
  label.tabIndex = 0;
  label.setAttribute("role", "button");
  label.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      label.querySelector('input[type="file"]').click();
    }
  });
});
