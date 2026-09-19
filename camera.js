// Camera capture modal using getUserMedia — works on desktop webcams and
// phone rear cameras. Falls back to the file picker if unavailable.
// openCamera() -> Promise<File | null>

let cameraStream = null;

async function openCamera() {
  // try getUserMedia first (real camera preview on PC + phone)
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
      const video = document.getElementById("cameraVideo");
      video.srcObject = cameraStream;
      await video.play();
      document.getElementById("cameraOverlay").hidden = false;
      return null; // result arrives via captureCamera()
    } catch (err) {
      console.warn("getUserMedia failed, falling back to file picker:", err);
    }
  }
  // fallback: native picker (still opens camera apps on phones)
  const input = document.getElementById("cameraFallback");
  input.value = "";
  input.click();
  return null;
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  document.getElementById("cameraOverlay").hidden = true;
}

function captureCamera() {
  const video = document.getElementById("cameraVideo");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  if (!canvas.width) return;
  canvas.getContext("2d").drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    closeCamera();
    if (!blob) return;
    const file = new File([blob], "photo-" + Date.now() + ".jpg", { type: "image/jpeg" });
    window.dispatchEvent(new CustomEvent("swiftpdf-photo", { detail: file }));
  }, "image/jpeg", 0.95);
}

// Drop (or paste) images directly into the camera modal
function initCameraUI() {
  const zone = document.getElementById("cameraDrop");
  const overlay = document.getElementById("cameraOverlay");
  if (!zone || !overlay) return;
  // click outside the camera box closes it
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeCamera(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeCamera();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
      closeCamera();
      window.dispatchEvent(new CustomEvent("swiftpdf-photo", { detail: e.dataTransfer.files }));
    }
  });
  window.addEventListener("paste", (e) => {
    if (!document.getElementById("cameraOverlay").hidden && e.clipboardData && e.clipboardData.files.length) {
      closeCamera();
      window.dispatchEvent(new CustomEvent("swiftpdf-photo", { detail: e.clipboardData.files }));
    }
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCameraUI);
else initCameraUI();
