import { Camera, CameraIcon, Crosshair, Globe2, Image, LocateFixed, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRoll,
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
  viewer.camera.cancelFlight();
  const destination = Cartesian3.fromDegrees(camera.lon, camera.lat, camera.altitude);
  const orientation = new HeadingPitchRoll(
    CesiumMath.toRadians(camera.heading),
    CesiumMath.toRadians(camera.pitch),
    CesiumMath.toRadians(camera.roll)
  );

  if (fly) {
    viewer.camera.flyTo({ destination, orientation, duration: 1.35 });
    return;
  }

  viewer.camera.setView({ destination, orientation });
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
  const [camera, setCameraState] = useState<CameraState>(initialCamera);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [isGoogleTilesActive, setIsGoogleTilesActive] = useState(false);
  const [status, setStatus] = useState("Booting globe");
  const [error, setError] = useState<string | null>(null);

  const worldState = useMemo<WorldState>(
    () => ({
      mode: "globe",
      camera,
      activeTileset: isGoogleTilesActive ? "google-photorealistic" : "cesium-world",
      lastCapture: captures[0]
    }),
    [camera, captures, isGoogleTilesActive]
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
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true
        }
      }
    });

    viewerRef.current = viewer;
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        credit: "OpenStreetMap contributors",
        maximumLevel: 19
      })
    );
    viewer.scene.globe.baseColor = Color.fromCssColorString("#0f1518");
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = true;
    }
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    viewer.scene.debugShowFramesPerSecond = false;
    setCamera(viewer, initialCamera, false);
    setCameraState(cameraFromViewer(viewer));
    setStatus("Ready");

    const removeCameraListener = viewer.camera.changed.addEventListener(() => {
      setCameraState(cameraFromViewer(viewer));
    });

    if (googleTilesUrl) {
      setStatus("Loading Google 3D Tiles");
      fetch(googleTilesUrl)
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.text();
            throw new Error(`Google preflight failed (${response.status}): ${body.slice(0, 240)}`);
          }
        })
        .catch((preflightError: unknown) => {
          console.error(preflightError);
          setError(`Google 3D Tiles preflight failed: ${formatLoadError(preflightError)}`);
        });

      createGooglePhotorealistic3DTileset(
        {
          key: googleTilesKey,
          onlyUsingWithGoogleGeocoder: true
        },
        {
          maximumScreenSpaceError: 16,
          dynamicScreenSpaceError: true,
          enableCollision: false
        }
      )
        .then((tileset) => {
          tileset.showCreditsOnScreen = true;
          viewer.scene.primitives.add(tileset);
          setCamera(viewer, initialCamera, false);
          setIsGoogleTilesActive(true);
          setStatus("Google 3D Tiles active over base globe");
        })
        .catch((tilesError: unknown) => {
          console.error(tilesError);
          viewer.scene.globe.show = true;
          setError(`Google 3D Tiles did not load: ${formatLoadError(tilesError)}`);
          setStatus("Ready with base globe");
        });
    }

    return () => {
      removeCameraListener();
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  const handlePreset = useCallback((nextCamera: CameraState) => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }
    setStatus("Flying");
    setCamera(viewer, nextCamera);
    window.setTimeout(() => setStatus("Ready"), 1450);
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

    viewer.scene.globe.show = !viewer.scene.globe.show;
    setStatus(viewer.scene.globe.show ? "Base globe visible" : "Base globe hidden");
  }, []);

  const resetCamera = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      return;
    }

    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    viewer.scene.globe.show = true;
    setCamera(viewer, initialCamera, false);
    setCameraState(cameraFromViewer(viewer));
    setStatus("Camera reset to Portland");
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
          </dl>
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
          <button className="secondary-action" onClick={resetCamera}>
            <RotateCcw size={16} aria-hidden="true" />
            Reset camera
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
