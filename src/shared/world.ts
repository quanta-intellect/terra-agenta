export type WorldMode = "globe";

export interface CameraState {
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface CaptureRecord {
  id: string;
  label: string;
  createdAt: string;
  camera: CameraState;
  dataUrl: string;
}

export interface WorldState {
  mode: WorldMode;
  camera: CameraState;
  activeTileset: "cesium-world" | "google-photorealistic";
  lastCapture?: CaptureRecord;
}
