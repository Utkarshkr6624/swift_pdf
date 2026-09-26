// Local camera capture with a review, crop, and rotate step before import.
(function () {
  const overlay = document.getElementById("cameraOverlay");
  const video = document.getElementById("cameraVideo");
  const stage = document.getElementById("cameraStage");
  const placeholder = document.getElementById("cameraPlaceholder");
  const status = document.getElementById("cameraStatus");
  const captureButton = document.getElementById("cameraCapture");
  const switchButton = document.getElementById("cameraSwitch");
  const fallbackButton = document.getElementById("cameraFallback");
  const cameraActions = document.getElementById("cameraActions");
  const review = document.getElementById("cameraReview");
  const reviewImage = document.getElementById("cameraReviewImage");
  const reviewName = document.getElementById("cameraReviewName");
  const input = document.getElementById("cameraFileInput");
  if (!overlay || !video || !input || !review) return;

  let stream = null;
  let facingMode = "environment";
  let lastFocus = null;
  let previousOverflow = "";
  let currentFile = null;
  let currentCrop = null;
  let previewUrl = null;
  let queuedPhotos = [];
  let captureInProgress = false;

  function stopCamera() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    captureButton.disabled = true;
    switchButton.disabled = true;
    placeholder.hidden = false;
  }

  function clearReview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    reviewImage.removeAttribute("src");
    currentFile = null;
    currentCrop = null;
  }

  function closeCamera() {
    stopCamera();
    clearReview();
    queuedPhotos = [];
    review.hidden = true;
    stage.hidden = false;
    cameraActions.hidden = false;
    hideModalOverlay(overlay, () => {
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    });
    document.body.style.overflow = previousOverflow;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = "Live camera preview is not available here. Use the camera or photo picker instead.";
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
      status.textContent = "Camera ready. Take a photo to preview and edit it before adding it.";
    } catch (error) {
      console.warn("Camera access unavailable:", error);
      stopCamera();
      const message = error && error.name === "NotAllowedError"
        ? "Camera access was blocked. Allow it in your browser, or use your device camera."
        : "Could not start the live camera. You can still use your device camera.";
      status.textContent = message;
    }
  }

  function openCamera() {
    lastFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    showModalOverlay(overlay);
    review.hidden = true;
    stage.hidden = false;
    cameraActions.hidden = false;
    document.body.style.overflow = "hidden";
    status.textContent = "Allow camera access when your browser asks.";
    document.getElementById("cameraClose").focus();
    startCamera();
  }

  function makeCameraFile(blob) {
    return new File([blob], `camera-photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  }

  async function drawReview(file, crop) {
    const sourceUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("This photo could not be previewed. Try another image."));
        image.src = sourceUrl;
      });
      if (!crop) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = sourceUrl;
        reviewImage.src = previewUrl;
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(crop.w));
      canvas.height = Math.max(1, Math.round(crop.h));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser could not prepare the cropped photo preview.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not prepare the crop preview.")), "image/jpeg", 0.92));
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      reviewImage.src = previewUrl;
      canvas.width = 0;
      canvas.height = 0;
    } finally {
      if (sourceUrl !== previewUrl) URL.revokeObjectURL(sourceUrl);
    }
  }

  async function showReview(file) {
    currentFile = file;
    currentCrop = null;
    review.hidden = false;
    stage.hidden = true;
    cameraActions.hidden = true;
    reviewName.textContent = file.name;
    status.textContent = "Review your photo. Crop or rotate it, then add it and continue or close the camera.";
    document.getElementById("cameraUseContinue").focus();
    try { await drawReview(file, null); }
    catch (error) { status.textContent = error.message || "Could not show this photo preview."; }
  }

  async function capturePhoto() {
    if (!stream || !video.videoWidth || !video.videoHeight || captureInProgress) return;
    captureInProgress = true;
    captureButton.disabled = true;
    const canvas = document.createElement("canvas");
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser could not capture the photo. Try your device camera instead.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("The photo could not be captured. Please try again.");
      await showReview(makeCameraFile(blob));
    } catch (error) {
      status.textContent = error.message || "The photo could not be captured. Please try again.";
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      captureInProgress = false;
      if (!stage.hidden && stream) captureButton.disabled = false;
    }
  }

  async function cropPhoto() {
    if (!currentFile || typeof openCrop !== "function") return;
    overlay.classList.add("is-cropping");
    try {
      const crop = await openCrop(currentFile);
      if (!crop || !currentFile) return;
      currentCrop = crop;
      await drawReview(currentFile, crop);
      status.textContent = "Crop applied. Review the result, then add your photo.";
    } catch (error) {
      status.textContent = error.message || "Could not crop this photo.";
    } finally {
      overlay.classList.remove("is-cropping");
    }
  }

  async function rotatePhoto() {
    if (!currentFile) return;
    const sourceUrl = URL.createObjectURL(currentFile);
    const canvas = document.createElement("canvas");
    const image = new Image();
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("This photo could not be rotated."));
        image.src = sourceUrl;
      });
      canvas.width = image.naturalHeight;
      canvas.height = image.naturalWidth;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser could not rotate this photo.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(Math.PI / 2);
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not save the rotated photo.")), "image/jpeg", 0.92));
      const base = currentFile.name.replace(/\.[^.]+$/, "") || "camera-photo";
      currentFile = new File([blob], `${base}-rotated.jpg`, { type: "image/jpeg", lastModified: Date.now() });
      currentCrop = null;
      await drawReview(currentFile, null);
      status.textContent = "Photo rotated. Add it and continue, or close the camera when you are done.";
    } catch (error) {
      status.textContent = error.message || "Could not rotate this photo.";
    } finally {
      URL.revokeObjectURL(sourceUrl);
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function addCurrentPhoto(closeAfter) {
    if (!currentFile || !window.swiftPdfAddCameraPhoto) return;
    window.swiftPdfAddCameraPhoto(currentFile, currentCrop);
    clearReview();
    if (closeAfter) {
      // A multi-photo selection from the device picker is already user-approved.
      queuedPhotos.forEach((file) => window.swiftPdfAddCameraPhoto(file));
      queuedPhotos = [];
      closeCamera();
      return;
    }
    if (queuedPhotos.length) {
      showReview(queuedPhotos.shift());
      return;
    }
    review.hidden = true;
    stage.hidden = false;
    cameraActions.hidden = false;
    captureButton.disabled = !stream;
    status.textContent = "Photo added. Take another photo or close the camera.";
    captureButton.focus();
  }

  function retakePhoto() {
    clearReview();
    if (stream) {
      review.hidden = true;
      stage.hidden = false;
      cameraActions.hidden = false;
      captureButton.disabled = false;
      status.textContent = "Ready when you are. Take another photo.";
      captureButton.focus();
    } else if (queuedPhotos.length) {
      showReview(queuedPhotos.shift());
    } else {
      review.hidden = true;
      stage.hidden = false;
      cameraActions.hidden = false;
      captureButton.disabled = true;
      status.textContent = "Choose Camera / photo picker to select another image.";
    }
  }

  document.getElementById("cameraBtn").addEventListener("click", openCamera);
  document.getElementById("wsCameraCard").addEventListener("click", openCamera);
  document.getElementById("cameraClose").addEventListener("click", closeCamera);
  captureButton.addEventListener("click", capturePhoto);
  fallbackButton.addEventListener("click", () => input.click());
  document.getElementById("cameraCrop").addEventListener("click", cropPhoto);
  document.getElementById("cameraRotate").addEventListener("click", rotatePhoto);
  document.getElementById("cameraRetake").addEventListener("click", retakePhoto);
  document.getElementById("cameraUseContinue").addEventListener("click", () => addCurrentPhoto(false));
  document.getElementById("cameraUseClose").addEventListener("click", () => addCurrentPhoto(true));
  switchButton.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    stopCamera();
    await startCamera();
  });
  input.addEventListener("change", () => {
    queuedPhotos = [...input.files || []];
    input.value = "";
    if (queuedPhotos.length) showReview(queuedPhotos.shift());
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && event.target === overlay) closeCamera();
  });
  document.addEventListener("keydown", (event) => {
    const cropIsOpen = document.getElementById("cropOverlay") && !document.getElementById("cropOverlay").hidden;
    if (event.key === "Escape" && !overlay.hidden && !cropIsOpen) closeCamera();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !overlay.hidden) stopCamera();
  });
  window.swiftPdfOpenCamera = openCamera;
})();
