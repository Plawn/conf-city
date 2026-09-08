declare module "*.css" {}

interface ImportMetaEnv {
  readonly VITE_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
