// Optional, local-only camera capture for the Image to PDF tool.
(function () {
  const overlay = document.getElementById("cameraOverlay");
  const video = document.getElementById("cameraVideo");
  const placeholder = document.getElementById("cameraPlaceholder");
  const status = document.getElementById("cameraStatus");
  const captureButton = document.getElementById("cameraCapture");
  const switchButton = document.getElementById("cameraSwitch");
  const fallbackButton = document.getElementById("cameraFallback");
  const input = document.getElementById("cameraFileInput");
  if (!overlay || !video || !input) return;

  let stream = null;
  let facingMode = "environment";
  let lastFocus = null;
  let previousOverflow = "";

  function stopCamera() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    captureButton.disabled = true;
    switchButton.disabled = true;
    placeholder.hidden = false;
  }

  function closeCamera() {
    stopCamera();
    overlay.hidden = true;
    document.body.style.overflow = previousOverflow;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = "Live camera preview is not available here. Use your device camera instead.";
      return;
    }
    status.textContent = "Starting camera…";
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (overlay.hidden) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = nextStream;
      video.srcObject = stream;
      await video.play();
      placeholder.hidden = true;
      captureButton.disabled = false;
      switchButton.disabled = false;
      status.textContent = "Camera ready. Captured photos are added to your image list on this device.";
    } catch (error) {
      console.warn("Camera access unavailable:", error);
      stopCamera();
      const message = error && error.name === "NotAllowedError"
        ? "Camera access was blocked. Allow it in your browser, or use your device camera."
        : "Could not start the live camera. You can still use your device camera.";
      status.textContent = message;
      captureButton.disabled = true;
      switchButton.disabled = true;
    }
  }

  function openCamera() {
    lastFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    status.textContent = "Allow camera access when your browser asks.";
    document.getElementById("cameraClose").focus();
    startCamera();
  }

  async function capturePhoto() {
    if (!stream || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      status.textContent = "This browser could not capture the photo. Try your device camera instead.";
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      status.textContent = "The photo could not be captured. Please try again.";
      return;
    }
    const file = new File([blob], `camera-photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    if (window.swiftPdfAddCameraPhoto) {
      window.swiftPdfAddCameraPhoto(file);
      status.textContent = "Photo added. Take another photo or close the camera.";
    } else {
      status.textContent = "Image list is still loading. Please try again.";
    }
  }

  document.getElementById("cameraBtn").addEventListener("click", openCamera);
  document.getElementById("wsCameraCard").addEventListener("click", openCamera);
  document.getElementById("cameraClose").addEventListener("click", closeCamera);
  captureButton.addEventListener("click", capturePhoto);
  fallbackButton.addEventListener("click", () => input.click());
  switchButton.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    stopCamera();
    await startCamera();
  });
  input.addEventListener("change", () => {
    const files = [...input.files || []];
    if (files.length && window.swiftPdfAddCameraPhoto) {
      files.forEach(window.swiftPdfAddCameraPhoto);
      status.textContent = `${files.length} ${files.length === 1 ? "photo was" : "photos were"} added.`;
    }
    input.value = "";
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeCamera();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) closeCamera();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !overlay.hidden) stopCamera();
  });
  window.swiftPdfOpenCamera = openCamera;
})();
