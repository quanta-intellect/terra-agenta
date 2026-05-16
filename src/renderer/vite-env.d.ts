/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAP_TILES_API_KEY?: string;
  readonly VITE_GOOGLE_MAPS_TILES_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
