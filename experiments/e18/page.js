(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const version = $("probe-version");
  if (version !== null) version.textContent = "Probe v3 · script running";
  const fmt = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const context = $("context");
  context.textContent = [
    window.isSecureContext ? "secure context" : "NOT secure",
    "vibrate" in navigator ? "haptics API" : "no haptics API",
    "DeviceOrientationEvent" in window ? "orientation" : "no orientation",
    "DeviceMotionEvent" in window ? "motion" : "no motion",
  ].join(" · ");

  const motionStatus = $("motion-status");
  const enable = $("motion-enable");
  const alphaEl = $("alpha");
  const betaEl = $("beta");
  const gammaEl = $("gamma");
  const accelEl = $("accel");
  const rateEl = $("motion-rate");
  const dot = $("level-dot");

  let samples = 0;
  let rateStart = performance.now();
  let rateCount = 0;

  const setMotionStatus = (text, tone) => {
    motionStatus.textContent = text;
    if (tone) {
      motionStatus.dataset.tone = tone;
    } else {
      delete motionStatus.dataset.tone;
    }
  };

  const onOrientation = (event) => {
    alphaEl.textContent = fmt(event.alpha);
    betaEl.textContent = fmt(event.beta);
    gammaEl.textContent = fmt(event.gamma);
    const beta = Number.isFinite(event.beta) ? event.beta : 0;
    const gamma = Number.isFinite(event.gamma) ? event.gamma : 0;
    dot.style.transform = `translate(${clamp(gamma * 2, -64, 64)}px, ${clamp(beta * 2, -64, 64)}px)`;
    samples += 1;
    const now = performance.now();
    if (now - rateStart >= 500) {
      const hz = Math.round(((samples - rateCount) * 1000) / (now - rateStart));
      rateEl.textContent = `${hz} Hz`;
      rateStart = now;
      rateCount = samples;
    }
  };

  const onMotion = (event) => {
    const accel = event.accelerationIncludingGravity || event.acceleration;
    if (!accel) return;
    accelEl.textContent = `${fmt(accel.x)} / ${fmt(accel.y)} / ${fmt(accel.z)}`;
  };

  const startMotion = () => {
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("devicemotion", onMotion);
    setMotionStatus("Listening. Tilt the phone; beta and gamma should change.", "ok");
    enable.hidden = true;
  };

  const requestMotion = async () => {
    try {
      const motionCtor = window.DeviceMotionEvent;
      const orientationCtor = window.DeviceOrientationEvent;
      if (typeof motionCtor?.requestPermission === "function") {
        const result = await motionCtor.requestPermission();
        if (result !== "granted") {
          setMotionStatus("Motion permission denied.", "bad");
          return;
        }
      }
      if (typeof orientationCtor?.requestPermission === "function") {
        const result = await orientationCtor.requestPermission();
        if (result !== "granted") {
          setMotionStatus("Orientation permission denied.", "bad");
          return;
        }
      }
      startMotion();
    } catch (error) {
      setMotionStatus(`Motion failed: ${String(error)}`, "bad");
    }
  };

  if (!("DeviceOrientationEvent" in window) && !("DeviceMotionEvent" in window)) {
    setMotionStatus("No motion sensors exposed by this browser.", "bad");
  } else if (
    typeof window.DeviceOrientationEvent?.requestPermission === "function" ||
    typeof window.DeviceMotionEvent?.requestPermission === "function"
  ) {
    setMotionStatus("This browser requires permission for motion.");
    enable.hidden = false;
    enable.addEventListener("click", requestMotion);
  } else {
    startMotion();
  }

  const hapticsStatus = $("haptics-status");
  if (!("vibrate" in navigator)) {
    hapticsStatus.textContent = "Vibration API not supported (iOS Safari does not expose it).";
    hapticsStatus.dataset.tone = "bad";
  } else {
    hapticsStatus.textContent = "Vibration API available. Press a pattern.";
    hapticsStatus.dataset.tone = "ok";
    document.querySelectorAll("[data-pattern]").forEach((button) => {
      button.addEventListener("click", () => {
        const pattern = button.dataset.pattern.split(",").map(Number);
        const accepted = navigator.vibrate(pattern);
        hapticsStatus.textContent = accepted
          ? `Sent ${pattern.join("-")} ms`
          : "Vibration was blocked.";
        hapticsStatus.dataset.tone = accepted ? "ok" : "bad";
      });
    });
  }

  const pad = $("pad");
  const padDot = $("pad-dot");
  const touchStatus = $("touch-status");
  const active = new Map();

  const renderTouches = () => {
    touchStatus.textContent = `${active.size} touch${active.size === 1 ? "" : "es"}`;
  };

  const moveDot = (touch) => {
    const rect = pad.getBoundingClientRect();
    padDot.hidden = false;
    padDot.style.left = `${touch.clientX - rect.left}px`;
    padDot.style.top = `${touch.clientY - rect.top}px`;
  };

  pad.addEventListener(
    "touchstart",
    (event) => {
      for (const touch of event.changedTouches) active.set(touch.identifier, touch);
      if (event.touches[0]) moveDot(event.touches[0]);
      renderTouches();
    },
    { passive: true },
  );

  pad.addEventListener(
    "touchmove",
    (event) => {
      for (const touch of event.changedTouches) active.set(touch.identifier, touch);
      if (event.touches[0]) moveDot(event.touches[0]);
      renderTouches();
    },
    { passive: true },
  );

  const endTouch = (event) => {
    for (const touch of event.changedTouches) active.delete(touch.identifier);
    renderTouches();
  };

  pad.addEventListener("touchend", endTouch, { passive: true });
  pad.addEventListener("touchcancel", endTouch, { passive: true });
})();

