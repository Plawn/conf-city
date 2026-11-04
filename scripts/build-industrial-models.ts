/** Generate the project-owned low-poly GLBs (industrial hangars + scenario building kinds); no texture. */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  type IndustrialStyle,
  industrialGeometry,
} from "../src/components/buildings/industrialGeometry";
import { kindGeometry } from "../src/components/buildings/kindGeometry";
import { KIND_STYLES } from "../src/domain/nodeStyle";

// GLTFExporter uses the browser FileReader API; Bun provides Blob.arrayBuffer instead.
class BlobReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString("base64")}`;
      this.onloadend?.();
    });
  }
}
Object.assign(globalThis, { FileReader: BlobReader });
const styles: IndustrialStyle[] = [
  "warehouse",
  "sheds",
  "datacenter",
  "depot",
  "cold-storage",
  "terminal",
  "containers",
];
const models: (readonly [string, () => THREE.BufferGeometry])[] = [
  ...styles.map((style) => [`industrial-${style}`, () => industrialGeometry(style)] as const),
  ...KIND_STYLES.map((style) => [`kind-${style}`, () => kindGeometry(style)] as const),
];
for (const [name, make] of models) {
  const geometry = make();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  const result = await new GLTFExporter().parseAsync(mesh, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("Expected a binary GLB");
  }
  await Bun.write(`public/models/${name}.glb`, result);
  console.log(name, result.byteLength);
  geometry.dispose();
  material.dispose();
}
