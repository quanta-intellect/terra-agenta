import { Camera, CameraIcon, Crosshair, Gauge, Globe2, Image, LocateFixed, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  HeadingPitchRoll,
  Matrix4,
  Math as CesiumMath,
  UrlTemplateImageryProvider,
  Viewer,
  createGooglePhotorealistic3DTileset
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { CameraState, CaptureRecord, WorldState } from "../shared/world";

const googleTilesKey =
  import.meta.env.VITE_GOOGLE_MAP_TILES_API_KEY ?? import.meta.env.VITE_GOOGLE_MAPS_TILES_API_KEY;
const googleTilesUrl = googleTilesKey
  ? `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleTilesKey}`
  : null;

const presets = [
  {
    name: "Portland",
    description: "Industrial waterfront",
    camera: { lat: 45.5152, lon: -122.6784, altitude: 4200, heading: 58, pitch: -36, roll: 0 }
  },
  {
    name: "Mount Hood",
    description: "Terrain check",
    camera: { lat: 45.3736, lon: -121.6959, altitude: 10500, heading: 72, pitch: -42, roll: 0 }
  },
  {
    name: "Lower Manhattan",
    description: "Dense 3D city test",
    camera: { lat: 40.7069, lon: -74.0113, altitude: 2600, heading: 28, pitch: -32, roll: 0 }
  }
] satisfies Array<{ name: string; description: string; camera: CameraState }>;

const initialCamera: CameraState = presets[0].camera;
type QualityMode = "fast" | "balanced" | "sharp";
type LayerMode = "base" | "hybrid";
interface CameraLock {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
}

interface CameraDiagnostics {
  lock: "off" | "on";
  driftMeters: number;
  renderLoop: "running" | "settling" | "frozen";
}

interface GoogleTilesDiagnostics {
  status: "idle" | "preflight" | "ready" | "loading-view" | "visible" | "fallback" | "failed";
  pendingRequests: number;
  processingTiles: number;
  visibleTiles: number;
  failedTiles: number;
  lastEvent: string;
  lastError: string | null;
  elapsedMs: number;
}

const qualitySettings: Record<
  QualityMode,
  {
    label: string;
    maximumScreenSpaceError: number;
    dynamicScreenSpaceErrorFactor: number;
    resolutionScale: number;
  }
> = {
  fast: {
    label: "Fast",
    maximumScreenSpaceError: 32,
    dynamicScreenSpaceErrorFactor: 36,
    resolutionScale: 0.82
  },
  balanced: {
    label: "Balanced",
    maximumScreenSpaceError: 22,
    dynamicScreenSpaceErrorFactor: 28,
    resolutionScale: 0.92
  },
  sharp: {
    label: "Sharp",
    maximumScreenSpaceError: 14,
    dynamicScreenSpaceErrorFactor: 20,
    resolutionScale: 1
  }
};

const initialGoogleDiagnostics: GoogleTilesDiagnostics = {
  status: "idle",
  pendingRequests: 0,
  processingTiles: 0,
  visibleTiles: 0,
  failedTiles: 0,
  lastEvent: "Waiting for Google 3D",
  lastError: null,
  elapsedMs: 0
};

function forceRender(viewer: Viewer) {
  viewer.scene.requestRender();
  viewer.render();
}

function resumeRenderLoop(viewer: Viewer) {
  viewer.scene.requestRenderMode = false;
  viewer.useDefaultRenderLoop = true;
  viewer.targetFrameRate = 45;
  viewer.scene.requestRender();
}

function freezeRenderLoop(viewer: Viewer) {
  forceRender(viewer);
  viewer.useDefaultRenderLoop = false;
}

function renderLockedFrame(viewer: Viewer, snapshot: CameraLock) {
  restoreCameraSnapshot(viewer, snapshot);
  viewer.render();
  restoreCameraSnapshot(viewer, snapshot);
}

function cameraFromViewer(viewer: Viewer): CameraState {
  const cartographic = Cartographic.fromCartesian(viewer.camera.positionWC);
  return {
    lat: Number(CesiumMath.toDegrees(cartographic.latitude).toFixed(6)),
    lon: Number(CesiumMath.toDegrees(cartographic.longitude).toFixed(6)),
    altitude: Math.round(cartographic.height),
    heading: Number(CesiumMath.toDegrees(viewer.camera.heading).toFixed(1)),
    pitch: Number(CesiumMath.toDegrees(viewer.camera.pitch).toFixed(1)),
    roll: Number(CesiumMath.toDegrees(viewer.camera.roll).toFixed(1))
  };
}

function setCamera(viewer: Viewer, camera: CameraState, fly = true) {
  resumeRenderLoop(viewer);
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  viewer.camera.cancelFlight();
  const target = Cartesian3.fromDegrees(camera.lon, camera.lat, 0);
  const range = Math.max(camera.altitude, 500);
  const offset = new HeadingPitchRange(
    CesiumMath.toRadians(camera.heading),
    CesiumMath.toRadians(camera.pitch),
    range
  );

  if (fly) {
    viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
      offset,
      duration: 0.75,
      complete: () => {
        viewer.camera.lookAtTransform(Matrix4.IDENTITY);
        stopCamera(viewer);
        forceRender(viewer);
      },
      cancel: () => forceRender(viewer)
    });
    viewer.scene.requestRender();
    return;
  }

  viewer.camera.lookAt(target, offset);
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  forceRender(viewer);
}

function tuneCameraControls(viewer: Viewer) {
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableCollisionDetection = false;
  controller.inertiaSpin = 0.08;
  controller.inertiaTranslate = 0.08;
  controller.inertiaZoom = 0.18;
  controller.maximumMovementRatio = 0.28;
  controller.zoomFactor = 7;
  controller.minimumZoomDistance = 35;
}

function stopCamera(viewer: Viewer) {
  viewer.camera.cancelFlight();
  tuneCameraControls(viewer);
  viewer.clock.shouldAnimate = false;
  viewer.clock.canAnimate = false;
}

function setGoogleTilesFrozen(tileset: Cesium3DTileset | null, frozen: boolean) {
  if (tileset) {
    tileset.debugFreezeFrame = frozen;
  }
}

function applyLayerMode(
  viewer: Viewer,
  tileset: Cesium3DTileset | null,
  mode: LayerMode,
  showBaseFallback = false
) {
  const useGoogle3D = mode === "hybrid" && Boolean(tileset);
  viewer.scene.globe.show = !useGoogle3D || showBaseFallback;

  if (tileset) {
    tileset.show = useGoogle3D;
  }

  forceRender(viewer);
}

function lockCameraAtCurrentView(viewer: Viewer) {
  stopCamera(viewer);
  viewer.camera.setView({
    destination: Cartesian3.clone(viewer.camera.positionWC),
    orientation: new HeadingPitchRoll(viewer.camera.heading, viewer.camera.pitch, viewer.camera.roll)
  });
  viewer.scene.requestRender();
}

function snapshotCamera(viewer: Viewer): CameraLock {
  return {
    position: Cartesian3.clone(viewer.camera.positionWC),
    direction: Cartesian3.clone(viewer.camera.directionWC),
    up: Cartesian3.clone(viewer.camera.upWC)
  };
}

function restoreCameraSnapshot(viewer: Viewer, snapshot: CameraLock) {
  viewer.camera.setView({
    destination: snapshot.position,
    orientation: {
      direction: snapshot.direction,
      up: snapshot.up
    }
  });
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}

function applyQualityMode(viewer: Viewer, tileset: Cesium3DTileset | null, mode: QualityMode) {
  const settings = qualitySettings[mode];
  viewer.resolutionScale = settings.resolutionScale;

  if (tileset) {
    tileset.maximumScreenSpaceError = settings.maximumScreenSpaceError;
    tileset.dynamicScreenSpaceError = false;
    tileset.foveatedScreenSpaceError = true;
    tileset.foveatedConeSize = 0.35;
    tileset.foveatedTimeDelay = 0;
    tileset.skipLevelOfDetail = true;
    tileset.immediatelyLoadDesiredLevelOfDetail = false;
    tileset.loadSiblings = true;
    tileset.progressiveResolutionHeightFraction = 0.3;
    tileset.cullRequestsWhileMoving = false;
    tileset.dynamicScreenSpaceErrorDensity = 0.0002;
    tileset.dynamicScreenSpaceErrorFactor = settings.dynamicScreenSpaceErrorFactor;
  }
}

function formatLoadError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Cesium load error";
  }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const googleTilesetRef = useRef<Cesium3DTileset | null>(null);
  const googleTilesVisibleRef = useRef(false);
  const currentViewHasGoogleTilesRef = useRef(false);
  const googleFallbackTimerRef = useRef<number | null>(null);
  const googleLoadStartedAtRef = useRef<number | null>(null);
  const lastGoogleProgressLogRef = useRef(0);
  const layerModeRef = useRef<LayerMode>("base");
  const cameraLockRef = useRef<CameraLock | null>(null);
  const lockedRenderTimerRef = useRef<number | null>(null);
  const cameraDriftRef = useRef(0);
  const [camera, setCameraState] = useState<CameraState>(initialCamera);
  const [cameraDiagnostics, setCameraDiagnostics] = useState<CameraDiagnostics>({
    lock: "off",
    driftMeters: 0,
    renderLoop: "running"
  });
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [qualityMode, setQualityMode] = useState<QualityMode>("fast");
  const [layerMode, setLayerMode] = useState<LayerMode>("base");
  const [isGoogleTilesActive, setIsGoogleTilesActive] = useState(false);
  const [googleDiagnostics, setGoogleDiagnostics] = useState<GoogleTilesDiagnostics>(initialGoogleDiagnostics);
  const [status, setStatus] = useState("Booting globe");
  const [error, setError] = useState<string | null>(null);

  const unlockCamera = useCallback(() => {
    const viewer = viewerRef.current;
    if (lockedRenderTimerRef.current) {
      window.clearInterval(lockedRenderTimerRef.current);
      lockedRenderTimerRef.current = null;
    }
    cameraLockRef.current = null;
    cameraDriftRef.current = 0;
    setGoogleTilesFrozen(googleTilesetRef.current, false);
    setCameraDiagnostics({ lock: "off", driftMeters: 0, renderLoop: "running" });
    if (viewer) {
      resumeRenderLoop(viewer);
      viewer.scene.screenSpaceCameraController.enableInputs = true;
      tuneCameraControls(viewer);
      forceRender(viewer);
    }
  }, []);

  const clearGoogleFallbackTimer = useCallback(() => {
    if (googleFallbackTimerRef.current) {
      window.clearTimeout(googleFallbackTimerRef.current);
      googleFallbackTimerRef.current = null;
    }
  }, []);

  const updateGoogleDiagnostics = useCallback(
    (event: string, update: Partial<GoogleTilesDiagnostics>, level: "debug" | "info" | "warn" | "error" = "info") => {
      const elapsedMs = googleLoadStartedAtRef.current ? Math.round(performance.now() - googleLoadStartedAtRef.current) : 0;
      const nextUpdate = { ...update, lastEvent: event, elapsedMs };
      setGoogleDiagnostics((current) => ({ ...current, ...nextUpdate }));
      console[level]("[Terra Google 3D]", event, nextUpdate);
    },
    []
  );

  const scheduleGoogleFallback = useCallback(() => {
    const viewer = viewerRef.current;
    const tileset = googleTilesetRef.current;
    clearGoogleFallbackTimer();
    if (!viewer || !tileset || layerModeRef.current !== "hybrid") {
      return;
    }

    googleFallbackTimerRef.current = window.setTimeout(() => {
      googleFallbackTimerRef.current = null;
      if (layerModeRef.current === "hybrid" && !currentViewHasGoogleTilesRef.current) {
        applyLayerMode(viewer, tileset, "hybrid", true);
        updateGoogleDiagnostics("fallback timeout", { status: "fallback" }, "warn");
        setStatus("Still loading Google 3D; showing base fallback");
      }
    }, 8000);
  }, [clearGoogleFallbackTimer, updateGoogleDiagnostics]);

  const worldState = useMemo<WorldState>(
    () => ({
      mode: "globe",
      camera,
      activeTileset: isGoogleTilesActive && layerMode === "hybrid" ? "google-photorealistic" : "cesium-world",
      lastCapture: captures[0]
    }),
    [camera, captures, isGoogleTilesActive, layerMode]
  );

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) {
      return;
    }

    const viewer = new Viewer(containerRef.current, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      skyBox: false,
      skyAtmosphere: false,
      shouldAnimate: false,
      requestRenderMode: false,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: true,
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true
        }
      },
      targetFrameRate: 45
    });

    viewerRef.current = viewer;
    stopCamera(viewer);
    viewer.scene.backgroundColor = Color.fromCssColorString("#0b0f12");
    viewer.scene.sun = undefined;
    viewer.scene.moon = undefined;
    viewer.scene.sunBloom = false;
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        credit: "OpenStreetMap contributors",
        maximumLevel: 19
      })
    );
    viewer.scene.globe.baseColor = Color.fromCssColorString("#0f1518");
    applyQualityMode(viewer, null, qualityMode);
    viewer.scene.debugShowFramesPerSecond = false;
    setCamera(viewer, initialCamera, false);
    setCameraState(cameraFromViewer(viewer));
    setStatus("Ready");

    const removeCameraListener = viewer.camera.changed.addEventListener(() => {
      setCameraState(cameraFromViewer(viewer));
    });
    let wheelRenderTimer: number | undefined;
    const clearLockedRenderTimer = () => {
      if (lockedRenderTimerRef.current) {
        window.clearInterval(lockedRenderTimerRef.current);
        lockedRenderTimerRef.current = null;
      }
    };
    const beginInteractiveCameraMotion = () => {
      clearLockedRenderTimer();
      cameraLockRef.current = null;
      cameraDriftRef.current = 0;
      setGoogleTilesFrozen(googleTilesetRef.current, false);
      resumeRenderLoop(viewer);
      viewer.scene.screenSpaceCameraController.enableInputs = true;
      if (layerModeRef.current === "hybrid") {
        currentViewHasGoogleTilesRef.current = false;
        applyLayerMode(viewer, googleTilesetRef.current, "hybrid");
        updateGoogleDiagnostics("camera moved in Google 3D", { status: "loading-view", visibleTiles: 0 }, "debug");
        scheduleGoogleFallback();
      }
      setCameraDiagnostics({ lock: "off", driftMeters: 0, renderLoop: "running" });
    };
    const beginActiveMotion = () => {
      beginInteractiveCameraMotion();
    };
    const finishActiveMotion = () => {
      forceRender(viewer);
    };
    const scheduleWheelRender = () => {
      beginInteractiveCameraMotion();
      if (wheelRenderTimer) {
        window.clearTimeout(wheelRenderTimer);
      }
      wheelRenderTimer = window.setTimeout(() => {
        forceRender(viewer);
        wheelRenderTimer = undefined;
      }, 240);
    };
    const enforceCameraLock = () => {
      if (cameraLockRef.current) {
        cameraDriftRef.current = Math.max(
          cameraDriftRef.current,
          Cartesian3.distance(viewer.camera.positionWC, cameraLockRef.current.position)
        );
        restoreCameraSnapshot(viewer, cameraLockRef.current);
      }
    };
    const removeMoveEndListener = viewer.camera.moveEnd.addEventListener(finishActiveMotion);
    const removePreUpdateListener = viewer.scene.preUpdate.addEventListener(enforceCameraLock);
    const removePostUpdateListener = viewer.scene.postUpdate.addEventListener(enforceCameraLock);
    const removePreRenderListener = viewer.scene.preRender.addEventListener(enforceCameraLock);
    const removePostRenderListener = viewer.scene.postRender.addEventListener(enforceCameraLock);
    const diagnosticsTimer = window.setInterval(() => {
      setCameraDiagnostics({
        lock: cameraLockRef.current ? "on" : "off",
        driftMeters: Number(cameraDriftRef.current.toFixed(3)),
        renderLoop: viewer.useDefaultRenderLoop ? "running" : "frozen"
      });
    }, 500);
    viewer.canvas.addEventListener("pointerdown", beginActiveMotion);
    viewer.canvas.addEventListener("pointerup", finishActiveMotion);
    viewer.canvas.addEventListener("pointercancel", finishActiveMotion);
    viewer.canvas.addEventListener("pointerleave", finishActiveMotion);
    viewer.canvas.addEventListener("wheel", scheduleWheelRender, { passive: true });
    viewer.canvas.addEventListener("keydown", beginActiveMotion);
    viewer.canvas.addEventListener("keyup", finishActiveMotion);
    window.addEventListener("mouseup", finishActiveMotion);
    window.addEventListener("blur", finishActiveMotion);

    if (googleTilesUrl) {
      googleLoadStartedAtRef.current = performance.now();
      updateGoogleDiagnostics("preflight started", {
        status: "preflight",
        pendingRequests: 0,
        processingTiles: 0,
        visibleTiles: 0,
        failedTiles: 0,
        lastError: null
      });
      setStatus("Loading Google 3D Tiles");
      fetch(googleTilesUrl)
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.text();
            throw new Error(`Google preflight failed (${response.status}): ${body.slice(0, 240)}`);
          }
          updateGoogleDiagnostics("preflight ok", { status: "ready" });
        })
        .catch((preflightError: unknown) => {
          const message = formatLoadError(preflightError);
          console.error(preflightError);
          updateGoogleDiagnostics("preflight failed", { status: "failed", lastError: message }, "error");
          setError(`Google 3D Tiles preflight failed: ${message}`);
        });

      createGooglePhotorealistic3DTileset(
        {
          key: googleTilesKey,
          onlyUsingWithGoogleGeocoder: true
        },
        {
          maximumScreenSpaceError: qualitySettings[qualityMode].maximumScreenSpaceError,
          dynamicScreenSpaceError: false,
          dynamicScreenSpaceErrorDensity: 0.0002,
          dynamicScreenSpaceErrorFactor: qualitySettings[qualityMode].dynamicScreenSpaceErrorFactor,
          foveatedScreenSpaceError: true,
          foveatedConeSize: 0.35,
          foveatedTimeDelay: 0,
          skipLevelOfDetail: true,
          immediatelyLoadDesiredLevelOfDetail: false,
          loadSiblings: true,
          progressiveResolutionHeightFraction: 0.3,
          cullRequestsWhileMoving: false,
          enableCollision: false
        }
      )
        .then((tileset) => {
          updateGoogleDiagnostics("tileset ready", { status: "ready" });
          tileset.showCreditsOnScreen = true;
          googleTilesetRef.current = tileset;
          viewer.scene.primitives.add(tileset);
          tileset.tileVisible.addEventListener(() => {
            if (currentViewHasGoogleTilesRef.current) {
              return;
            }
            clearGoogleFallbackTimer();
            googleTilesVisibleRef.current = true;
            currentViewHasGoogleTilesRef.current = true;
            updateGoogleDiagnostics("tile visible", { status: "visible", visibleTiles: 1 });
            applyLayerMode(viewer, tileset, layerModeRef.current);
            setStatus(layerModeRef.current === "hybrid" ? "Google 3D layer visible" : "Google 3D Tiles ready");
          });
          tileset.tileFailed.addEventListener((tileError: unknown) => {
            const message = formatLoadError(tileError);
            console.error(tileError);
            const elapsedMs = googleLoadStartedAtRef.current ? Math.round(performance.now() - googleLoadStartedAtRef.current) : 0;
            setGoogleDiagnostics((current) => ({
              ...current,
              status: "failed",
              failedTiles: current.failedTiles + 1,
              lastEvent: "tile failed",
              lastError: message,
              elapsedMs
            }));
            console.error("[Terra Google 3D]", "tile failed", { message, elapsedMs });
            if (layerModeRef.current === "hybrid") {
              applyLayerMode(viewer, tileset, "hybrid", true);
              setError(`Google 3D tile failed: ${message}`);
              setStatus("Google 3D failed for this view; showing base fallback");
            }
          });
          tileset.loadProgress.addEventListener((pendingRequests: number, processingTiles: number) => {
            const now = performance.now();
            setGoogleDiagnostics((current) => ({
              ...current,
              pendingRequests,
              processingTiles,
              lastEvent: "load progress",
              elapsedMs: googleLoadStartedAtRef.current ? Math.round(now - googleLoadStartedAtRef.current) : 0
            }));
            if (now - lastGoogleProgressLogRef.current > 1000) {
              lastGoogleProgressLogRef.current = now;
              console.debug("[Terra Google 3D]", "load progress", { pendingRequests, processingTiles });
            }
            viewer.scene.requestRender();
          });
          applyQualityMode(viewer, tileset, qualityMode);
          applyLayerMode(viewer, tileset, layerModeRef.current);
          setIsGoogleTilesActive(true);
          setStatus("Google 3D Tiles loaded; base layer active");
        })
        .catch((tilesError: unknown) => {
          const message = formatLoadError(tilesError);
          console.error(tilesError);
          viewer.scene.globe.show = true;
          updateGoogleDiagnostics("tileset failed", { status: "failed", lastError: message }, "error");
          setError(`Google 3D Tiles did not load: ${message}`);
          setStatus("Ready with base globe");
        });
    }

    return () => {
      removeCameraListener();
      removeMoveEndListener();
      removePreUpdateListener();
      removePostUpdateListener();
      removePreRenderListener();
      removePostRenderListener();
      window.clearInterval(diagnosticsTimer);
      clearGoogleFallbackTimer();
      if (wheelRenderTimer) {
        window.clearTimeout(wheelRenderTimer);
      }
      viewer.canvas.removeEventListener("pointerdown", beginActiveMotion);
      viewer.canvas.removeEventListener("pointerup", finishActiveMotion);
      viewer.canvas.removeEventListener("pointercancel", finishActiveMotion);
      viewer.canvas.removeEventListener("pointerleave", finishActiveMotion);
      viewer.canvas.removeEventListener("wheel", scheduleWheelRender);
      viewer.canvas.removeEventListener("keydown", beginActiveMotion);
      viewer.canvas.removeEventListener("keyup", finishActiveMotion);
      window.removeEventListener("mouseup", finishActiveMotion);
      window.removeEventListener("blur", finishActiveMotion);
      if (lockedRenderTimerRef.current) {
        window.clearInterval(lockedRenderTimerRef.current);
        lockedRenderTimerRef.current = null;
      }
      googleTilesetRef.current = null;
      googleTilesVisibleRef.current = false;
      currentViewHasGoogleTilesRef.current = false;
      cameraLockRef.current = null;
      cameraDriftRef.current = 0;
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  const handlePreset = useCallback((nextCamera: CameraState) => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }
    unlockCamera();
    setStatus("Flying");
    setCamera(viewer, nextCamera);
    window.setTimeout(() => setStatus("Ready"), 850);
  }, []);

  const handleQualityMode = useCallback((mode: QualityMode) => {
    const viewer = viewerRef.current;
    setQualityMode(mode);

    if (viewer) {
      applyQualityMode(viewer, googleTilesetRef.current, mode);
      forceRender(viewer);
      setStatus(`${qualitySettings[mode].label} navigation mode`);
    }
  }, []);

  const handleLayerMode = useCallback((mode: LayerMode) => {
    const viewer = viewerRef.current;
    layerModeRef.current = mode;
    setLayerMode(mode);
    setGoogleTilesFrozen(googleTilesetRef.current, false);
    setError(null);

    if (viewer) {
      if (mode === "hybrid") {
        currentViewHasGoogleTilesRef.current = false;
        applyLayerMode(viewer, googleTilesetRef.current, mode);
        scheduleGoogleFallback();
      } else {
        clearGoogleFallbackTimer();
        applyLayerMode(viewer, googleTilesetRef.current, mode);
      }
      setStatus(
        mode === "hybrid"
          ? "Loading photorealistic Google 3D"
          : "Base globe only"
      );
    }
  }, [clearGoogleFallbackTimer, scheduleGoogleFallback]);

  const handleFreezeGoogleTiles = useCallback(() => {
    const viewer = viewerRef.current;
    const tileset = googleTilesetRef.current;
    if (!viewer || !tileset) {
      return;
    }

    tileset.debugFreezeFrame = !tileset.debugFreezeFrame;
    forceRender(viewer);
    setStatus(tileset.debugFreezeFrame ? "Google 3D tiles frozen" : "Google 3D tiles streaming");
  }, []);

  const captureScreenshot = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    viewer.render();
    const dataUrl = viewer.scene.canvas.toDataURL("image/png");
    const capture: CaptureRecord = {
      id: crypto.randomUUID(),
      label: `Capture ${captures.length + 1}`,
      createdAt: new Date().toISOString(),
      camera: cameraFromViewer(viewer),
      dataUrl
    };
    setCaptures((current) => [capture, ...current].slice(0, 6));
    setStatus("Captured current view");
  }, [captures.length]);

  const toggleBaseGlobe = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    unlockCamera();
    viewer.scene.globe.show = !viewer.scene.globe.show;
    forceRender(viewer);
    setStatus(viewer.scene.globe.show ? "Base globe visible" : "Base globe hidden");
  }, []);

  const resetCamera = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    unlockCamera();
    tuneCameraControls(viewer);
    applyLayerMode(viewer, googleTilesetRef.current, layerMode);
    setCamera(viewer, initialCamera, false);
    setCameraState(cameraFromViewer(viewer));
    setStatus("Camera reset to Portland");
  }, [layerMode]);

  const handleStopCamera = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    lockCameraAtCurrentView(viewer);
    const snapshot = snapshotCamera(viewer);
    cameraLockRef.current = snapshot;
    cameraDriftRef.current = 0;
    setGoogleTilesFrozen(googleTilesetRef.current, false);
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    freezeRenderLoop(viewer);
    if (lockedRenderTimerRef.current) {
      window.clearInterval(lockedRenderTimerRef.current);
    }
    lockedRenderTimerRef.current = window.setInterval(() => {
      renderLockedFrame(viewer, snapshot);
    }, 350);
    setCameraState(cameraFromViewer(viewer));
    renderLockedFrame(viewer, snapshot);
    setCameraDiagnostics({ lock: "on", driftMeters: 0, renderLoop: "settling" });
    setStatus("Camera locked; tiles refining in pulses");
  }, []);

  return (
    <main className="app-shell">
      <section className="globe-stage" aria-label="Interactive globe">
        <div ref={containerRef} className="cesium-host" />
      </section>

      <aside className="control-panel" aria-label="Terra Agenta controls">
        <header className="brand-block">
          <div className="brand-mark">
            <Globe2 size={20} aria-hidden="true" />
          </div>
          <div>
            <h1>Terra Agenta</h1>
            <p>Phase 0 globe spike</p>
          </div>
        </header>

        <section className="panel-section">
          <div className="section-heading">
            <LocateFixed size={16} aria-hidden="true" />
            <h2>Camera Presets</h2>
          </div>
          <div className="preset-list">
            {presets.map((preset) => (
              <button key={preset.name} className="preset-button" onClick={() => handlePreset(preset.camera)}>
                <span>{preset.name}</span>
                <small>{preset.description}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <Gauge size={16} aria-hidden="true" />
            <h2>Navigation</h2>
          </div>
          <div className="segmented-control" aria-label="Navigation quality">
            {(Object.keys(qualitySettings) as QualityMode[]).map((mode) => (
              <button
                key={mode}
                className={mode === qualityMode ? "segment-button active" : "segment-button"}
                onClick={() => handleQualityMode(mode)}
              >
                {qualitySettings[mode].label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <Globe2 size={16} aria-hidden="true" />
            <h2>Layers</h2>
          </div>
          <div className="segmented-control two-up" aria-label="Visible layers">
            <button
              className={layerMode === "base" ? "segment-button active" : "segment-button"}
              onClick={() => handleLayerMode("base")}
            >
              Base
            </button>
            <button
              className={layerMode === "hybrid" ? "segment-button active" : "segment-button"}
              onClick={() => handleLayerMode("hybrid")}
              disabled={!isGoogleTilesActive}
            >
              Google 3D
            </button>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <Crosshair size={16} aria-hidden="true" />
            <h2>World State</h2>
          </div>
          <dl className="state-grid">
            <div>
              <dt>Lat</dt>
              <dd>{worldState.camera.lat}</dd>
            </div>
            <div>
              <dt>Lon</dt>
              <dd>{worldState.camera.lon}</dd>
            </div>
            <div>
              <dt>Alt</dt>
              <dd>{worldState.camera.altitude.toLocaleString()} m</dd>
            </div>
            <div>
              <dt>Heading</dt>
              <dd>{worldState.camera.heading} deg</dd>
            </div>
            <div>
              <dt>Pitch</dt>
              <dd>{worldState.camera.pitch} deg</dd>
            </div>
            <div>
              <dt>Layer</dt>
              <dd>{worldState.activeTileset === "google-photorealistic" ? "Google 3D" : "Base globe"}</dd>
            </div>
            <div>
              <dt>Lock</dt>
              <dd>{cameraDiagnostics.lock}</dd>
            </div>
            <div>
              <dt>Drift</dt>
              <dd>{cameraDiagnostics.driftMeters} m</dd>
            </div>
            <div>
              <dt>Render</dt>
              <dd>{cameraDiagnostics.renderLoop}</dd>
            </div>
            <div>
              <dt>Google</dt>
              <dd>{googleDiagnostics.status}</dd>
            </div>
            <div>
              <dt>G3D Queue</dt>
              <dd>
                {googleDiagnostics.pendingRequests}/{googleDiagnostics.processingTiles}
              </dd>
            </div>
            <div>
              <dt>G3D Visible</dt>
              <dd>{googleDiagnostics.visibleTiles}</dd>
            </div>
            <div>
              <dt>G3D Failed</dt>
              <dd>{googleDiagnostics.failedTiles}</dd>
            </div>
            <div>
              <dt>G3D Event</dt>
              <dd>{googleDiagnostics.lastEvent}</dd>
            </div>
            <div>
              <dt>G3D Time</dt>
              <dd>{googleDiagnostics.elapsedMs} ms</dd>
            </div>
          </dl>
          {googleDiagnostics.lastError ? <p className="error-line">{googleDiagnostics.lastError}</p> : null}
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <CameraIcon size={16} aria-hidden="true" />
            <h2>Capture</h2>
          </div>
          <button className="primary-action" onClick={captureScreenshot}>
            <Camera size={16} aria-hidden="true" />
            Capture current view
          </button>
          <button className="secondary-action" onClick={toggleBaseGlobe}>
            <Globe2 size={16} aria-hidden="true" />
            Toggle base globe
          </button>
          <button className="secondary-action" onClick={handleFreezeGoogleTiles} disabled={!isGoogleTilesActive}>
            <Square size={15} aria-hidden="true" />
            Freeze Google tiles
          </button>
          <button className="secondary-action" onClick={resetCamera}>
            <RotateCcw size={16} aria-hidden="true" />
            Reset camera
          </button>
          <button className="secondary-action" onClick={handleStopCamera}>
            <Square size={15} aria-hidden="true" />
            Stop camera
          </button>
          <p className="status-line">{status}</p>
          {error ? <p className="error-line">{error}</p> : null}
        </section>

        <section className="panel-section capture-section">
          <div className="section-heading">
            <Image size={16} aria-hidden="true" />
            <h2>Recent Captures</h2>
          </div>
          {captures.length === 0 ? (
            <p className="empty-state">No captures yet.</p>
          ) : (
            <div className="capture-list">
              {captures.map((capture) => (
                <article key={capture.id} className="capture-card">
                  <img src={capture.dataUrl} alt={capture.label} />
                  <div>
                    <strong>{capture.label}</strong>
                    <span>
                      {capture.camera.lat}, {capture.camera.lon}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </aside>
    </main>
  );
}
