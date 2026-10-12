import { createEffect, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { syncFaces, syncLines } from "replicad-threejs-helper";
import type { MeshedShape } from "../kernel/protocol.ts";

/** Reads a theme colour that the stylesheet derived for this tool. */
function themeColor(element: Element, name: string): THREE.Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  const color = new THREE.Color();
  // three.js parses rgb()/hex, not color-mix(); the canvas normalises any CSS colour.
  const context = document.createElement("canvas").getContext("2d");
  if (context && value) {
    context.fillStyle = value;
    color.setStyle(context.fillStyle);
  }
  return color;
}

export function Viewer(props: { shapes: MeshedShape[] | undefined }) {
  let container!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -120, 90);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const controls = new OrbitControls(camera, renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(1, -1, 2);
    scene.add(light);

    const faceMaterial = new THREE.MeshStandardMaterial({
      color: themeColor(container, "--cad-model-shape"),
      roughness: 0.6,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 1,
    });
    const lineMaterial = new THREE.LineBasicMaterial({ color: themeColor(container, "--cad-model-edge") });
    const group = new THREE.Group();
    scene.add(group);

    let framed = false;
    const frame = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const direction = new THREE.Vector3(0.55, -0.85, 0.65).normalize();
      camera.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 3);
      camera.near = sphere.radius / 100;
      camera.far = sphere.radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      framed = true;
    };

    const resize = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frameId = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(tick);
    };
    tick();

    createEffect(() => {
      const shapes = props.shapes;
      if (!shapes) return;
      for (const child of [...group.children]) {
        group.remove(child);
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose();
      }
      let vertices = 0;
      for (const shape of shapes) {
        const faces = new THREE.BufferGeometry();
        syncFaces(faces, shape.faces);
        group.add(new THREE.Mesh(faces, faceMaterial));
        vertices += shape.faces.vertices.length / 3;
        if (shape.edges) {
          const lines = new THREE.BufferGeometry();
          syncLines(lines, shape.edges);
          group.add(new THREE.LineSegments(lines, lineMaterial));
        }
      }
      container.dataset["vertices"] = String(vertices);
      if (!framed) frame();
    });

    onCleanup(() => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      for (const child of group.children) if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose();
      faceMaterial.dispose();
      lineMaterial.dispose();
      renderer.dispose();
    });
  });

  return (
    <div class="cad-model__viewer" ref={container}>
      <canvas ref={canvas} />
    </div>
  );
}
