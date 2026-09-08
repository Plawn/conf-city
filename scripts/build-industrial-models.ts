/** Generate the project-owned low-poly industrial GLBs; no external asset or texture required. */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  type IndustrialStyle,
  industrialGeometry,
} from "../src/components/buildings/industrialGeometry";

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
for (const style of styles) {
  const geometry = industrialGeometry(style);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = style;
  const result = await new GLTFExporter().parseAsync(mesh, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("Expected a binary GLB");
  }
  await Bun.write(`public/models/industrial-${style}.glb`, result);
  console.log(style, result.byteLength);
  geometry.dispose();
  material.dispose();
}
